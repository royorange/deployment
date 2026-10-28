import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { modules, values, type Context } from "../src/wizard.ts";

const account = "a".repeat(32),
  zone = "b".repeat(32),
  token = "fixture-private-tunnel-management-token";
const tunnelAction = modules
  .find((module) => module.id === "deployment")!
  .actions.find((action) => action.id === "tunnel")!;
function routeFixture(answers: string[]) {
  const logs: string[] = [],
    inputs: Array<{ message: string; secret: boolean }> = [],
    commands: string[] = [];
  const ctx: Context = {
    root: "/fixture",
    config: validateConfig({
      version: 1,
      project: "fixture",
      deploymentTopology: "aws-tunnel",
      environments: ["staging"],
      variables: {},
    }),
    env: "staging",
    storageMode: "vault",
    data: {
      credentials: { "cloudflare/ci": "synthetic-ci-token" },
      profiles: {
        [projectKey("fixture", "staging")]: {
          cloudflareAccountId: account,
          cloudflareZoneId: zone,
          "@cloudflareSource": "wrangler",
          "@cloudflareProfile": "work",
          "@cloudflareIdentity": "fixture@example.org",
          "@cloudflareDeploy": "cloudflare/ci",
        },
      },
    },
    save: async () => {},
    runner: async (command) => {
      commands.push(command);
      throw new Error("synthetic official CLI failure");
    },
    ui: {
      select: async (message, choices) => {
        const answer = answers.shift() ?? choices[0]!.value;
        assert.ok(
          choices.some((choice) => choice.value === answer),
          `${message}: ${answer}`,
        );
        return answer;
      },
      input: async (message, options) => {
        inputs.push({ message, secret: options?.secret ?? false });
        return options?.secret ? token : (options?.value ?? "");
      },
      confirm: async () => false,
      check: async () => [],
      log: (message) => logs.push(message),
    },
    fetcher: async (url, options) => {
      assert.equal(
        options?.method ?? "GET",
        "GET",
        "route selection cannot write cloud resources",
      );
      const path = new URL(String(url)).pathname;
      const zoneValue = {
        id: zone,
        name: "example.org",
        status: "active",
        account: { id: account },
      };
      return Response.json({
        success: true,
        result: path.endsWith(`/zones/${zone}`)
          ? zoneValue
          : path === "/client/v4/zones"
            ? [zoneValue]
            : [],
      });
    },
  };
  return { ctx, logs, inputs, commands };
}
test("unbound Tunnel credentials require explicit selection and returning does not call Wrangler or change bindings", async () => {
  const f = routeFixture(["back"]);
  const before = structuredClone(f.ctx.data);
  await tunnelAction.execute(f.ctx);
  assert.deepEqual(f.ctx.data, before);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.inputs, []);
});
test("explicit official credential failure explains the dedicated entry and never opens an unlabelled token prompt", async () => {
  const f = routeFixture(["existing"]);
  const before = structuredClone(f.ctx.data);
  await assert.rejects(
    tunnelAction.execute(f.ctx),
    (error: Error) =>
      error.message.includes("配置专用 Tunnel 管理 Token") &&
      error.message.includes("隐藏输入"),
  );
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.inputs, []);
  assert.deepEqual(f.ctx.data, before);
});
test("explicit Wrangler reuse still validates the selected profile identity and account", async () => {
  for (const matchesIdentity of [true, false]) {
    const f = routeFixture(["existing"]);
    const before = structuredClone(f.ctx.data);
    const argsSeen: string[][] = [];
    f.ctx.runner = async (_command, args) => {
      argsSeen.push(args);
      return args.includes("whoami")
        ? JSON.stringify({
            loggedIn: true,
            email: matchesIdentity
              ? "fixture@example.org"
              : "changed@example.org",
            accounts: [{ id: account, name: "fixture" }],
          })
        : JSON.stringify({ type: "oauth", token: "synthetic-official-token" });
    };
    if (matchesIdentity) await tunnelAction.execute(f.ctx);
    else await assert.rejects(tunnelAction.execute(f.ctx), /身份已变化/);
    assert.equal(argsSeen.length, 2);
    assert.ok(argsSeen[0]!.includes("work"));
    assert.deepEqual(f.ctx.data, before);
    assert.ok(f.inputs.every((input) => !input.secret));
    assert.ok(!f.logs.join("\n").includes("synthetic-official-token"));
  }
});
test("missing bound dedicated credential never falls back to Wrangler or asks for plaintext input", async () => {
  const f = routeFixture([]);
  values(f.ctx)["@cloudflareTunnelManagement"] = "cloudflare/missing";
  await assert.rejects(
    tunnelAction.execute(f.ctx),
    /配置专用 Tunnel 管理 Token/,
  );
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.inputs, []);
});
test("inline dedicated Token selection preserves official and CI bindings and masks only the Token input", async () => {
  const f = routeFixture(["dedicated", "new"]);
  const before = { ...values(f.ctx) };
  await tunnelAction.execute(f.ctx);
  assert.equal(values(f.ctx)["@cloudflareSource"], before["@cloudflareSource"]);
  assert.equal(
    values(f.ctx)["@cloudflareProfile"],
    before["@cloudflareProfile"],
  );
  assert.equal(values(f.ctx)["@cloudflareDeploy"], before["@cloudflareDeploy"]);
  assert.equal(
    f.ctx.data.credentials[values(f.ctx)["@cloudflareTunnelManagement"]!],
    token,
  );
  assert.deepEqual(f.commands, []);
  assert.equal(f.inputs.filter((input) => input.secret).length, 1);
  assert.ok(
    f.inputs.some(
      (input) => input.secret && input.message.includes("隐藏输入"),
    ),
  );
  assert.ok(!f.logs.join("\n").includes(token));
});
test("inline dedicated Token permission failure rolls back without switching to official login", async () => {
  const f = routeFixture(["dedicated", "new"]);
  const before = structuredClone(f.ctx.data);
  f.ctx.fetcher = async () =>
    new Response("synthetic private provider body", { status: 403 });
  await assert.rejects(tunnelAction.execute(f.ctx), /403/);
  assert.deepEqual(f.ctx.data, before);
  assert.deepEqual(f.commands, []);
  assert.ok(!f.logs.join("\n").includes(token));
});
for (const denied of [false, true])
  for (const hasOrigin of [false, true])
    test(`dedicated Tunnel management token ${denied ? "rolls back on DNS denial" : "preserves official and CI credentials"}`, async () => {
      const logs: string[] = [];
      const profile = {
        cloudflareAccountId: account,
        cloudflareZoneId: zone,
        ...(hasOrigin ? { appOrigin: "https://app-staging.example.org" } : {}),
        "@cloudflareSource": "wrangler",
        "@cloudflareProfile": "work",
        "@cloudflareIdentity": "fixture@example.org",
        "@cloudflareDeploy": "cloudflare/ci",
      };
      const ctx: Context = {
        root: "/fixture",
        config: validateConfig({
          version: 1,
          project: "fixture",
          environments: ["staging"],
          variables: { cloudflareAccountId: "CF_ACCOUNT_ID" },
        }),
        env: "staging",
        storageMode: "vault",
        data: {
          credentials: { "cloudflare/ci": "fixture-ci-token" },
          profiles: { [projectKey("fixture", "staging")]: { ...profile } },
        },
        save: async () => {},
        runner: async () => "",
        ui: {
          select: async () => "new",
          input: async (_m, o) => (o?.secret ? token : (o?.value ?? "")),
          confirm: async () => true,
          check: async () => [],
          log: (m) => logs.push(m),
        },
        fetcher: async (url) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith(`/zones/${zone}`))
            return Response.json({
              success: true,
              result: {
                id: zone,
                name: "example.org",
                status: "active",
                account: { id: account },
              },
            });
          if (path.endsWith("/dns_records") && denied)
            return new Response("private-error-body", { status: 403 });
          return Response.json({ success: true, result: [] });
        },
      };
      const action = modules
        .find((m) => m.id === "deployment")!
        .actions.find((a) => a.id === "management-token")!;
      if (denied) {
        await assert.rejects(action.execute(ctx), /403/);
        assert.deepEqual(
          ctx.data.profiles[projectKey("fixture", "staging")],
          profile,
        );
        assert.deepEqual(ctx.data.credentials, {
          "cloudflare/ci": "fixture-ci-token",
        });
      } else {
        await action.execute(ctx);
        const saved = ctx.data.profiles[projectKey("fixture", "staging")]!;
        assert.deepEqual(
          { ...saved, "@cloudflareTunnelManagement": undefined },
          { ...profile, "@cloudflareTunnelManagement": undefined },
        );
        assert.equal(
          ctx.data.credentials[saved["@cloudflareTunnelManagement"]!],
          token,
        );
      }
      assert.ok(!logs.join("\n").includes(token));
      assert.ok(!logs.join("\n").includes("private-error-body"));
    });
