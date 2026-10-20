import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliSupabase,
  wranglerSession,
  supabaseEnvironment,
} from "../src/official.ts";
import { StateStore, vaultProfileKey } from "../src/state.ts";
import { validateConfig, projectKey } from "../src/config.ts";
import type { RunOptions } from "../src/process.ts";
import { modules, wizard, type Context } from "../src/wizard.ts";

const uid = "11111111-1111-4111-8111-111111111111";
const ref = "a".repeat(20);
const account = "b".repeat(32);
const config = validateConfig({
  version: 1,
  project: "fulcord",
  repository: "royorange/fulcord",
  migrationStrategy: "supabase-cli",
  environments: ["staging", "production"],
  variables: {
    appOrigin: "APP_ORIGIN",
    cloudflareToken: "CLOUDFLARE_API_TOKEN",
    supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
  },
});

test("resource operations with an unloaded manual token require an explicit reconnect rather than implicitly rebinding an account", async () => {
  let prompts = 0;
  const original = {
    "@cloudflareSource": "token",
    "@cloudflare": "cloudflare/old",
    cloudflareAccountId: account,
    pagesProject: "old-pages",
    "@supabaseSource": "token",
    "@supabase": "supabase/old",
    supabaseProjectRef: ref,
    "@supabaseIdentity": uid,
  };
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    data: {
      credentials: {},
      profiles: { [projectKey("fulcord", "staging")]: { ...original } },
    },
    save: async () => {},
    ui: {
      select: async () => {
        prompts++;
        throw new Error("unexpected auth prompt");
      },
      input: async () => {
        prompts++;
        return "";
      },
      confirm: async () => false,
      check: async () => [],
      log: () => {},
    },
    runner: async () => {
      throw new Error("unexpected CLI call");
    },
  };
  await assert.rejects(
    modules[0]!.actions.find((action) => action.id === "pages")!.execute(ctx),
    /请先连接/,
  );
  await assert.rejects(
    modules
      .find((module) => module.id === "supabase")!
      .actions.find((action) => action.id === "migrations")!
      .execute(ctx),
    /请先连接/,
  );
  assert.equal(prompts, 0);
  assert.deepEqual(
    ctx.data.profiles[projectKey("fulcord", "staging")],
    original,
  );
});

test("official Wrangler connection is not copied into a vault and its separate CI token preserves the login binding", async () => {
  const selections = ["official", account, "cloudflare/ci"];
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    storageMode: "vault",
    data: {
      credentials: {},
      profiles: {
        [projectKey("fulcord", "staging")]: { pagesProject: "fulcord-web" },
      },
    },
    save: async () => {},
    ui: {
      select: async (_message, choices) => {
        const answer = selections.shift()!;
        assert.ok(choices.some((choice) => choice.value === answer));
        return answer;
      },
      input: async () => "work",
      confirm: async () => true,
      check: async () => [],
      log: () => {},
    },
    runner: async (_command, args) =>
      args.includes("token")
        ? JSON.stringify({ type: "oauth", token: "official-never-save" })
        : JSON.stringify({
            loggedIn: true,
            email: "owner@example.test",
            accounts: [{ id: account, name: "Owner" }],
          }),
    fetcher: async (url, init) => {
      if (String(url).includes("pages/projects")) {
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          "Bearer dedicated-ci-token",
        );
        return Response.json({
          success: true,
          result: { name: "fulcord-web", production_branch: "main" },
        });
      }
      return Response.json({
        success: true,
        result: [{ id: account, name: "Owner" }],
      });
    },
  };
  await modules[0]!.actions
    .find((action) => action.id === "account")!
    .execute(ctx);
  assert.deepEqual(ctx.data.credentials, {});
  assert.ok(!JSON.stringify(ctx.data).includes("official-never-save"));
  ctx.data.credentials["cloudflare/ci"] = "dedicated-ci-token";
  await modules[0]!.actions
    .find((action) => action.id === "ci-token")!
    .execute(ctx);
  const profile = ctx.data.profiles[projectKey("fulcord", "staging")]!;
  assert.equal(profile["@cloudflareSource"], "wrangler");
  assert.equal(profile["@cloudflareIdentity"], "owner@example.test");
  assert.equal(profile["@cloudflareDeploy"], "cloudflare/ci");
  assert.equal(
    ctx.runtime?.statuses["staging/cloudflare"]?.source,
    "官方 Wrangler / work",
  );
});

