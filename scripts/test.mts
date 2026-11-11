import { spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = (await readdir(new URL("../test/", import.meta.url)))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `test/${name}`);
const coverage = process.argv.includes("--coverage");
const temp = await realpath(tmpdir());
// Tool caches on the developer machine must not change lookup results.
const cache = await mkdtemp(join(temp, "project-setup-test-cache-"));
const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    ...(coverage
      ? [
          "--experimental-test-coverage",
          "--test-coverage-include=src/*.ts",
          "--test-coverage-lines=80",
        ]
      : []),
    "--test",
    ...tests,
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TMPDIR: temp, XDG_CACHE_HOME: cache },
  },
);
child.on("error", async () => {
  await rm(cache, { recursive: true, force: true });
  process.stderr.write("无法启动测试进程。\n");
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  await rm(cache, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
