import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import {
  checkDeploymentHost,
  configureTunnel,
} from "../src/deployment-wizard.ts";
import { modules, values, type Context } from "../src/wizard.ts";
import type { CloudflareTunnels, TunnelConfig } from "../src/tunnels.ts";
const account = "a".repeat(32),
  zone = "b".repeat(32),
  ref = "c".repeat(20);
const tunnel = "11111111-2222-3333-4444-555555555555";
const origin = "https://app-staging.example.test",
  required = `${origin}/**`;
function fixture() {
  const logs: string[] = [];
  const ctx: Context = {
    root: "/synthetic",
    env: "staging",
    config: validateConfig({
      version: 1,
      project: "fixture",
      environments: ["staging"],
      deploymentTopology: "aws-tunnel",
      variables: { appOrigin: "ORIGIN" },
    }),
    data: {
      credentials: { "supabase/test": "synthetic-pat" },
      profiles: {
        [projectKey("fixture", "staging")]: {
          "@supabase": "supabase/test",
          supabaseProjectRef: ref,
          appOrigin: origin,
          cloudflareAccountId: account,
        },
      },
    },
    save: async () => {},
    runner: async () => "",
    ui: {
      select: async (_m, c) => c[0]!.value,
      input: async (_m, o) => o?.value ?? "",
      confirm: async () => true,
      check: async () => [],
      log: (s) => logs.push(s),
    },
  };
  return { ctx, logs };
}
const auth = modules
  .find((m) => m.id === "supabase")!
  .actions.find((a) => a.id === "auth")!.execute;
function authApi(
  ctx: Context,
  initial: { site_url: string; uri_allow_list: string },
  after?: { site_url: string; uri_allow_list: string },
) {
  const calls: string[] = [];
  let wrote = false;
  ctx.fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/v1/profile")
      return Response.json({
        gotrue_id: "11111111-1111-4111-8111-111111111111",
        primary_email: "fixture@example.test",
      });
    assert.ok(path.endsWith("/config/auth"));
    if (init?.method === "PATCH") {
      wrote = true;
      const body = JSON.parse(String(init.body));
      assert.equal(body.site_url, origin);
      assert.ok(
        body.uri_allow_list.includes(
          "https://existing.example.test/auth/confirm",
        ),
      );
      return Response.json({});
    }
    return Response.json(wrote ? (after ?? initial) : initial);
  };
  return calls;
}
test("Auth URL action returns verified only after readback and preserves existing callbacks", async () => {
  const { ctx } = fixture();
  const old = {
    site_url: "https://old.example.test",
    uri_allow_list: "https://existing.example.test/auth/confirm",
  };
  const calls = authApi(ctx, old, {
    site_url: origin,
    uri_allow_list: `${old.uri_allow_list},${required}`,
  });
  assert.deepEqual(await auth(ctx), { status: "verified" });
  assert.equal(calls.filter((c) => c.startsWith("PATCH")).length, 1);
  assert.equal(
    calls.filter((c) => c.endsWith("/config/auth") && c.startsWith("GET"))
      .length,
    2,
  );
});
test("matching Auth URLs are verified with a fresh read and without repeat writes or confirmations", async () => {
  const { ctx } = fixture();
  const calls = authApi(ctx, { site_url: origin, uri_allow_list: required });
  ctx.ui.confirm = async () => {
    throw new Error("must not prompt");
  };
  assert.deepEqual(await auth(ctx), { status: "verified" });
  assert.ok(!calls.some((c) => c.startsWith("PATCH")));
});
test("cancelled Auth updates, manual dashboard and stale readback cannot become verified", async () => {
  const old = {
    site_url: "https://old.example.test",
    uri_allow_list: "https://existing.example.test/auth/confirm",
  };
  const rejected = fixture();
  const calls = authApi(rejected.ctx, old);
  rejected.ctx.ui.confirm = async () => false;
  assert.deepEqual(await auth(rejected.ctx), { status: "cancelled" });
  assert.ok(!calls.some((c) => c.startsWith("PATCH")));
  const manual = fixture();
  values(manual.ctx)["@supabaseSource"] = "cli";
  manual.ctx.fetcher = async () => {
    throw new Error("must not call");
  };
  assert.equal(
    ((await auth(manual.ctx)) as { status: string }).status,
    "manual",
  );
  for (const after of [
    old,
    { site_url: origin, uri_allow_list: required },
    {
      site_url: origin,
      uri_allow_list: `${old.uri_allow_list},https://wrong.example.test/**`,
    },
  ]) {
    const f = fixture();
    authApi(f.ctx, old, after);
    const result = (await auth(f.ctx)) as { status: string };
    assert.equal(result.status, "configured");
  }
});
function tunnelApi(
  options: {
    mismatch?: "route" | "dns";
    readError?: boolean;
    writeError?: boolean;
  } = {},
) {
  let wrote = false;
  const initial: TunnelConfig = { ingress: [{ service: "http_status:404" }] };
  let current = initial;
  let reads = 0;
  const client = {
    zones: async () => [
      {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      },
    ],
    tunnels: async () => [{ id: tunnel, name: "fixture-staging" }],
    configuration: async () => {
      reads++;
      if (wrote && options.readError)
        throw new Error("synthetic-private-error");
      return options.mismatch === "route" ? initial : current;
    },
    dnsRecords: async () =>
      wrote && options.mismatch !== "dns"
        ? [
            {
              type: "CNAME",
              content: `${tunnel}.cfargotunnel.com`,
              proxied: true,
            },
          ]
        : [],
    updateIngress: async () => {
      wrote = true;
      if (options.writeError) throw new Error("synthetic-private-error");
      current = {
        ingress: [
          {
            hostname: "app-staging.example.test",
            service: "http://fixture-staging:3000",
          },
          { service: "http_status:404" },
        ],
      };
    },
    ensureDns: async () => "created",
    token: async () => "synthetic-token",
  } as unknown as CloudflareTunnels;
  return { client, reads: () => reads };
}
test("Tunnel verifies fresh ingress and proxied DNS after loading connector token, without claiming health", async () => {
  const { ctx, logs } = fixture();
  const api = tunnelApi();
  assert.deepEqual(await configureTunnel(ctx, api.client), {
    status: "verified",
  });
  assert.equal(api.reads(), 2);
  assert.equal(values(ctx).cloudflareTunnelToken, "synthetic-token");
  assert.ok(logs.join(" ").includes("健康仍待"));
  assert.ok(!logs.join(" ").includes("synthetic-token"));
});
test("Tunnel decline and partial writes never report verified even when identity or old token is saved", async () => {
  for (const stage of ["route", "token"]) {
    const { ctx } = fixture();
    values(ctx).cloudflareTunnelId = tunnel;
    values(ctx).cloudflareTunnelToken = "synthetic-old-token";
    ctx.ui.confirm = async (message) =>
      !(stage === "token"
        ? message.includes("连接 Token")
        : message.includes("应用上述"));
    assert.equal(
      (await configureTunnel(ctx, tunnelApi().client)).status,
      "cancelled",
    );
    assert.equal(values(ctx).cloudflareTunnelId, tunnel);
  }
  for (const options of [
    { mismatch: "route" as const },
    { mismatch: "dns" as const },
    { readError: true },
  ]) {
    const { ctx, logs } = fixture();
    assert.equal(
      (await configureTunnel(ctx, tunnelApi(options).client)).status,
      "configured",
    );
    assert.ok(!logs.join(" ").includes("synthetic-private-error"));
  }
  const { ctx } = fixture();
  await assert.rejects(
    configureTunnel(ctx, tunnelApi({ writeError: true }).client),
    /未全部完成/,
  );
  assert.equal(values(ctx).cloudflareTunnelId, tunnel);
});
test("SSH action returns this invocation's read-only result and cancellation is undefined", async () => {
  const { ctx } = fixture();
  values(ctx).sshTarget = "aws-light";
  ctx.ui.confirm = async () => false;
  ctx.runner = async () => {
    throw new Error("must not connect");
  };
  assert.equal(await checkDeploymentHost(ctx), undefined);
  ctx.ui.confirm = async () => true;
  ctx.runner = async () =>
    "PROJECT_SETUP_PREFLIGHT=1\narchitecture=x86_64\nmemoryMiB=2048\ndiskMiB=8192\ndockerAvailable=1\ncomposeAvailable=1\nrunningContainers=2\nlisteningPorts=22\n";
  const result = await checkDeploymentHost(ctx);
  assert.equal(result?.reachable, true);
  assert.equal(result?.facts?.architecture, "x86_64");
});

