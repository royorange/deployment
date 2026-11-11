import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { parseEnv } from "../src/files.ts";
import { run, type Runner } from "../src/process.ts";
import { StateStore } from "../src/state.ts";
import {
  modules,
  values,
  wizard,
  type Context,
  type UI,
} from "../src/wizard.ts";

const config = validateConfig(
  JSON.parse(
    await readFile(
      new URL("../examples/fulcord.json", import.meta.url),
      "utf8",
    ),
  ),
);
function scripted(
  selects: string[],
  inputs: string[] = [],
  logs: string[] = [],
): UI {
  return {
    select: async (message, choices) => {
      logs.push(message);
      if (message.includes("— 操作结果")) return "back";
      const answer = selects.shift() ?? "exit";
      assert.ok(choices.some((choice) => choice.value === answer));
      return answer;
    },
    input: async (_message, options) => inputs.shift() ?? options?.value ?? "",
    confirm: async () => true,
    check: async (_message, choices) => {
      assert.ok(choices.length, "never open an empty checkbox");
      return choices
        .filter((choice) => choice.checked !== false)
        .map((choice) => choice.value);
    },
    log: (line) => logs.push(line),
  };
}

test("a new machine imports GitHub variables, exports a local env, restores public state and isolates environments", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-onboarding-"));
  const variables = {
    CF_ACCOUNT_ID: "a".repeat(32),
    CF_PAGES_PROJECT: "existing-pages",
    CF_WORKER_NAME: "existing-worker",
    FULCORD_SITE_ORIGIN: "https://existing.pages.dev",
    FULCORD_APP_ORIGIN: "https://app.example.test",
  };
  const runner: Runner = async (command, args, options) => {
    if (command === "git") return run(command, args, options);
    assert.equal(command, "gh");
    assert.ok(!args.includes("set") && !args.includes("PUT"));
    if (args.includes("user"))
      return JSON.stringify({ id: 1, login: "fixture" });
    if (args.some((arg) => arg.includes("/variables?")))
      return JSON.stringify({
        variables: Object.entries(variables).map(([name, value]) => ({
          name,
          value,
        })),
      });
    return "{}";
  };
  try {
    await run("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env*\n.project-setup/\n");
    const store = await StateStore.open(
      join(root, "local-state"),
      root,
      config,
    );
    const logs: string[] = [];
    const ctx: Context = {
      root,
      config,
      env: "staging",
      data: store.data,
      runner,
      ui: scripted(
        [
          "github",
          "read",
          "export",
          "env",
          "environment",
          "production",
          "edit",
          "appOrigin",
          "environment",
          "staging",
          "exit",
        ],
        [
          "royorange/fulcord",
          "deploy/.env.staging",
          "https://production.example.test",
        ],
        logs,
      ),
      save: async () => store.save(ctx.data),
    };
    await wizard(ctx);
    const exported = parseEnv(
      await readFile(join(root, "deploy/.env.staging"), "utf8"),
    );
    for (const [name, value] of Object.entries(variables))
      assert.equal(exported[name], value);
    assert.ok(
      logs.some(
        (line) => line.includes("— 操作结果") && line.includes("导入 5 项"),
      ),
    );
    const reopened = await StateStore.open(
      join(root, "local-state"),
      root,
      config,
    );
    assert.equal(
      reopened.data.profiles[projectKey("fulcord", "staging")]?.appOrigin,
      variables.FULCORD_APP_ORIGIN,
    );
    assert.equal(
      reopened.data.profiles[projectKey("fulcord", "production")]?.appOrigin,
      "https://production.example.test",
    );
    assert.deepEqual(reopened.data.credentials, {});
    const restored: Context = {
      ...ctx,
      data: reopened.data,
      ui: scripted(["export", "env", "exit"], ["deploy/.env.restored"]),
      save: async () => reopened.save(restored.data),
    };
    await wizard(restored);
    assert.deepEqual(
      parseEnv(await readFile(join(root, "deploy/.env.restored"), "utf8")),
      exported,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty GitHub imports explain the missing source without opening empty selectors", async () => {
  const logs: string[] = [];
  const ctx: Context = {
    root: "/no-env-file",
    config,
    env: "staging",
    data: { credentials: {}, profiles: {} },
    ui: {
      ...scripted([], [], logs),
      check: async () => {
        throw new Error("empty checkbox opened");
      },
    },
    save: async () => {},
    runner: async (_command, args) =>
      args.includes("user")
        ? JSON.stringify({ id: 1, login: "fixture" })
        : args.some((arg) => arg.includes("/variables?"))
          ? '{"variables":[]}'
          : "{}",
  };
  await modules
    .find((module) => module.id === "github")!
    .actions.find((action) => action.id === "read")!
    .execute(ctx);
  assert.ok(logs.some((line) => line.includes("没有可导入")));
});

test("local env import can load on a new machine, and an unmatched file produces an explicit empty result", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-local-import-"));
  try {
    await run("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env*\n.project-setup/\n");
    await writeFile(join(root, ".env.unrelated"), "UNRELATED=value\n", {
      mode: 0o600,
    });
    await writeFile(
      join(root, ".env.local"),
      "FULCORD_APP_ORIGIN=https://app.example.test\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_fixture_local\n",
      { mode: 0o600 },
    );
    const logs: string[] = [];
    const ctx: Context = {
      root,
      config,
      env: "staging",
      data: { credentials: {}, profiles: {} },
      runner: run,
      save: async () => {},
      ui: scripted(
        ["import", "env", "import", "env", "replace", "exit"],
        [".env.unrelated", ".env.local"],
        logs,
      ),
    };
    await wizard(ctx);
    assert.ok(logs.some((line) => line.includes("没有可导入项")));
    assert.ok(logs.some((line) => line.includes("已导入 2 项")));
    assert.equal(values(ctx).appOrigin, "https://app.example.test");
    assert.equal(
      values(ctx).supabasePublishableKey,
      "sb_publishable_fixture_local",
    );
    assert.ok(!logs.join("\n").includes("sb_publishable_fixture_local"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty exports explain the next step and do not create an env file", async () => {
  const logs: string[] = [];
  const ctx: Context = {
    root: "/no-env-file",
    config: { ...config, defaults: undefined },
    env: "staging",
    data: { credentials: {}, profiles: {} },
    save: async () => {},
    ui: scripted(["export", "env", "exit"], [], logs),
    runner: async () => {
      throw new Error("empty export must not write a file");
    },
  };
  await wizard(ctx);
  assert.ok(logs.some((line) => line.includes("当前没有可导出配置")));
});

test("public env export does not require an unrelated saved Supabase profile to be logged in", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-public-export-"));
  try {
    await run("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env*\n.project-setup/\n");
    const ctx: Context = {
      root,
      config,
      env: "staging",
      data: {
        credentials: {},
        profiles: {
          [projectKey("fulcord", "staging")]: {
            cloudflareAccountId: "a".repeat(32),
            "@supabaseSource": "cli",
            "@supabaseProfile": "not-logged-in-here",
            "@supabaseIdentity": "11111111-1111-4111-8111-111111111111",
            supabaseProjectRef: "b".repeat(20),
          },
        },
      },
      save: async () => {},
      ui: {
        ...scripted(["export", "env", "exit"]),
        check: async (_message, choices) =>
          choices
            .filter((choice) => choice.value === "CF_ACCOUNT_ID")
            .map((choice) => choice.value),
      },
      runner: async (command, args, options) => {
        assert.equal(
          command,
          "git",
          "public export must not require Supabase login",
        );
        return run(command, args, options);
      },
    };
    await wizard(ctx);
    assert.equal(
      parseEnv(
        await readFile(join(root, ".project-setup/staging/.env"), "utf8"),
      ).CF_ACCOUNT_ID,
      "a".repeat(32),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all provider back actions return without requesting credentials or changing bindings", async () => {
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    data: { credentials: {}, profiles: {} },
    ui: scripted([
      "cloudflare",
      "back",
      "supabase",
      "back",
      "github",
      "back",
      "exit",
    ]),
    runner: async () => {
      throw new Error("back must not access a provider");
    },
    save: async () => {},
  };
  await wizard(ctx);
  assert.equal(values(ctx)["@githubIdentity"], undefined);
});
