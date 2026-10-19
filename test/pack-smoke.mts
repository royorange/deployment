import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temp = await realpath(
  await mkdtemp(join(tmpdir(), "project-setup-package-test-")),
);
try {
  await writeFile(join(temp, "package.json"), '{"private":true}');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(root, `.artifacts/royorange-project-setup-${manifest.version}.tgz`),
    ],
    { cwd: temp, stdio: "pipe", timeout: 120_000 },
  );
  const installed = join(temp, "node_modules/@royorange/project-setup");
  const files = await readdir(installed);
  assert.ok(
    files.includes("dist") && !files.includes("src") && !files.includes("test"),
  );
  const help = execFileSync(
    process.execPath,
    [join(installed, "dist/cli.js"), "--help"],
    { cwd: temp, encoding: "utf8" },
  );
  assert.match(help, /project-setup/);
  assert.match(help, /--memory/);
  assert.match(help, /--vault/);
  assert.match(help, /默认加密保存各服务/);
  assert.match(help, /--no-vault/);
  assert.match(help, /无需指定 --root/);
  const { argumentsFor } = await import(
    pathToFileURL(join(installed, "dist/arguments.js")).href
  );
  const { openStorage } = await import(
    pathToFileURL(join(installed, "dist/storage.js")).href
  );
  const { prepareProject } = await import(
    pathToFileURL(join(installed, "dist/startup.js")).href
  );
  const projectRoot = join(temp, "zoncord");
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  const answers = ["current", "zoncord", "current"];
  const options = {
    cwd: projectRoot,
    home: temp,
    base: join(temp, "settings"),
    ui: {
      select: async (_message: string, choices: Array<{ value: string }>) => {
        const answer = answers.shift();
        assert.ok(choices.some((choice) => choice.value === answer));
        return answer!;
      },
      input: async () => {
        throw new Error("unexpected input");
      },
      log: () => {},
    },
  };
  const first = await prepareProject(options);
  assert.equal(first.config.repository, "royorange/zoncord");
  const restored = await prepareProject(options);
  assert.deepEqual(restored.config, first.config);
  assert.equal(answers.length, 0);
  const passphrase = "synthetic package test passphrase";
  const storageOptions = {
    base: options.base,
    root: projectRoot,
    config: first.config,
    mode: argumentsFor([]).mode,
    ui: {
      input: async (_message: string, inputOptions?: { secret?: boolean }) => {
        assert.equal(inputOptions?.secret, true);
        return passphrase;
      },
      confirm: async () => false,
      log: () => {},
    },
  };
  const storage = await openStorage(storageOptions);
  storage.data.credentials["supabase/package"] = "synthetic-package-pat";
  await storage.save();
  storage.close();
  const reopenedStorage = await openStorage(storageOptions);
  assert.equal(
    reopenedStorage.data.credentials["supabase/package"],
    "synthetic-package-pat",
  );
  reopenedStorage.close();
  assert.ok(
    !(
      await readFile(join(options.base, "project-setup/vault.json"), "utf8")
    ).includes("synthetic-package-pat"),
  );
  process.stdout.write(
    "独立安装包验证通过：仓库外安装、编译 JS 入口、帮助、内置 zoncord 模板、无参数恢复与默认加密凭据重开。\n",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