test("Auth PAT selection cancellation remains explicit and readback errors cannot leak provider output", async () => {
  const f = fixture();
  values(f.ctx)["@supabaseSource"] = "cli";
  values(f.ctx)["@supabaseIdentity"] = "11111111-1111-4111-8111-111111111111";
  f.ctx.ui.confirm = async () => false;
  f.ctx.runner = async () =>
    JSON.stringify({
      id: values(f.ctx)["@supabaseIdentity"],
      email: "fixture@example.test",
    });
  f.ctx.ui.select = async () => "back";
  assert.deepEqual(await auth(f.ctx), { status: "cancelled" });
  const failed = fixture();
  let reads = 0;
  failed.ctx.fetcher = async (url, init) => {
    if (String(url).endsWith("/profile"))
      return Response.json({
        gotrue_id: "11111111-1111-4111-8111-111111111111",
        primary_email: "fixture@example.test",
      });
    if (init?.method === "PATCH") return Response.json({});
    if (++reads === 2) throw new Error("synthetic-sensitive-readback");
    return Response.json({
      site_url: "https://old.example.test",
      uri_allow_list: "",
    });
  };
  assert.equal(
    ((await auth(failed.ctx)) as { status: string }).status,
    "configured",
  );
  assert.ok(!failed.logs.join(" ").includes("synthetic-sensitive-readback"));
});

test("connection actions preserve AbortPromptError identity and restore their original bindings", async () => {
  const { ctx } = fixture();
  const before = structuredClone(ctx.data);
  const abort = new Error("synthetic aborted prompt");
  abort.name = "AbortPromptError";
  const action = modules
    .find((m) => m.id === "cloudflare")!
    .actions.find((a) => a.id === "account")!.execute;
  ctx.ui.select = async () => {
    throw abort;
  };
  await assert.rejects(action(ctx), (error) => error === abort);
  assert.deepEqual(ctx.data, before);
});
