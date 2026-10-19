import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, projectKey } from "../src/config.ts";
import { Supabase } from "../src/providers.ts";
import { modules, wizard, type Context } from "../src/wizard.ts";

const ref = "b".repeat(20);
const uid = "11111111-1111-4111-8111-111111111111";
const token = "private-fixture-pat";
const key = "sb_publishable_fixture";
const config = validateConfig({
  version: 1,
  project: "fixture",
  environments: ["staging"],
  variables: {
    supabaseProjectRef: "PROJECT_REF",
    supabaseUrl: "SUPABASE_URL",
    supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
  },
});
function context(answers: string[]): {
  ctx: Context;
  logs: string[];
  screens: string[];
} {
  const logs: string[] = [];
  const screens: string[] = [];
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    storageMode: "metadata",
    data: { credentials: {}, profiles: {} },
    save: async () => {},
    ui: {
      select: async (message, choices) => {
        screens.push(
          `${message}\n${choices.map((choice) => choice.name).join("\n")}`,
        );
        if (message.includes("凭据来源"))
          assert.equal(choices[0]?.value, "new");
        const answer = answers.shift()!;
        assert.ok(
          choices.some((choice) => choice.value === answer),
          `${message}: ${answer}`,
        );
        return answer;
      },
      input: async (message, options) => {
        if (message.includes("隐藏输入")) {
          assert.equal(options?.secret, true);
          return token;
        }
        return options?.value ?? "personal";
      },
      confirm: async () => true,
      check: async () => [],
      log: (message) => logs.push(message),
    },
    runner: async () => {
      throw new Error("CLI unavailable");
    },
    fetcher: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/profile")
        return Response.json({
          gotrue_id: uid,
          primary_email: "fixture@example.test",
        });
      if (path === "/v1/organizations")
        return Response.json([{ id: "org-fixture", name: "fixture-org" }]);
      if (path === "/v1/projects")
        return Response.json([
          {
            id: ref,
            name: "fixture-project",
            region: "test",
            organization_id: "org-fixture",
            status: "INACTIVE",
          },
        ]);
      assert.equal(path, `/v1/projects/${ref}/api-keys`);
      return Response.json([
        { type: "publishable", name: "default", api_key: key },
      ]);
    },
  };
  return { ctx, logs, screens };
}
const connect = (ctx: Context) =>
  modules
    .find((module) => module.id === "supabase")!
    .actions.find((action) => action.id === "project")!
    .execute(ctx);

test("API is the first Supabase source and token acquisition can open the official page then continue manually", async () => {
  const { ctx, logs, screens } = context([
    "new",
    "open",
    "input",
    "org-fixture",
    ref,
  ]);
  let browserCalls = 0;
  ctx.runner = async (_command, args) => {
    browserCalls++;
    assert.ok(args.includes("https://supabase.com/dashboard/account/tokens"));
    throw new Error("browser unavailable");
  };
  await connect(ctx);
  assert.equal(browserCalls, 1);
  assert.ok(logs.includes("https://supabase.com/dashboard/account/tokens"));
  assert.match(logs.join("\n"), /未能自动打开/);
  assert.match(logs.join("\n"), /API Keys.*Read/);
  assert.match(screens.join("\n"), /INACTIVE/);
  assert.ok(![...logs, ...screens].join("\n").includes(token));
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.supabasePublishableKey,
    key,
  );
});

test("back from PAT acquisition preserves a CLI binding without invoking CLI or API", async () => {
  const { ctx } = context(["new", "back"]);
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "cli",
    "@supabaseProfile": "bound",
    "@supabaseIdentity": uid,
    supabaseProjectRef: ref,
  };
  const previous = structuredClone(ctx.data);
  ctx.fetcher = async () => {
    throw new Error("no API calls after cancellation");
  };
  await connect(ctx);
  assert.deepEqual(ctx.data, previous);
});

test("opening the token page successfully proceeds directly to hidden input", async () => {
  const { ctx, screens } = context(["new", "open", "org-fixture", ref]);
  let opened = 0;
  ctx.runner = async (_command, args) => {
    assert.ok(args.includes("https://supabase.com/dashboard/account/tokens"));
    opened++;
    return "";
  };
  await connect(ctx);
  assert.equal(opened, 1);
  assert.equal(
    screens.filter((screen) =>
      screen.includes("获取 Supabase Personal Access Token"),
    ).length,
    1,
  );
});

for (const status of [401, 403])
  test(`API ${status} gives a safe actionable distinct error`, async () => {
    const client = new Supabase(
      token,
      async () => new Response(token, { status }),
    );
    await assert.rejects(client.projects(), (error: Error) => {
      assert.ok(!error.message.includes(token));
      assert.match(
        error.message,
        status === 401 ? /过期|撤销|无效/ : /权限|范围/,
      );
      assert.ok(error.message.includes(status === 401 ? "重新" : "最小"));
      return true;
    });
  });

