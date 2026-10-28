import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { noSymlinks } from "./files.ts";
import { run, type Runner } from "./process.ts";
import { CliSupabase, supabaseEnvironment } from "./official.ts";

async function committedSnapshot(
  root: string,
  commit: string,
  runner: Runner,
): Promise<Map<string, Buffer>> {
  const output = await runner(
    "git",
    [
      "--no-replace-objects",
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      "--",
      "supabase/migrations",
    ],
    { cwd: root },
  );
  if (output && !output.endsWith("\0"))
    throw new Error("提交中的迁移文件树格式无效。");
  const snapshot = new Map<string, Buffer>();
  let totalSize = 0;
  for (const entry of output.split("\0").filter(Boolean)) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40})\t(supabase\/migrations\/[^\x00-\x1f\x7f]+)$/.exec(
        entry,
      );
    if (!match)
      throw new Error("提交中的迁移目录包含非普通文件或符号链接，已拒绝迁移。");
    const path = match[3]!;
    if (!path.endsWith(".sql")) continue;
    const file = path.slice("supabase/migrations/".length);
    if (!/^\d+_[A-Za-z0-9_.-]+\.sql$/.test(file) || snapshot.has(file))
      throw new Error("提交中的迁移文件名不符合官方规范。");
    const content = Buffer.from(
      await runner(
        "git",
        ["--no-replace-objects", "show", `${commit}:${path}`],
        { cwd: root },
      ),
      "utf8",
    );
    const object = createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex");
    if (object !== match[2])
      throw new Error(
        "迁移文件字节与目标提交不一致，无法冻结已通过 CI 的快照。",
      );
    totalSize += content.length;
    if (totalSize > 20_000_000) throw new Error("迁移快照超过 20 MB。");
    snapshot.set(file, content);
  }
  return snapshot;
}

export async function migrationSession(
  root: string,
  ref: string,
  token: string | undefined,
  password: string,
  runner: Runner = run,
  auth?: { profile: string; identity: string },
  verifyResource?: () => Promise<void>,
  expectedCommit?: string,
  beforeApply?: () => Promise<void>,
) {
  if (!/^[a-z]{20}$/.test(ref)) throw new Error("Project Ref 格式无效。");
  if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/.test(expectedCommit))
    throw new Error("迁移发布需要完整的 40 位 commit SHA。");
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
  const committed = expectedCommit
    ? await committedSnapshot(root, expectedCommit, runner)
    : undefined;
  if (!committed) await noSymlinks(source);
  const entries = committed ? [...committed.keys()] : await readdir(source);
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
  const workdir = await mkdtemp(
    join(await realpath(tmpdir()), "project-setup-migrations-"),
  );
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
      let content = committed?.get(file);
      if (!content) {
        await noSymlinks(path);
        const info = await stat(path);
        totalSize += info.size;
        if (!info.isFile() || totalSize > 20_000_000)
          throw new Error("迁移快照超过 20 MB 或包含非普通文件。");
        content = await readFile(path);
      }
      await writeFile(join(workdir, "supabase/migrations", file), content, {
        mode: 0o600,
        flag: "wx",
      });
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
    let upToDate = false;
    let applyStarted = false;
    const verifySnapshot = async () => {
      if (committed) {
        const directory = join(workdir, "supabase/migrations");
        await noSymlinks(directory);
        if (
          JSON.stringify((await readdir(directory)).sort()) !==
          JSON.stringify(files)
        )
          throw new Error("迁移快照文件清单已变化，已阻止数据库操作。");
        for (const file of files) {
          const path = join(directory, file);
          await noSymlinks(path);
          if (
            !(await stat(path)).isFile() ||
            !(await readFile(path)).equals(committed.get(file)!)
          )
            throw new Error("迁移快照字节已变化，已阻止数据库操作。");
        }
      }
    };
    const push = async (dry: boolean) => {
      await verify();
      await verifySnapshot();
      if (!dry) {
        await beforeApply?.();
        await verifySnapshot();
        applyStarted = true;
      }
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
      files: [...files],
      get upToDate() {
        return upToDate;
      },
      get applyStarted() {
        return applyStarted;
      },
      preview: async () => {
        previewed = false;
        upToDate = false;
        const output = await push(true);
        const pending = files.filter((file) => output.includes(file));
        upToDate =
          pending.length === 0 &&
          output
            .split(/\r?\n/)
            .some(
              (line) =>
                line === "Remote database is up to date." ||
                line === "Linked project is up to date.",
            );
        previewed = true;
        return pending;
      },
      apply: async () => {
        if (!previewed) throw new Error("必须先完成预演，再应用相同迁移快照。");
        applyStarted = false;
        previewed = false;
        upToDate = false;
        await push(false);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
