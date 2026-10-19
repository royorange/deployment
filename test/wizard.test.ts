import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { validateConfig, projectKey } from "../src/config.ts";
import {
  wizard,
  modules,
  values,
  type Context,
  type UI,
} from "../src/wizard.ts";
import type { RunOptions } from "../src/process.ts";

const account = "a".repeat(32);
const ref = "b".repeat(20);
test("switching Cloudflare account clears resource names and origins from the previous account", async () => {
  const nextAccount = "c".repeat(32);
  const ctx: Context = {
    root: "/fixture",
    config: await config(),
    env: "staging",
    runner: async () => "",
    save: async () => {},
    data: {
      credentials: { "cloudflare/personal": "fixture-token" },
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@cloudflare": "cloudflare/personal",
          cloudflareAccountId: account,
          pagesProject: "old-project",
          workerName: "old-worker",
          appOrigin: "https://old.example",
          siteOrigin: "https://old.pages.dev",
        },
      },
    },
    ui: scripted(["cloudflare/personal", nextAccount], [], []),
    fetcher: async () =>
      Response.json({
        success: true,
        result: [{ id: nextAccount, name: "Second account" }],
      }),
  };
  await modules[0]!.actions
    .find((action) => action.id === "account")!
    .execute(ctx);
  assert.equal(values(ctx).cloudflareAccountId, nextAccount);
  assert.equal(values(ctx).pagesProject, undefined);
  assert.equal(values(ctx).appOrigin, undefined);
});
function scripted(
  selects: string[],
  inputs: Array<string | undefined>,
  logs: string[],
  confirmations = true,
): UI {
  return {
    select: async (message, choices) => {
      if (message.includes("— 操作结果")) return "back";
      const answer = selects.shift();
      assert.ok(
        choices.some((choice) => choice.value === answer),
        `unexpected answer ${answer}, choices: ${choices.map((c) => c.value)}`,
      );
      return answer!;
    },
    input: async (_message, options) => {
      assert.ok(inputs.length);
      return inputs.shift() ?? options?.value ?? "";
    },
    confirm: async () => confirmations,
    check: async (_message, choices) => choices.map((choice) => choice.value),
    log: (line) => logs.push(line),
  };
}
async function config() {
  return validateConfig(
    JSON.parse(
      await readFile(
        new URL("../examples/fulcord.json", import.meta.url),
        "utf8",
      ),
    ),
  );
}

