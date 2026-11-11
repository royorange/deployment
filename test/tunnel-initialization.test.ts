import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { configureTunnel } from "../src/deployment-wizard.ts";
import { CloudflareTunnels } from "../src/tunnels.ts";
import { values, type Context } from "../src/wizard.ts";
const account = "a".repeat(32),
  zoneId = "b".repeat(32);
const id = "11111111-2222-3333-4444-555555555555";
function fixture(
  options: { existing?: boolean; failure?: number; decline?: boolean } = {},
) {
  let exists = !!options.existing;
  let config: unknown = null;
  let dns = false;
  const calls: string[] = [],
    logs: string[] = [],
    confirmations: string[] = [];
  const remote = {
    id,
    name: "fixture-staging",
    account_tag: account,
    remote_config: true,
    status: "inactive",
  };
  const zone = {
    id: zoneId,
    name: "example.test",
    status: "active",
    account: { id: account },
  };
  const response = (result: unknown) =>
    Response.json({ success: true, result, result_info: { total_pages: 1 } });
  const client = new CloudflareTunnels(
    "synthetic-manager",
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path.endsWith("/configurations")) {
        if (options.failure)
          return new Response("synthetic-sensitive-provider-error", {
            status: options.failure,
          });
        if (method === "PUT") config = JSON.parse(String(init?.body)).config;
        return response({
          config,
          version: config ? 1 : 0,
          account_id: account,
          tunnel_id: id,
        });
      }
      if (path.endsWith("/cfd_tunnel")) {
        if (method === "POST") {
          exists = true;
          return response(remote);
        }
        return response(exists ? [remote] : []);
      }
      if (path.endsWith(`/cfd_tunnel/${id}`)) return response(remote);
      if (path.endsWith("/token")) return response("synthetic-connector");
      if (path.endsWith("/dns_records")) {
        if (method === "POST") {
          dns = true;
          return response({});
        }
        return response(
          dns
            ? [
                {
                  id: "c".repeat(32),
                  name: "app-staging.example.test",
                  type: "CNAME",
                  content: `${id}.cfargotunnel.com`,
                  proxied: true,
                },
              ]
            : [],
        );
      }
      if (path.endsWith(`/zones/${zoneId}`)) return response(zone);
      if (path.endsWith("/zones")) return response([zone]);
      throw new Error("unexpected endpoint");
    },
  );
  const ctx: Context = {
    root: "/synthetic",
    env: "staging",
    storageMode: "vault",
    config: validateConfig({
      version: 1,
      project: "fixture",
      environments: ["staging"],
      deploymentTopology: "aws-tunnel",
      variables: { appOrigin: "ORIGIN" },
    }),
    data: {
      credentials: {},
      profiles: {
        [projectKey("fixture", "staging")]: {
          cloudflareAccountId: account,
          appOrigin: "https://app-staging.example.test",
          ...(options.existing ? { cloudflareTunnelId: id } : {}),
        },
      },
    },
    save: async () => {},
    runner: async () => "",
    ui: {
      select: async (_m, c) => c[0]!.value,
      input: async (_m, o) => o?.value ?? "",
      check: async () => [],
      confirm: async (message) => {
        confirmations.push(message);
        return !(options.decline && message.includes("初始化"));
      },
      log: (message) => logs.push(message),
    },
  };
  return { ctx, client, calls, logs, confirmations };
}
test("new remote Tunnel receives explicit initial route configuration before DNS and connector token", async () => {
  const f = fixture();
  assert.equal((await configureTunnel(f.ctx, f.client)).status, "verified");
  assert.equal(
    f.calls.filter((c) => c.startsWith("POST") && c.endsWith("/cfd_tunnel"))
      .length,
    1,
  );
  assert.ok(f.confirmations.some((m) => m.includes("初始化")));
  assert.equal(values(f.ctx).cloudflareTunnelToken, "synthetic-connector");
  assert.ok(!f.logs.join(" ").includes("synthetic-connector"));
});
test("saved uninitialized Tunnel resumes without creating another resource, and initialization can be declined", async () => {
  for (const decline of [false, true]) {
    const f = fixture({ existing: true, decline });
    const result = await configureTunnel(f.ctx, f.client);
    assert.equal(result.status, decline ? "cancelled" : "verified");
    assert.ok(
      !f.calls.some((c) => c.startsWith("POST") && c.endsWith("/cfd_tunnel")),
    );
    if (decline)
      assert.ok(
        !f.calls.some((c) => c.startsWith("PUT") || c.endsWith("/token")),
      );
    assert.equal(values(f.ctx).cloudflareTunnelId, id);
  }
});
test("configuration read failures report HTTP status and retain ID without treating errors as empty configuration", async () => {
  for (const failure of [401, 403, 404, 429, 500]) {
    const f = fixture({ existing: true, failure });
    await assert.rejects(
      configureTunnel(f.ctx, f.client),
      (error) =>
        error instanceof Error &&
        error.message.includes(`HTTP ${failure}`) &&
        !error.message.includes("synthetic-sensitive-provider-error"),
    );
    assert.ok(
      !f.calls.some((c) => c.startsWith("PUT") || c.endsWith("/token")),
    );
    assert.equal(values(f.ctx).cloudflareTunnelId, id);
  }
});
