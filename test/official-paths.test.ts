import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { wranglerRun } from "../src/official.ts";
import type { Runner } from "../src/process.ts";

test("a different target reuses launcher Wrangler, preferring target dependencies and retaining target cwd", async () => {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "setup-wrangler-path-")),
  );
  try {
    const target = join(temp, "zoncord");
    const launcher = join(temp, "fulcord");
    const bundled = join(
      launcher,
      "apps/web/node_modules/wrangler/bin/wrangler.js",
    );
    const preferred = join(target, "node_modules/wrangler/bin/wrangler.js");
    await mkdir(dirname(bundled), { recursive: true });
    await writeFile(bundled, "");
    let expected: string | undefined = bundled;
    const runner: Runner = async (command, args, options) => {
      assert.equal(options?.cwd, target);
      assert.equal(command, expected ? process.execPath : "wrangler");
      assert.deepEqual(args, expected ? [expected, "whoami"] : ["whoami"]);
      return "{}";
    };
    await wranglerRun(target, ["whoami"], runner, {}, launcher);
    await mkdir(dirname(preferred), { recursive: true });
    await writeFile(preferred, "");
    expected = preferred;
    await wranglerRun(target, ["whoami"], runner, {}, launcher);
    await rm(preferred);
    await rm(bundled);
    expected = undefined;
    await wranglerRun(target, ["whoami"], runner, {}, launcher);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