test("status reloads an API key using an in-memory PAT and the bound user/ref without any CLI", async () => {
  const { ctx, screens } = context(["status", "back", "exit"]);
  ctx.data.credentials["supabase/personal"] = token;
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "token",
    "@supabase": "supabase/personal",
    "@supabaseIdentity": uid,
    supabaseProjectRef: ref,
    supabaseUrl: `https://${ref}.supabase.co`,
  };
  ctx.runner = async (command) => {
    assert.equal(command, "gh");
    return JSON.stringify({ id: 1, login: "fixture" });
  };
  await wizard(ctx);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.supabasePublishableKey,
    key,
  );
  assert.ok(
    screens.some((screen) =>
      screen.includes("SUPABASE_PUBLISHABLE_KEY: 本机已载入（值已隐藏）"),
    ),
  );
});

test("export offers API-bound key rehydration only when a PAT is available", async () => {
  const { ctx } = context(["export", "clipboard", "back", "exit"]);
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "token",
    "@supabase": "supabase/personal",
    "@supabaseIdentity": uid,
    supabaseProjectRef: ref,
  };
  ctx.fetcher = async () => {
    throw new Error("missing PAT must not access API");
  };
  await wizard(ctx);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.["@supabaseSource"],
    "token",
  );
});

function scopedContext(answers: string[], responseStatus = 403) {
  const fixture = context(answers);
  const original = fixture.ctx.fetcher!;
  fixture.ctx.ui.input = async (message, options) => {
    if (message.includes("隐藏输入")) return "sbp_fc_fixture_scoped";
    if (message.includes("Project Ref")) return ref;
    return options?.value ?? "personal";
  };
  fixture.ctx.fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/profile")
      return new Response("private error", { status: responseStatus });
    if (path === `/v1/projects/${ref}`)
      return Response.json({
        id: ref,
        name: "fixture-project",
        organization_id: "org-fixture",
        region: "test",
        status: "INACTIVE",
      });
    return original(url, init);
  };
  return fixture;
}

test("project-scoped PAT can bind verified organization and Ref without pretending to know user identity", async () => {
  const { ctx, logs } = scopedContext(["new", "input", "org-fixture", ref]);
  await connect(ctx);
  const profile = ctx.data.profiles[projectKey("fixture", "staging")]!;
  assert.equal(profile["@supabaseIdentity"], undefined);
  assert.equal(profile["@supabaseIdentityMode"], "resource");
  assert.equal(profile["@supabaseOrganization"], "org-fixture");
  assert.match(logs.join("\n"), /用户身份.*资源范围/);
  assert.equal(profile.supabasePublishableKey, key);
});

test("scoped PAT lacking list permissions can explicitly enter Ref and validate project access", async () => {
  const { ctx } = scopedContext(["new", "input", "ref"]);
  const original = ctx.fetcher!;
  ctx.fetcher = async (url, init) => {
    if (
      ["/v1/organizations", "/v1/projects"].includes(
        new URL(String(url)).pathname,
      )
    )
      return new Response("private permission error", { status: 403 });
    return original(url, init);
  };
  await connect(ctx);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.supabaseProjectRef,
    ref,
  );
});

test("downgrading a known user binding to a resource binding requires explicit confirmation", async () => {
  const { ctx } = scopedContext(["new", "input", "org-fixture", ref]);
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "token",
    "@supabase": "supabase/old",
    "@supabaseIdentity": uid,
    supabaseProjectRef: ref,
  };
  const previous = structuredClone(ctx.data);
  let confirmations = 0;
  ctx.ui.confirm = async (message) => {
    confirmations++;
    assert.match(message, /用户身份不可读.*资源范围绑定/);
    return false;
  };
  await connect(ctx);
  assert.equal(confirmations, 1);
  assert.deepEqual(ctx.data, previous);
});

test("scoped PAT 401 never downgrades to resource verification", async () => {
  const { ctx } = scopedContext(["new", "input"], 401);
  let calls = 0;
  ctx.fetcher = async () => {
    calls++;
    return new Response("private", { status: 401 });
  };
  await assert.rejects(connect(ctx), /401.*重新/);
  assert.equal(calls, 1);
  assert.deepEqual(ctx.data, { credentials: {}, profiles: {} });
});

test("refresh of a resource binding validates its fixed organization before restoring the key", async () => {
  const { ctx } = scopedContext(["status", "back", "exit"]);
  ctx.data.credentials["supabase/personal"] = "sbp_fc_fixture_scoped";
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "token",
    "@supabase": "supabase/personal",
    "@supabaseIdentityMode": "resource",
    "@supabaseOrganization": "different-org",
    supabaseProjectRef: ref,
  };
  ctx.runner = async (command) => {
    assert.equal(command, "gh");
    return JSON.stringify({ id: 1, login: "fixture" });
  };
  await wizard(ctx);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.supabasePublishableKey,
    undefined,
  );
});

