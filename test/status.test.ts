import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { wizard, type Context } from "../src/wizard.ts";
import { StateStore } from "../src/state.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = validateConfig(
  JSON.parse(
    await readFile(
      new URL("../examples/fulcord.json", import.meta.url),
      "utf8",
    ),
  ),
);

test("imported GitHub variables stay on the status screen until returning, without an env file or provider writes", async () => {
  const imported = {
    CF_ACCOUNT_ID: "a".repeat(32),
    CF_PAGES_PROJECT: "existing-pages",
    CF_WORKER_NAME: "existing-worker",
    FULCORD_SITE_ORIGIN: "https://staging.existing-pages.pages.dev",
    FULCORD_APP_ORIGIN: "https://app.example.test",
  };
  const token = "private-ci-token-fixture";
  const key = "sb_publishable_private_fixture";
  const main = ["github", "status", "exit"];
  const logs: string[] = [];
  const screens: string[] = [];
  let mainVisits = 0;
  let statusMainVisits = 0;
  const ctx: Context = {
    root: "/no-env-file",
    config,
    env: "staging",
    data: {
      credentials: { "cloudflare/ci": token },
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@cloudflareDeploy": "cloudflare/ci",
          supabasePublishableKey: key,
        },
      },
    },
    save: async () => {},
    ui: {
      select: async (message, choices) => {
        if (message.includes("— 操作结果")) return "back";
        if (choices.some((choice) => choice.value === "refresh")) {
          screens.push(message);
          statusMainVisits = mainVisits;
          return "back";
        }
        if (choices.some((choice) => choice.value === "read")) return "read";
        mainVisits++;
        return main.shift() ?? "exit";
      },
      input: async (_message, options) => options?.value ?? "",
      check: async (_message, choices) => choices.map((choice) => choice.value),
      confirm: async () => {
        throw new Error("status must not ask for a write confirmation");
      },
      log: (message) => logs.push(message),
    },
    runner: async (command, args) => {
      assert.equal(command, "gh");
      if (args[0] === "auth") return "";
      assert.equal(args[0], "api", "only read-only GitHub APIs are allowed");
      if (args.includes("user"))
        return JSON.stringify({ id: 1, login: "fixture-user" });
      if (args.some((arg) => arg.includes("/variables?")))
        return JSON.stringify({
          variables: Object.entries(imported).map(([name, value]) => ({
            name,
            value,
          })),
        });
      assert.ok(args.includes("repos/royorange/fulcord"));
      return "{}";
    },
    fetcher: async () => {
      throw new Error("status must not access or mutate provider resources");
    },
  };
  await wizard(ctx);
  assert.equal(screens.length, 1, "status needs its own persistent screen");
  assert.equal(statusMainVisits, 2, "main menu must wait for status to close");
  for (const [name, value] of Object.entries(imported))
    assert.ok(screens[0]!.includes(`${name}: ${value}`));
  assert.match(screens[0]!, /fulcord \/ staging/);
  assert.match(screens[0]!, /github: 已验证.*fixture-user/);
  assert.match(screens[0]!, /CLOUDFLARE_API_TOKEN: 本机已载入（值已隐藏）/);
  assert.match(screens[0]!, /SUPABASE_PUBLISHABLE_KEY: 本机已载入（值已隐藏）/);
  assert.match(screens[0]!, /SUPABASE_URL: 本机未载入/);
  assert.match(screens[0]!, /不代表云端未配置/);
  assert.ok(![...logs, ...screens].join("\n").includes(token));
  assert.ok(![...logs, ...screens].join("\n").includes(key));
});

test("status shows local fields before slow login verification and can refresh a failed login without leaving the screen", async () => {
  const logs: string[] = [];
  const screens: string[] = [];
  const events: string[] = [];
  const main = ["status", "exit"];
  let checks = 0;
  const ctx: Context = {
    root: "/no-env-file",
    config,
    env: "staging",
    data: { credentials: {}, profiles: {} },
    save: async () => {},
    ui: {
      select: async (message, choices) => {
        if (message.includes("— 操作结果")) return "back";
        if (choices.some((choice) => choice.value === "refresh")) {
          events.push("status");
          screens.push(message);
          return screens.length === 1 ? "refresh" : "back";
        }
        events.push("main");
        return main.shift() ?? "exit";
      },
      input: async () => "",
      check: async () => [],
      confirm: async () => false,
      log: (message) => logs.push(message),
    },
    runner: async (command, args) => {
      assert.equal(command, "gh");
      assert.ok(args.includes("user"));
      assert.ok(
        logs.some((line) => line.includes("CF_ACCOUNT_ID: 本机未载入")),
      );
      assert.ok(logs.some((line) => line.includes("正在验证 github")));
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (++checks === 1) throw new Error("fixture login unavailable");
      return JSON.stringify({ id: 1, login: "fixture-user" });
    },
  };
  await wizard(ctx);
  assert.equal(checks, 2);
  assert.deepEqual(events, ["main", "status", "status", "main"]);
  assert.match(screens[0]!, /github: 验证失败/);
  assert.match(screens[1]!, /github: 已验证.*fixture-user/);
  assert.match(screens[1]!, /cloudflare: 未验证/);
});

test("reopened official Supabase binding reloads the publishable key for status without persisting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "setup-status-restore-"));
  const ref = "b".repeat(20);
  const uid = "11111111-1111-4111-8111-111111111111";
  const key = "sb_publishable_rehydrated_fixture";
  try {
    const store = await StateStore.open(directory, "/fixture", config);
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
            supabaseProjectRef: ref,
            supabaseUrl: `https://${ref}.supabase.co`,
          },
        },
      },
      save: async () => store.save(ctx.data),
      ui: {
        select: async () => "exit",
        input: async () => "",
        check: async () => [],
        confirm: async () => false,
        log: () => {},
      },
      runner: async () => {
        throw new Error("no CLI needed to save metadata");
      },
    };
    await wizard(ctx);
    const reopened = await StateStore.open(directory, "/fixture", config);
    const screens: string[] = [];
    const selections = ["status", "back", "exit"];
    const restored: Context = {
      ...ctx,
      data: reopened.data,
      save: async () => reopened.save(restored.data),
      ui: {
        ...ctx.ui,
        select: async (message) => {
          screens.push(message);
          return selections.shift()!;
        },
      },
      runner: async (command, args) => {
        if (command === "gh")
          return JSON.stringify({ id: 1, login: "fixture" });
        assert.equal(command, "supabase");
        assert.ok(args.includes("bound-account"));
        if (args.includes("whoami"))
          return JSON.stringify({ id: uid, email: "fixture@example.test" });
        assert.ok(args.includes("api-keys") && args.includes(ref));
        return JSON.stringify([{ type: "publishable", api_key: key }]);
      },
    };
    await wizard(restored);
    assert.ok(
      screens.some(
        (screen) =>
          screen.includes("supabase: 已验证") &&
          screen.includes("SUPABASE_PUBLISHABLE_KEY: 本机已载入（值已隐藏）"),
      ),
    );
    assert.ok(!screens.join("\n").includes(key));
    assert.ok(!(await readFile(reopened.path, "utf8")).includes(key));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
