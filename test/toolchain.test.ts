import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolchain, dependencyReport } from "../src/toolchain.ts";
import type { Runner } from "../src/process.ts";

const ui = { confirm: async () => false, log: () => {} };
test("API and other providers do not inspect or install the optional Supabase CLI", async () => {
  const commands: string[] = [];
  const tools = createToolchain({
    runner: async (command) => {
      commands.push(command);
      return "ok";
    },
    ui,
    inspect: async () => {
      throw new Error("unexpected inspection");
    },
    ensure: async () => {
      throw new Error("unexpected installation");
    },
  });
  assert.equal(await tools.runner("gh", ["api", "user"]), "ok");
  assert.deepEqual(commands, ["gh"]);
});
test("optional CLI operations resolve a checked cache and preserve arguments, cwd and secrets on stdin", async () => {
  const raw: Runner = async (command, args, options) => {
    assert.equal(command, "/checked/supabase");
    assert.deepEqual(args, ["whoami"]);
    assert.equal(options?.cwd, "/target");
    assert.equal(options?.input, "fixture");
    return "result";
  };
  const tools = createToolchain({
    runner: raw,
    ui,
    inspect: async () => ({ kind: "cached", command: "/checked/supabase" }),
  });
  assert.equal(
    await tools.runner("supabase", ["whoami"], {
      cwd: "/target",
      input: "fixture",
    }),
    "result",
  );
});
test("missing CLI never installs implicitly, but an explicit install can resume the same session", async () => {
  let installs = 0;
  const tools = createToolchain({
    runner: async (command) => command,
    ui,
    inspect: async () => ({ kind: "install" }),
    ensure: async () => {
      installs++;
      return "/managed/supabase";
    },
  });
  await assert.rejects(tools.runner("supabase", ["whoami"]), /无法启动/);
  assert.equal(installs, 0);
  assert.equal(await tools.ensureSupabaseCli(), true);
  assert.equal(await tools.runner("supabase", ["whoami"]), "/managed/supabase");
  assert.equal(installs, 1);
});
test("canceling optional installation returns to the caller without invoking the CLI", async () => {
  const tools = createToolchain({
    runner: async () => {
      throw new Error("unexpected command");
    },
    ui,
    ensure: async () => undefined,
  });
  assert.equal(await tools.ensureSupabaseCli(), false);
});
test("doctor reports API independence and optional tools without credentials or automatic installation", async () => {
  const lines = await dependencyReport(
    "/target",
    async (command) => (command === "gh" ? "gh version 2.80.0" : "4.149.0"),
    async () => ({ kind: "install" }),
  );
  assert.match(lines.join("\n"), /API.*无需/);
  assert.match(lines.join("\n"), /2.80.0/);
  assert.match(lines.join("\n"), /4.149.0/);
  assert.match(lines.join("\n"), /按需安装/);
});