test("API key export rehydrates only the selected key and keeps the management PAT out of export choices", async () => {
  const { ctx, screens } = context(["export", "clipboard", "back", "exit"]);
  ctx.data.credentials["supabase/personal"] = token;
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "token",
    "@supabase": "supabase/personal",
    "@supabaseIdentity": uid,
    supabaseProjectRef: ref,
  };
  ctx.ui.confirm = async () => false;
  ctx.ui.check = async (_message, choices) => {
    assert.ok(
      choices.some((choice) => choice.value === "SUPABASE_PUBLISHABLE_KEY"),
    );
    assert.ok(!JSON.stringify(choices).includes(token));
    assert.ok(
      !choices.some((choice) => choice.value === "SUPABASE_ACCESS_TOKEN"),
    );
    return ["SUPABASE_PUBLISHABLE_KEY"];
  };
  await wizard(ctx);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.supabasePublishableKey,
    key,
  );
  assert.ok(!screens.join("\n").includes(token));
});

for (const action of ["project", "migrations"])
  test(`canceling managed CLI installation before ${action} avoids password prompts and CLI calls`, async () => {
    const { ctx } = context(action === "project" ? ["official"] : []);
    ctx.data.profiles[projectKey("fixture", "staging")] = {
      supabaseProjectRef: ref,
    };
    let checks = 0;
    ctx.ensureSupabaseCli = async () => {
      checks++;
      return false;
    };
    ctx.ui.input = async () => {
      throw new Error(
        "must not prompt for profile/password after installation cancellation",
      );
    };
    await modules
      .find((module) => module.id === "supabase")!
      .actions.find((entry) => entry.id === action)!
      .execute(ctx);
    assert.equal(checks, 1);
  });

test("wizard scoped migration never calls profile and blocks changed organization before apply", async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "setup-api-migration-"),
  );
  let changed = false;
  let applied = false;
  const { ctx } = scopedContext([]);
  ctx.root = root;
  ctx.data.credentials["supabase/personal"] = "sbp_fc_fixture_scoped";
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "token",
    "@supabase": "supabase/personal",
    "@supabaseIdentityMode": "resource",
    "@supabaseOrganization": "org-fixture",
    supabaseProjectRef: ref,
  };
  ctx.ui.input = async (message, options) => {
    if (options?.secret) return "fixture-db-password";
    assert.match(message, /完整输入目标/);
    return ref;
  };
  ctx.fetcher = async (url) => {
    assert.equal(new URL(String(url)).pathname, `/v1/projects/${ref}`);
    return Response.json({
      id: ref,
      organization_id: changed ? "other-org" : "org-fixture",
    });
  };
  ctx.runner = async (_command, args) => {
    if (args[0] === "--version") return "2.120.0";
    if (args.includes("--dry-run")) {
      changed = true;
      return "202610120001_initial.sql";
    }
    if (args[0] === "db") applied = true;
    return "";
  };
  try {
    await mkdir(join(root, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase/migrations/202610120001_initial.sql"),
      "select 1;",
    );
    await assert.rejects(
      modules
        .find((module) => module.id === "supabase")!
        .actions.find((entry) => entry.id === "migrations")!
        .execute(ctx),
      /项目组织与绑定不同/,
    );
    assert.equal(applied, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("temporary scoped PAT on an official user binding explains explicit resource reconnection without patching Auth", async () => {
  const { ctx } = scopedContext(["token", "input"]);
  ctx.data.profiles[projectKey("fixture", "staging")] = {
    "@supabaseSource": "cli",
    "@supabaseProfile": "bound-user",
    "@supabaseIdentity": uid,
    supabaseProjectRef: ref,
    appOrigin: "https://app.example.test",
  };
  const before = structuredClone(ctx.data);
  ctx.ui.confirm = async () => false;
  ctx.runner = async (command, args) => {
    assert.equal(command, "supabase");
    assert.ok(args.includes("whoami") && args.includes("bound-user"));
    return JSON.stringify({ id: uid, email: "fixture@example.test" });
  };
  let requests = 0;
  ctx.fetcher = async (url, init) => {
    requests++;
    assert.equal(new URL(String(url)).pathname, "/v1/profile");
    assert.notEqual(init?.method, "PATCH");
    return new Response("private permission error", { status: 403 });
  };
  await assert.rejects(
    modules
      .find((module) => module.id === "supabase")!
      .actions.find((entry) => entry.id === "auth")!
      .execute(ctx),
    /当前 scoped PAT 无法读取用户身份.*选择 API\/PAT.*资源范围绑定/,
  );
  assert.equal(requests, 1);
  assert.deepEqual(ctx.data, before);
});