test("a stale Supabase URL is blocked before an official project key is read or exported", async () => {
  let calls = 0;
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    data: {
      credentials: {},
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@supabaseSource": "cli",
          "@supabaseProfile": "new-account",
          "@supabaseIdentity": uid,
          supabaseProjectRef: ref,
          supabaseUrl: `https://${"c".repeat(20)}.supabase.co`,
        },
      },
    },
    save: async () => {},
    ui: {
      select: async () => "",
      input: async () => "",
      confirm: async () => false,
      check: async () => [],
      log: () => {},
    },
    runner: async () => {
      calls++;
      return "{}";
    },
  };
  await assert.rejects(
    modules
      .find((module) => module.id === "supabase")!
      .actions.find((action) => action.id === "health")!
      .execute(ctx),
    /URL.*Project Ref 不一致/,
  );
  assert.equal(calls, 0);
});

test("canceling a Supabase new-account/project selection preserves the original account, profile and key", async () => {
  const original = {
    credentials: { "supabase/old": "old-pat" },
    profiles: {
      [projectKey("fulcord", "staging")]: {
        "@supabaseSource": "cli",
        "@supabaseProfile": "old-account",
        "@supabaseIdentity": uid,
        supabaseProjectRef: "c".repeat(20),
        supabasePublishableKey: "sb_publishable_old",
      },
    },
  };
  const selections = ["official", "org-new", ref];
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    data: structuredClone(original),
    storageMode: "metadata",
    save: async () => {},
    ui: {
      select: async (_message, choices) => {
        const answer = selections.shift()!;
        assert.ok(choices.some((choice) => choice.value === answer));
        return answer;
      },
      input: async () => "new-account",
      confirm: async () => false,
      check: async () => [],
      log: () => {},
    },
    runner: async (_command, args) => {
      assert.ok(args.includes("new-account"));
      if (args[0] === "whoami")
        return JSON.stringify({
          id: "22222222-2222-4222-8222-222222222222",
          email: "new@example.test",
        });
      if (args[0] === "orgs")
        return JSON.stringify([{ id: "org-new", name: "New org" }]);
      if (args.includes("api-keys"))
        return JSON.stringify([
          { type: "publishable", api_key: "sb_publishable_new" },
        ]);
      return JSON.stringify([
        {
          id: ref,
          name: "fulcord-dev",
          organization_id: "org-new",
          region: "ap-northeast-1",
          status: "ACTIVE_HEALTHY",
        },
      ]);
    },
  };
  await modules
    .find((module) => module.id === "supabase")!
    .actions.find((action) => action.id === "project")!
    .execute(ctx);
  assert.deepEqual(ctx.data, original);
});

test("status reports an official profile identity mismatch without changing its saved binding", async () => {
  const selections = ["status", "back", "exit"];
  const logs: string[] = [];
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    data: {
      credentials: {},
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@supabaseSource": "cli",
          "@supabaseProfile": "bound-account",
          "@supabaseIdentity": uid,
        },
      },
    },
    save: async () => {},
    ui: {
      select: async (message) => {
        logs.push(message);
        return selections.shift()!;
      },
      input: async () => "",
      confirm: async () => false,
      check: async () => [],
      log: (message) => logs.push(message),
    },
    runner: async (command) =>
      command === "gh"
        ? JSON.stringify({ id: 1, login: "royorange" })
        : JSON.stringify({
            id: "22222222-2222-4222-8222-222222222222",
            email: "other@example.test",
          }),
  };
  await wizard(ctx);
  assert.ok(
    logs.some(
      (log) => log.includes("supabase: 验证失败") && log.includes("身份已变化"),
    ),
  );
  assert.equal(
    ctx.data.profiles[projectKey("fulcord", "staging")]?.["@supabaseIdentity"],
    uid,
  );
});

test("a switched Wrangler login is blocked before any Pages API read or creation", async () => {
  let apiRequests = 0;
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    data: {
      credentials: {},
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@cloudflareSource": "wrangler",
          "@cloudflareProfile": "work",
          "@cloudflareIdentity": "owner@example.test",
          cloudflareAccountId: account,
        },
      },
    },
    save: async () => {},
    ui: {
      select: async () => "",
      input: async () => "",
      confirm: async () => true,
      check: async () => [],
      log: () => {},
    },
    runner: async (_command, args) =>
      args.includes("token")
        ? JSON.stringify({ type: "oauth", token: "never-persist-oauth" })
        : JSON.stringify({
            loggedIn: true,
            email: "other@example.test",
            accounts: [{ id: account }],
          }),
    fetcher: async () => {
      apiRequests++;
      return new Response();
    },
  };
  await assert.rejects(
    modules[0]!.actions.find((action) => action.id === "pages")!.execute(ctx),
    /身份已变化/,
  );
  assert.equal(apiRequests, 0);
  assert.deepEqual(ctx.data.credentials, {});
});

