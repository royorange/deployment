import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WRANGLER_VERSION,
  wranglerCacheDirectory,
} from "../src/managed-wrangler.ts";
import { createToolchain, dependencyReport } from "../src/toolchain.ts";
import { CommandUnavailableError, type Runner } from "../src/process.ts";

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
test("doctor names where Wrangler was found and which directory was checked when it is missing", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "setup-doctor-")));
  try {
    const root = join(temp, "project");
    const base = join(temp, "cache");
    const missingWrangler: Runner = async (command) => {
      if (command === "wrangler") throw new CommandUnavailableError("wrangler");
      return "gh version 2.80.0";
    };
    const absent = (
      await dependencyReport(
        root,
        missingWrangler,
        async () => ({ kind: "install" }),
        base,
      )
    ).join("\n");
    assert.ok(absent.includes(root));
    assert.match(absent, /setup 私有缓存/);
    assert.match(
      absent,
      new RegExp(`确认安装固定版本 ${WRANGLER_VERSION.replaceAll(".", "\\.")}`),
    );
    const script = join(
      root,
      "apps/edge/node_modules/wrangler/bin/wrangler.js",
    );
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, "");
    const present = (
      await dependencyReport(
        root,
        async () => "4.149.0",
        async () => ({ kind: "install" }),
        base,
      )
    ).join("\n");
    assert.match(present, /wrangler：可用 4\.149\.0（项目依赖：/);
    assert.ok(present.includes(join(root, "apps/edge")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("Wrangler installation is delegated only when a Cloudflare login asks for it", async () => {
  const roots: string[] = [];
  const tools = createToolchain({
    runner: async () => "ok",
    ui,
    ensureWranglerCli: async (options) => {
      roots.push(options.root);
      return true;
    },
  });
  assert.deepEqual(roots, []);
  assert.equal(await tools.ensureWrangler("/target"), true);
  assert.deepEqual(roots, ["/target"]);
});
test("doctor reports an unsafe Wrangler cache instead of crashing", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "setup-doctor-")));
  try {
    const root = join(temp, "project");
    const base = join(temp, "cache");
    const location = wranglerCacheDirectory(base);
    await mkdir(join(location, "node_modules/wrangler/bin"), {
      recursive: true,
    });
    await writeFile(
      join(location, "node_modules/wrangler/bin/wrangler.js"),
      "",
    );
    await chmod(location, 0o777);
    const lines = await dependencyReport(
      root,
      async (command) => {
        assert.notEqual(command, process.execPath, "unsafe cache must not run");
        return "gh version 2.80.0";
      },
      async () => ({ kind: "install" }),
      base,
    );
    assert.match(
      lines.join("\n"),
      /wrangler：Wrangler 私有缓存所有者或权限不安全/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
