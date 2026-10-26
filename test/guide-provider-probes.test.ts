import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import {
  verifyGuideCloudflare,
  verifyGuideTunnel,
  values,
  type Context,
} from "../src/wizard.ts";
const account = "a".repeat(32),
  zone = "b".repeat(32),
  tunnel = "11111111-2222-3333-4444-555555555555";
function fixture() {
  const calls: string[] = [];
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
      credentials: {
        "cloudflare/account": "synthetic-general",
        "cloudflare/tunnel": "synthetic-management",
      },
      profiles: {
        [projectKey("fixture", "staging")]: {
          "@cloudflare": "cloudflare/account",
          "@cloudflareTunnelManagement": "cloudflare/tunnel",
          cloudflareAccountId: account,
          pagesProject: "fixture-web",
          cloudflareZoneId: zone,
          cloudflareTunnelId: tunnel,
          cloudflareTunnelToken: "synthetic-connector",
          appOrigin: "https://app-staging.example.test",
        },
      },
    },
    runner: async () => {
      throw new Error("unexpected CLI");
    },
    save: async () => {
      throw new Error("unexpected save");
    },
    ui: {
      select: async () => {
        throw new Error("unexpected select");
      },
      input: async () => {
        throw new Error("unexpected input");
      },
      confirm: async () => {
        throw new Error("unexpected confirm");
      },
      check: async () => {
        throw new Error("unexpected checkbox");
      },
      log: () => {},
    },
    fetcher: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      assert.equal(init?.method, "GET");
      const token = new Headers(init?.headers).get("Authorization");
      if (path.includes("/pages/projects/")) {
        assert.equal(token, "Bearer synthetic-general");
        return Response.json({
          success: true,
          result: {
            name: "fixture-web",
            production_branch: "main",
            subdomain: "fixture-web.pages.dev",
          },
        });
      }
      assert.equal(token, "Bearer synthetic-management");
      if (path.endsWith(`/zones/${zone}`))
        return Response.json({
          success: true,
          result: {
            id: zone,
            name: "example.test",
            status: "active",
            account: { id: account },
          },
        });
      if (path.endsWith("/cfd_tunnel"))
        return Response.json({
          success: true,
          result: [
            {
              id: tunnel,
              name: "fixture-staging",
              status: "inactive",
              account_tag: account,
              remote_config: true,
              deleted_at: null,
            },
          ],
        });
      if (path.endsWith("/configurations"))
        return Response.json({
          success: true,
          result: {
            config: {
              ingress: [
                {
                  hostname: "app-staging.example.test",
                  service: "http://fixture-staging:3000",
                },
                { service: "http_status:404" },
              ],
            },
          },
        });
      if (path.endsWith("/dns_records"))
        return Response.json({
          success: true,
          result: [
            {
              id: "c".repeat(32),
              name: "app-staging.example.test",
              type: "CNAME",
              content: `${tunnel}.cfargotunnel.com`,
              proxied: true,
            },
          ],
        });
      throw new Error("unexpected route");
    },
  };
  return { ctx, calls };
}
test("Cloudflare guide probe validates the bound Pages project with GET only", async () => {
  const { ctx, calls } = fixture();
  assert.deepEqual(await verifyGuideCloudflare(ctx), { status: "verified" });
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0]!.includes(`/accounts/${account}/pages/projects/fixture-web`),
  );
});
test("Cloudflare probe never falls back from absent binding or missing credential to legacy or Tunnel token", async () => {
  for (const field of ["@cloudflare", "cloudflareAccountId", "pagesProject"]) {
    const { ctx, calls } = fixture();
    delete values(ctx)[field];
    values(ctx).cloudflareToken = "synthetic-legacy";
    assert.equal((await verifyGuideCloudflare(ctx)).status, "configured");
    assert.equal(calls.length, 0);
  }
  const { ctx, calls } = fixture();
  delete ctx.data.credentials["cloudflare/account"];
  values(ctx).cloudflareToken = "synthetic-legacy";
  assert.equal((await verifyGuideCloudflare(ctx)).status, "configured");
  assert.equal(calls.length, 0);
});
test("Cloudflare probe rejects expired official login before Pages and never asks for new credentials", async () => {
  const { ctx, calls } = fixture();
  values(ctx)["@cloudflareSource"] = "wrangler";
  let cli = 0;
  ctx.runner = async () => {
    cli++;
    throw new Error("synthetic-sensitive-cli-error");
  };
  await assert.rejects(
    verifyGuideCloudflare(ctx),
    (error) =>
      error instanceof Error &&
      !error.message.includes("synthetic-sensitive-cli-error"),
  );
  assert.equal(cli, 1);
  assert.equal(calls.length, 0);
});
test("Cloudflare probe reuses and validates exact official identity/account", async () => {
  const { ctx } = fixture();
  values(ctx)["@cloudflareSource"] = "wrangler";
  values(ctx)["@cloudflareIdentity"] = "fixture@example.test";
  ctx.runner = async (_cmd, args) =>
    args.includes("token")
      ? JSON.stringify({ type: "oauth", token: "synthetic-general" })
      : JSON.stringify({
          loggedIn: true,
          email: "fixture@example.test",
          accounts: [{ id: account, name: "Fixture" }],
        });
  assert.equal((await verifyGuideCloudflare(ctx)).status, "verified");
  ctx.runner = async (_cmd, args) =>
    args.includes("token")
      ? JSON.stringify({ type: "oauth", token: "synthetic-general" })
      : JSON.stringify({
          loggedIn: true,
          email: "other@example.test",
          accounts: [{ id: account, name: "Fixture" }],
        });
  await assert.rejects(verifyGuideCloudflare(ctx));
});
test("Cloudflare probe distinguishes missing project from denied or mismatched remote resource", async () => {
  for (const response of [
    new Response("{}", { status: 403 }),
    Response.json({ success: true, result: { name: "other-project" } }),
  ]) {
    const { ctx } = fixture();
    ctx.fetcher = async () => response;
    await assert.rejects(verifyGuideCloudflare(ctx));
  }
  const { ctx } = fixture();
  ctx.fetcher = async () => new Response("{}", { status: 404 });
  assert.equal((await verifyGuideCloudflare(ctx)).status, "configured");
});
test("Tunnel guide probe confirms current dedicated identity, route and DNS without fetching token or assuming connector health", async () => {
  const { ctx, calls } = fixture();
  assert.deepEqual(await verifyGuideTunnel(ctx), { status: "verified" });
  assert.ok(calls.some((c) => c.endsWith("/configurations")));
  assert.ok(calls.some((c) => c.endsWith("/dns_records")));
  assert.ok(!calls.some((c) => c.endsWith("/token")));
});
test("Tunnel probe skips incomplete dedicated binding with no fallback, interaction or API access", async () => {
  for (const field of [
    "@cloudflareTunnelManagement",
    "cloudflareZoneId",
    "cloudflareTunnelId",
    "appOrigin",
    "cloudflareTunnelToken",
  ]) {
    const { ctx, calls } = fixture();
    delete values(ctx)[field];
    assert.equal((await verifyGuideTunnel(ctx)).status, "configured");
    assert.equal(calls.length, 0);
  }
  const { ctx, calls } = fixture();
  delete ctx.data.credentials["cloudflare/tunnel"];
  assert.equal((await verifyGuideTunnel(ctx)).status, "configured");
  assert.equal(calls.length, 0);
});
test("Tunnel probe rejects mismatched route, unproxied DNS, wrong Tunnel name and read errors", async () => {
  for (const failure of ["route", "dns", "name", "read"]) {
    const { ctx } = fixture();
    const base = ctx.fetcher!;
    ctx.fetcher = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (failure === "read") throw new Error("synthetic-sensitive-error");
      if (failure === "route" && path.endsWith("/configurations"))
        return Response.json({
          success: true,
          result: {
            config: {
              ingress: [
                {
                  hostname: "app-staging.example.test",
                  service: "http://app:3000",
                },
                { service: "http_status:404" },
              ],
            },
          },
        });
      if (failure === "dns" && path.endsWith("/dns_records"))
        return Response.json({
          success: true,
          result: [
            {
              id: "c".repeat(32),
              name: "app-staging.example.test",
              type: "CNAME",
              content: `${tunnel}.cfargotunnel.com`,
              proxied: false,
            },
          ],
        });
      if (failure === "name" && path.endsWith("/cfd_tunnel"))
        return Response.json({
          success: true,
          result: [
            {
              id: tunnel,
              name: "other-project",
              status: "inactive",
              account_tag: account,
              remote_config: true,
            },
          ],
        });
      return base(url, init);
    };
    const result = await verifyGuideTunnel(ctx);
    assert.equal(result.status, "configured");
    assert.ok(!JSON.stringify(result).includes("synthetic-sensitive-error"));
  }
});
