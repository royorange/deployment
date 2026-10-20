import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSymlinks } from "./files.ts";
import { run, type Runner } from "./process.ts";
import { CliSupabase, supabaseEnvironment } from "./official.ts";

export async function migrationSession(
  root: string,
  ref: string,
  token: string | undefined,
  password: string,
  runner: Runner = run,
  auth?: { profile: string; identity: string },
  verifyResource?: () => Promise<void>,
) {
  if (!/^[a-z]{20}$/.test(ref)) throw new Error("Project Ref 格式无效。");
  const version = (
    await runner("supabase", ["--version"], { cwd: root })
  ).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (
    !match ||
    Number(match[1]) < 2 ||
    (Number(match[1]) === 2 && Number(match[2]) < 120)
  )
    throw new Error(
      "迁移需要 Supabase CLI >= 2.120.0（含 --skip-vault 与显式 --project-ref）；请从官方文档安装或升级。",
    );
  const source = join(root, "supabase/migrations");
  await noSymlinks(source);
  const entries = await readdir(source);
  if (
    entries.some(
      (file) =>
        file.endsWith(".sql") && !/^\d+_[A-Za-z0-9_.-]+\.sql$/.test(file),
    )
  )
    throw new Error("存在不符合官方命名规范的 SQL 迁移文件，请先修正。");
  const files = entries
    .filter((file) => /^\d+_[A-Za-z0-9_.-]+\.sql$/.test(file))
    .sort();
  if (!files.length || files.length > 500)
    throw new Error("迁移文件数量须在 1–500 之间。");
  if (new Set(files.map((file) => file.split("_")[0])).size !== files.length)
    throw new Error("存在重复迁移版本号。");
  const workdir = await mkdtemp(join(tmpdir(), "project-setup-migrations-"));
  const env = supabaseEnvironment(token);
  env.SUPABASE_DB_PASSWORD = password;
  const verify = async () => {
    if (verifyResource) await verifyResource();
    if (auth)
      await new CliSupabase(
        auth.profile,
        root,
        runner,
        auth.identity,
      ).identity();
  };
  const flags = auth ? ["--profile", auth.profile] : [];
  const close = async () => {
    delete env.SUPABASE_ACCESS_TOKEN;
    delete env.SUPABASE_DB_PASSWORD;
    await rm(workdir, { recursive: true, force: true });
  };
  try {
    await verify();
    // Fresh config avoids importing local config Vault secrets, seed settings or stale project links.
    await runner("supabase", ["init", "--yes", ...flags], {
      cwd: workdir,
      env,
    });
    await mkdir(join(workdir, "supabase/migrations"), {
      recursive: true,
      mode: 0o700,
    });
    let totalSize = 0;
    for (const file of files) {
      const path = join(source, file);
      await noSymlinks(path);
      const info = await stat(path);
      totalSize += info.size;
      if (!info.isFile() || totalSize > 20_000_000)
        throw new Error("迁移快照超过 20 MB 或包含非普通文件。");
      await writeFile(
        join(workdir, "supabase/migrations", file),
        await readFile(path),
        { mode: 0o600, flag: "wx" },
      );
    }
    await verify();
    await runner(
      "supabase",
      ["link", "--project-ref", ref, "--yes", ...flags],
      {
        cwd: workdir,
        env,
      },
    );
    let previewed = false;
    const push = async (dry: boolean) => {
      await verify();
      return runner(
        "supabase",
        [
          "db",
          "push",
          "--project-ref",
          ref,
          "--skip-vault",
          ...(dry ? ["--dry-run"] : []),
          "--yes",
          ...flags,
        ],
        { cwd: workdir, env, timeout: 300_000, captureStderr: true },
      );
    };
    return {
      files,
      preview: async () => {
        const output = await push(true);
        previewed = true;
        return files.filter((file) => output.includes(file));
      },
      apply: async () => {
        if (!previewed) throw new Error("必须先完成预演，再应用相同迁移快照。");
        previewed = false;
        await push(false);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
