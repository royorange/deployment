import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { run } from "../src/process.ts";
import { modules, wizard, type Context } from "../src/wizard.ts";

const config = validateConfig({
  version: 1,
  project: "fulcord",
  repository: "royorange/fulcord",
  environments: ["staging", "production"],
  variables: {
    appOrigin: "APP_ORIGIN",
    supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
  },
});
const ref = "b".repeat(20);
const uid = "11111111-1111-4111-8111-111111111111";
function context(selects: string[], screens: string[]): Context {
  return {
    root: "/fixture",
    config,
    env: "staging",
    data: { credentials: {}, profiles: {} },
    ui: {
      select: async (message, choices) => {
        screens.push(message);
        if (message.includes("— 操作结果")) return "back";
        const answer = selects.shift() ?? "exit";
        assert.ok(choices.some((choice) => choice.value === answer));
        return answer;
      },
      input: async (_message, options) => options?.value ?? "",
      check: async (_message, choices) =>
        choices
          .filter((choice) => choice.checked !== false)
          .map((choice) => choice.value),
      confirm: async () => false,
      log: () => {},
    },
    save: async () => {},
    runner: async () => {
      throw new Error("unexpected CLI call");
    },
    fetcher: async () => {
      throw new Error("unexpected provider request");
    },
  };
}

for (const apply of [false, true]) {
  test(`Auth URL menu ${apply ? "applies only the confirmed two fields" : "can cancel without a remote write"} and retains existing redirects`, async () => {
    const screens: string[] = [];
    const ctx = context(["supabase", "auth", "exit"], screens);
    ctx.data = {
      credentials: { "supabase/test": "private-pat-fixture" },
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@supabase": "supabase/test",
          "@supabaseIdentity": uid,
          supabaseProjectRef: ref,
          appOrigin: "https://app.example.test",
        },
      },
    };
    ctx.ui.confirm = async () => apply;
    const writes: unknown[] = [];
    ctx.fetcher = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/profile")
        return Response.json({
          gotrue_id: uid,
          primary_email: "fixture@example.test",
        });
      assert.equal(path, `/v1/projects/${ref}/config/auth`);
      if (init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({});
      }
      assert.equal(init?.method, "GET");
      return Response.json({
        site_url: "https://old.example.test",
        uri_allow_list: "https://old.example.test/**",
      });
    };
    await wizard(ctx);
    assert.deepEqual(
      writes,
      apply
        ? [
            {
              site_url: "https://app.example.test",
              uri_allow_list:
                "https://old.example.test/**,https://app.example.test/**",
            },
          ]
        : [],
    );
    assert.ok(
      screens.some(
        (screen) =>
          screen.includes("— 操作结果") && screen.includes("保留已有回调地址"),
      ),
    );
    assert.ok(!screens.join("\n").includes("private-pat-fixture"));
  });
}

test("dashboard and create-project entries report a browser failure with a usable official URL", async () => {
  for (const [provider, action, expectedUrl] of [
    ["cloudflare", "dashboard", "https://dash.cloudflare.com/"],
    ["supabase", "create", "https://supabase.com/dashboard/new"],
  ]) {
    const logs: string[] = [];
    const ctx = context([], []);
    ctx.ui.confirm = async () => true;
    ctx.ui.log = (line) => logs.push(line);
    ctx.runner = async (_command, args) => {
      assert.ok(args.includes(expectedUrl!));
      throw new Error("fixture desktop unavailable");
    };
    await modules
      .find((module) => module.id === provider)!
      .actions.find((entry) => entry.id === action)!
      .execute(ctx);
    assert.ok(logs.includes(expectedUrl!));
    assert.ok(logs.some((line) => line.includes("未能自动打开浏览器")));
  }
});

test("switching gh accounts requires confirmation and does not silently replace project bindings", async () => {
  for (const approve of [false, true]) {
    const ctx = context([], []);
    ctx.data.profiles[projectKey("fulcord", "staging")] = {
      "@githubIdentity": "1",
      "@githubLogin": "old-user",
    };
    ctx.ui.input = async () => "other-user";
    ctx.ui.confirm = async () => approve;
    let switches = 0;
    ctx.runner = async (command, args) => {
      assert.equal(command, "gh");
      if (args.includes("switch")) {
        switches++;
        return "";
      }
      assert.ok(args.includes("user"));
      return JSON.stringify({ id: 2, login: "other-user" });
    };
    await modules
      .find((module) => module.id === "github")!
      .actions.find((entry) => entry.id === "switch")!
      .execute(ctx);
    assert.equal(switches, approve ? 1 : 0);
    assert.equal(
      ctx.data.profiles[projectKey("fulcord", "staging")]!["@githubIdentity"],
      "1",
    );
    if (approve)
      assert.equal(ctx.runtime?.statuses["staging/github"]?.state, "验证失败");
  }
});

test("zoncord JSON export writes complete project fields and explains missing fields without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-zoncord-export-"));
  const zoncord = validateConfig(
    JSON.parse(
      await readFile(
        new URL("../examples/zoncord.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  try {
    await run("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env*\n");
    const screens: string[] = [];
    const ctx = context(["export", "json", "exit"], screens);
    Object.assign(ctx, { root, config: zoncord, runner: run });
    await wizard(ctx);
    assert.ok(screens.some((screen) => screen.includes("JSON 配置尚缺")));
    await assert.rejects(readFile(join(root, ".env.setup.json")), {
      code: "ENOENT",
    });
    ctx.data.profiles[projectKey("zoncord", "staging")] = {
      ...zoncord.defaults!.staging,
      appOrigin: "https://app.example.test",
      privateOrigin: "https://backend.example.test",
      cloudflareAccountId: "a".repeat(32),
      imageRepository: "ghcr.io/royorange/zoncord",
      cloudflaredImage: `cloudflare/cloudflared@sha256:${"a".repeat(64)}`,
    };
    ctx.ui = context(["export", "json", "exit"], screens).ui;
    ctx.ui.confirm = async () => true;
    await wizard(ctx);
    const json = JSON.parse(
      await readFile(join(root, ".env.setup.json"), "utf8"),
    );
    assert.equal(json.environment, "staging");
    assert.equal(json.publicOrigin, "https://app.example.test");
    assert.equal(json.privateOrigin, "https://backend.example.test");
    assert.equal(json.pagesProject, "zoncord-web");
    assert.equal(Object.keys(json).length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clipboard export can be canceled and leaves a persistent operation result", async () => {
  const screens: string[] = [];
  const ctx = context(["export", "clipboard", "exit"], screens);
  ctx.data.profiles[projectKey("fulcord", "staging")] = {
    appOrigin: "https://app.example.test",
  };
  let calls = 0;
  ctx.runner = async () => {
    calls++;
    return "";
  };
  await wizard(ctx);
  assert.equal(calls, 0);
  assert.ok(
    screens.some(
      (screen) =>
        screen.includes("— 操作结果") && screen.includes("APP_ORIGIN"),
    ),
  );
});