test("default state persists only public fields and bindings; no credentials or project keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "setup-state-test-"));
  try {
    const store = await StateStore.open(dir, "/fixture", config);
    await store.save({
      credentials: { "cloudflare/work": "sensitive-token" },
      profiles: {
        [projectKey("fulcord", "staging")]: {
          appOrigin: "https://app.example",
          cloudflareToken: "sensitive-token",
          supabasePublishableKey: "sb_publishable_sensitive",
          "@supabaseSource": "cli",
          "@supabaseProfile": "fulcord-new",
          "@supabaseIdentity": uid,
        },
      },
    });
    const raw = await readFile(store.path, "utf8");
    assert.ok(!raw.includes("sensitive"));
    const reopened = await StateStore.open(dir, "/fixture", config);
    assert.equal(
      reopened.data.profiles[projectKey("fulcord", "staging")]?.[
        "@supabaseProfile"
      ],
      "fulcord-new",
    );
    assert.equal(
      reopened.data.profiles[projectKey("fulcord", "staging")]
        ?.supabasePublishableKey,
      undefined,
    );
    const other = await StateStore.open(dir, "/fixture", {
      ...config,
      repository: "another/fulcord",
    });
    assert.notEqual(
      other.path,
      store.path,
      "same project name in another repository must not collide",
    );
    assert.notEqual(
      vaultProfileKey("/fixture", config, "staging"),
      vaultProfileKey(
        "/fixture",
        { ...config, repository: "another/fulcord" },
        "staging",
      ),
    );
    assert.deepEqual(other.data.profiles, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("official Supabase commands pin a named profile, ignore ambient PAT, and never reveal secret keys", async () => {
  const calls: Array<{ args: string[]; options?: RunOptions }> = [];
  const cli = new CliSupabase(
    "fulcord-new",
    "/fixture",
    async (_command, args, options) => {
      calls.push({ args, options });
      if (args[0] === "whoami")
        return JSON.stringify({
          id: uid,
          email: "new@example.test",
          username: "new",
        });
      if (args[0] === "projects" && args[1] === "list")
        return JSON.stringify([
          {
            id: "internal-id",
            ref,
            name: "fulcord-dev",
            region: "ap-northeast-1",
            organization_id: "org",
            status: "ACTIVE_HEALTHY",
          },
        ]);
      if (args.includes("api-keys"))
        return JSON.stringify([
          { type: "publishable", api_key: "sb_publishable_fixture" },
          { type: "secret", api_key: "sb_secret_never_save" },
        ]);
      return "[]";
    },
    uid,
  );
  assert.equal((await cli.projects())[0]?.id, ref);
  assert.equal(await cli.publishableKey(ref), "sb_publishable_fixture");
  assert.ok(
    calls.every(
      (call) =>
        call.args.includes("--profile") && call.args.includes("fulcord-new"),
    ),
  );
  assert.ok(
    calls.every(
      (call) =>
        !call.args.includes("--reveal") &&
        !call.options?.env?.SUPABASE_ACCESS_TOKEN,
    ),
  );
  assert.equal(
    supabaseEnvironment(undefined, {
      ...process.env,
      SUPABASE_ACCESS_TOKEN: "stale-account-token",
      SUPABASE_API_URL: "https://other.example",
    }).SUPABASE_ACCESS_TOKEN,
    undefined,
  );
});

test("a replaced official profile is rejected before resource reads", async () => {
  const calls: string[][] = [];
  const cli = new CliSupabase(
    "fulcord-new",
    "/fixture",
    async (_command, args) => {
      calls.push(args);
      return JSON.stringify({
        id: "22222222-2222-4222-8222-222222222222",
        email: "other@example.test",
      });
    },
    uid,
  );
  await assert.rejects(cli.projects(), /身份.*变化/);
  assert.equal(calls.length, 1);
});

test("Wrangler official token stays in memory, validates target account and rejects switched identities", async () => {
  const session = await wranglerSession(
    "/fixture",
    async (_command, args, options) => {
      if (args.includes("token")) {
        assert.equal(options?.env?.CLOUDFLARE_API_TOKEN, undefined);
        return JSON.stringify({
          type: "oauth",
          token: "ephemeral-oauth-token",
        });
      }
      assert.equal(options?.env?.CLOUDFLARE_API_TOKEN, "ephemeral-oauth-token");
      return JSON.stringify({
        loggedIn: true,
        email: "owner@example.test",
        accounts: [{ id: account, name: "Owner" }],
      });
    },
    "default",
    "owner@example.test",
    account,
  );
  assert.equal(session.type, "oauth");
  assert.equal(session.identity, "owner@example.test");
  await assert.rejects(
    wranglerSession(
      "/fixture",
      async (_command, args) =>
        args.includes("token")
          ? JSON.stringify({ type: "oauth", token: "ephemeral" })
          : JSON.stringify({
              loggedIn: true,
              email: "other@example.test",
              accounts: [{ id: account }],
            }),
      "default",
      "owner@example.test",
      account,
    ),
    /身份.*变化/,
  );
});
