import { spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = (await readdir(new URL("../test/", import.meta.url)))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `test/${name}`);
const coverage = process.argv.includes("--coverage");
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
    env: { ...process.env, TMPDIR: await realpath(tmpdir()) },
  },
);
child.on("error", () => {
  process.stderr.write("无法启动测试进程。\n");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
