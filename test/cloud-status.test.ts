import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { githubPages } from "../src/process.ts";
import { wizard, type Context } from "../src/wizard.ts";

const config = validateConfig({
  version: 1,
  project: "fulcord",
  repository: "royorange/fulcord",
  environments: ["staging", "production"],
  variables: {
    cloudflareToken: "CLOUDFLARE_API_TOKEN",
    supabaseUrl: "SUPABASE_URL",
    supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
    pagesProject: "CF_PAGES_PROJECT",
    appOrigin: "APP_ORIGIN",
  },
});
function fixture(
  screens: string[],
  actions = ["status", "back", "exit"],
): Context {
  return {
    root: "/fixture",
    config,
    env: "staging",
    save: async () => {},
    data: {
      credentials: {},
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@repository": "royorange/fulcord",
          "@githubIdentity": "1",
          "@githubLogin": "fixture",
        },
      },
    },
    ui: {
      select: async (message) => {
        screens.push(message);
        return actions.shift()!;
      },
      input: async () => "",
      confirm: async () => false,
      check: async () => [],
      log: () => {},
    },
    runner: async (_command, args) => {
      if (args.includes("user"))
        return JSON.stringify({ id: 1, login: "fixture" });
      if (args.some((arg) => arg.includes("/variables?")))
        return '{"variables":[]}';
      if (args.some((arg) => arg.includes("/secrets?")))
        return '{"secrets":[]}';
      throw new Error("unexpected command");
    },
  };
}

test("status distinguishes local hidden values, existing cloud Secrets/Variables and confirmed missing Environment entries", async () => {
  const screens: string[] = [];
  const ctx = fixture(screens);
  ctx.data.profiles[projectKey("fulcord", "staging")]!.supabasePublishableKey =
    "sb_publishable_fixture_private";
  ctx.runner = async (command, args) => {
    assert.equal(command, "gh");
    assert.equal(args[0], "api");
    assert.ok(!args.includes("PUT") && !args.includes("set"));
    if (args.includes("user"))
      return JSON.stringify({ id: 1, login: "fixture" });
    if (args.some((arg) => arg.includes("/variables?")))
      return '{"variables":[{"name":"CF_PAGES_PROJECT","value":"existing-pages"}]}';
    assert.ok(
      args.some((arg) => arg.includes("/environments/staging/secrets?")),
    );
    return '{"secrets":[{"name":"CLOUDFLARE_API_TOKEN"},{"name":"SUPABASE_URL"}]}';
  };
  const before = structuredClone(ctx.data);
  await wizard(ctx);
  const screen = screens.find((message) => message.includes("— 配置状态"))!;
  assert.match(screen, /SUPABASE_URL: .*已配置.*Secret.*本机未载入/);
  assert.match(screen, /CLOUDFLARE_API_TOKEN: .*已配置.*Secret/);
  assert.match(screen, /CF_PAGES_PROJECT: .*已配置.*Variable.*本机未载入/);
  assert.match(screen, /SUPABASE_PUBLISHABLE_KEY: 本机已载入（值已隐藏）/);
  assert.match(screen, /APP_ORIGIN: 本机未载入；GitHub staging：未配置/);
  assert.ok(!screen.includes("sb_publishable_fixture_private"));
  assert.deepEqual(
    ctx.data,
    before,
    "cloud metadata must not become local values or credentials",
  );
});

test("a secret-list permission failure is unknown, and refresh does not retain an old Secret presence", async () => {
  const screens: string[] = [];
  const ctx = fixture(screens, [
    "status",
    "refresh",
    "refresh",
    "back",
    "exit",
  ]);
  const progress: string[] = [];
  ctx.ui.log = (line) => progress.push(line);
  let reads = 0;
  ctx.runner = async (_command, args) => {
    if (args.includes("user"))
      return JSON.stringify({ id: 1, login: "fixture" });
    if (args.some((arg) => arg.includes("/variables?")))
      return '{"variables":[]}';
    if (++reads === 1) return '{"secrets":[{"name":"SUPABASE_URL"}]}';
    if (reads === 2) throw new Error("fixture denied");
    return '{"secrets":[]}';
  };
  await wizard(ctx);
  const snapshots = screens.filter((message) => message.includes("— 配置状态"));
  assert.match(snapshots[0]!, /SUPABASE_URL: .*已配置.*Secret/);
  assert.match(
    snapshots[1]!,
    /SUPABASE_URL: 本机未载入（云端未检查或无法检查）/,
  );
  assert.match(
    snapshots[2]!,
    /SUPABASE_URL: 本机未载入；GitHub staging：未配置/,
  );
  assert.ok(
    !progress.some((line) =>
      line.includes("SUPABASE_URL: GitHub staging：已配置"),
    ),
    "pre-check progress must not display an old cloud snapshot as current",
  );
});

test("a changed GitHub identity invalidates Secret presence instead of showing a previous account's snapshot", async () => {
  const screens: string[] = [];
  const ctx = fixture(screens);
  let identities = 0;
  ctx.runner = async (_command, args) => {
    if (args.includes("user"))
      return JSON.stringify({
        id: ++identities === 1 ? 1 : 2,
        login: "fixture",
      });
    if (args.some((arg) => arg.includes("/variables?")))
      return '{"variables":[]}';
    return '{"secrets":[{"name":"SUPABASE_URL"}]}';
  };
  await wizard(ctx);
  const screen = screens.find((message) => message.includes("— 配置状态"))!;
  assert.match(screen, /github: 验证失败/);
  assert.match(screen, /SUPABASE_URL: 本机未载入（云端未检查或无法检查）/);
  assert.ok(!screen.includes("已配置（Secret"));
});

test("GitHub Secret listing reads paginated names only and discards any unexpected value properties", async () => {
  const entries = await githubPages(
    "repos/royorange/fulcord/environments/staging/secrets",
    "secrets",
    async (command, args) => {
      assert.equal(command, "gh");
      assert.ok(
        args.some((arg) => arg.endsWith("/secrets?per_page=100&page=1")),
      );
      return '{"secrets":[{"name":"SUPABASE_URL","value":"must-not-be-retained"}]}';
    },
  );
  assert.deepEqual(entries, [{ name: "SUPABASE_URL" }]);
});

test("cloud presence is isolated between staging and production", async () => {
  const screens: string[] = [];
  const ctx = fixture(screens, [
    "status",
    "back",
    "environment",
    "production",
    "status",
    "back",
    "exit",
  ]);
  ctx.data.profiles[projectKey("fulcord", "production")] = {
    "@repository": "royorange/fulcord",
    "@githubIdentity": "1",
    "@githubLogin": "fixture",
  };
  ctx.runner = async (_command, args) => {
    if (args.includes("user"))
      return JSON.stringify({ id: 1, login: "fixture" });
    if (args.some((arg) => arg.includes("/variables?")))
      return '{"variables":[]}';
    return args.some((arg) => arg.includes("/staging/secrets?"))
      ? '{"secrets":[{"name":"SUPABASE_URL"}]}'
      : '{"secrets":[]}';
  };
  await wizard(ctx);
  const snapshots = screens.filter((message) => message.includes("— 配置状态"));
  assert.match(snapshots[0]!, /SUPABASE_URL: GitHub staging：已配置（Secret/);
  assert.match(
    snapshots[1]!,
    /SUPABASE_URL: 本机未载入；GitHub production：未配置/,
  );
});