test("complete wizard configures two providers, reuses Pages, exports correct CI secrets and isolates production", async () => {
  const logs: string[] = [];
  const apiWrites: string[] = [];
  const githubCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  let pagesExists = false;
  let saves = 0;
  const ctx: Context = {
    root: "/fixture",
    config: await config(),
    env: "staging",
    data: {
      credentials: {
        "cloudflare/personal": "cf-sensitive-fixture",
        "supabase/personal": "sb-sensitive-fixture",
      },
      profiles: {},
    },
    ui: scripted(
      [
        "cloudflare",
        "account",
        "cloudflare/personal",
        account,
        "cloudflare",
        "pages",
        "cloudflare",
        "pages",
        "cloudflare",
        "worker",
        "supabase",
        "project",
        "supabase/personal",
        "org-1",
        ref,
        "github",
        "sync",
        "environment",
        "production",
        "status",
        "back",
        "exit",
      ],
      [undefined, undefined, undefined, undefined, undefined],
      logs,
    ),
    runner: async (_command, args, options) => {
      githubCalls.push({ args, options });
      if (args.includes("user"))
        return JSON.stringify({ id: 1, login: "royorange" });
      if (args.some((arg) => arg.includes("/environments?")))
        return JSON.stringify({ environments: [{ name: "staging" }] });
      return "{}";
    },
    fetcher: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        apiWrites.push(path);
        pagesExists = true;
      }
      if (path.endsWith("/accounts"))
        return Response.json({
          success: true,
          result: [{ id: account, name: "Personal" }],
        });
      if (path.includes("/pages/projects"))
        return pagesExists
          ? Response.json({
              success: true,
              result: {
                name: "fulcord-web",
                production_branch: "main",
                subdomain: "fulcord-web.pages.dev",
              },
            })
          : new Response("{}", { status: 404 });
      if (path.endsWith("/workers/subdomain"))
        return Response.json({
          success: true,
          result: { subdomain: "roy-test" },
        });
      if (path === "/v1/organizations")
        return Response.json([{ id: "org-1", name: "New account" }]);
      if (path === "/v1/profile")
        return Response.json({
          gotrue_id: "11111111-1111-4111-8111-111111111111",
          primary_email: "new@example.test",
        });
      if (path === "/v1/projects")
        return Response.json([
          {
            id: ref,
            name: "fulcord-dev",
            region: "ap-northeast-1",
            organization_id: "org-1",
            status: "ACTIVE_HEALTHY",
          },
        ]);
      if (path.endsWith("/api-keys"))
        return Response.json([
          {
            type: "publishable",
            name: "default",
            api_key: "sb_publishable_fixture",
          },
          { type: "secret", name: "secret", api_key: "sb_secret_never_save" },
        ]);
      throw new Error(`unexpected request ${path}`);
    },
    save: async () => {
      saves++;
    },
  };
  await wizard(ctx);
  assert.equal(
    apiWrites.length,
    1,
    "second Pages setup must reuse existing resource",
  );
  assert.equal(
    ctx.data.profiles[projectKey("fulcord", "staging")]?.appOrigin,
    "https://fulcord-app-staging.roy-test.workers.dev",
  );
  assert.equal(
    ctx.data.profiles[projectKey("fulcord", "staging")]?.supabaseProjectRef,
    ref,
  );
  assert.deepEqual(
    values(ctx),
    {},
    "production must not inherit staging values",
  );
  const secretNames = githubCalls
    .filter((call) => call.args[0] === "secret")
    .map((call) => call.args[2]);
  assert.deepEqual(
    secretNames.sort(),
    ["CLOUDFLARE_API_TOKEN", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_URL"].sort(),
  );
  assert.equal(
    githubCalls.filter((call) => call.args[0] === "variable").length,
    5,
  );
  assert.ok(
    githubCalls.every((call) => !call.args.join(" ").includes("sensitive")),
  );
  assert.ok(!logs.join("\n").includes("sensitive"));
  assert.ok(!JSON.stringify(ctx.data).includes("sb_secret_"));
  assert.ok(saves >= 6);
});

test("declining Pages creation makes no external mutation or false resource claim", async () => {
  const ctx: Context = {
    root: "/fixture",
    config: await config(),
    env: "staging",
    data: {
      credentials: { "cloudflare/personal": "test-token" },
      profiles: {
        [projectKey("fulcord", "staging")]: {
          "@cloudflare": "cloudflare/personal",
          cloudflareAccountId: account,
        },
      },
    },
    ui: scripted([], ["new-project"], [], false),
    runner: async () => "",
    save: async () => {},
    fetcher: async (_url, init) => {
      assert.equal(init?.method, "GET");
      return new Response("{}", { status: 404 });
    },
  };
  await modules[0]!.actions
    .find((action) => action.id === "pages")!
    .execute(ctx);
  assert.equal(values(ctx).pagesProject, undefined);
});

test("zoncord manifest shares credentials but uses its own variable and deploy-profile mappings", async () => {
  const zoncord = validateConfig(
    JSON.parse(
      await readFile(
        new URL("../examples/zoncord.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(zoncord.variables.appOrigin, "APP_ORIGIN");
  assert.equal(zoncord.jsonExport?.publicOrigin, "appOrigin");
  assert.equal(zoncord.defaults?.staging?.deploymentEnvironment, "staging");
  assert.equal(zoncord.jsonExport?.cloudflaredImage, "cloudflaredImage");
  assert.notEqual(
    projectKey(zoncord.project, "staging"),
    projectKey("fulcord", "staging"),
  );
});

test("GitHub environment read failure never creates an environment or writes secrets", async () => {
  const calls: string[][] = [];
  const ctx: Context = {
    root: "/fixture",
    config: await config(),
    env: "staging",
    data: { credentials: {}, profiles: {} },
    ui: scripted([], [undefined], []),
    save: async () => {},
    runner: async (_command, args) => {
      calls.push(args);
      if (args.includes("user"))
        return JSON.stringify({ id: 1, login: "royorange" });
      if (args.some((arg) => arg.includes("/environments?")))
        throw new Error("forbidden");
      return "{}";
    },
  };
  await assert.rejects(
    modules
      .find((module) => module.id === "github")!
      .actions.find((action) => action.id === "sync")!
      .execute(ctx),
  );
  assert.ok(
    calls.every((args) => !args.includes("PUT") && !args.includes("set")),
  );
});
