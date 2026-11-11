import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./guide-fixture.ts";
import { values } from "../src/wizard.ts";
import {
  configurePrivateOrigin,
  verifyPrivateOrigin,
} from "../src/private-origin-wizard.ts";

async function scenario(confirm = true) {
  const f = await fixture([]);
  const p = values(f.ctx),
    account = "a".repeat(32),
    zone = "b".repeat(32),
    id = "11111111-1111-1111-1111-111111111111";
  Object.assign(p, {
    cloudflareAccountId: account,
    cloudflareZoneId: zone,
    appOrigin: "https://staging.example.com",
    privateOrigin: "https://api-staging.example.com",
    workerName: "fixture-edge",
    "@cloudflareTunnelManagement": "cf",
  });
  f.ctx.config.deploymentTopology = "worker-private-origin";
  f.ctx.data.credentials.cf = "fixture-private-management";
  f.ctx.ui.confirm = async () => confirm;
  const records: Record<string, unknown>[] = [];
  const tokens: Record<string, unknown>[] = [];
  const apps: Record<string, unknown>[] = [];
  const policies: Record<string, unknown>[] = [];
  const tunnels: Record<string, unknown>[] = [];
  let config: unknown = null,
    writes = 0,
    saves = 0;
  f.ctx.save = async () => {
    saves++;
  };
  f.ctx.fetcher = async (url, options) => {
    const path = new URL(String(url)).pathname.replace("/client/v4", ""),
      method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (method !== "GET") writes++;
    let result: unknown;
    if (path === `/zones/${zone}`)
      result = {
        id: zone,
        name: "example.com",
        status: "active",
        account: { id: account },
      };
    else if (path.endsWith("/dns_records")) {
      if (method === "POST") records.push({ ...body, id: "c".repeat(32) });
      result = method === "POST" ? records[0] : records;
    } else if (path.endsWith("/cfd_tunnel")) {
      if (method === "POST")
        tunnels.push({
          id,
          name: "fixture-staging",
          remote_config: true,
          account_tag: account,
          status: "inactive",
        });
      result = method === "POST" ? tunnels[0] : tunnels;
    } else if (path.endsWith(`/cfd_tunnel/${id}`)) result = tunnels[0];
    else if (path.endsWith("/configurations")) {
      if (method === "PUT") config = body.config;
      result = { config, version: config ? 1 : 0 };
    } else if (path.endsWith("/token")) result = "fixture-connector";
    else if (path.endsWith("/service_tokens")) {
      if (method === "POST")
        tokens.push({
          id: "service-id",
          name: "fixture-staging",
          client_id: "fixture-client",
          client_secret: "fixture-service-secret",
          enabled: true,
        });
      result = method === "POST" ? tokens[0] : tokens;
    } else if (path.endsWith("/apps")) {
      if (method === "POST") apps.push({ ...body, id: "application-id" });
      result = method === "POST" ? apps[0] : apps;
    } else if (path.endsWith("/policies")) {
      if (method === "POST") policies.push({ ...body, id: "policy-id" });
      result = method === "POST" ? policies[0] : policies;
    } else throw new Error("unexpected fixture API path");
    return Response.json({ success: true, result });
  };
  return {
    ...f,
    p,
    stats: () => ({
      writes,
      saves,
      tunnels: tunnels.length,
      tokens: tokens.length,
      apps: apps.length,
    }),
    policies,
  };
}
test("private-origin wizard provisions isolated Access before route, persists identities and re-verifies without duplicate resources", async () => {
  const f = await scenario();
  try {
    assert.equal((await configurePrivateOrigin(f.ctx)).status, "verified");
    const before = f.stats();
    assert.equal(before.tunnels, 1);
    assert.equal(before.tokens, 1);
    assert.equal(before.apps, 1);
    assert.ok(before.saves >= 3);
    assert.equal((await verifyPrivateOrigin(f.ctx)).status, "verified");
    assert.equal(f.stats().writes, before.writes);
    assert.equal((await configurePrivateOrigin(f.ctx)).status, "verified");
    assert.equal(f.stats().tokens, 1);
    assert.equal(f.stats().tunnels, 1);
    assert.ok(!f.messages.join("").includes("fixture-service-secret"));
    f.policies.push({ decision: "bypass", include: [{ everyone: {} }] });
    await assert.rejects(() => verifyPrivateOrigin(f.ctx), /Access/);
  } finally {
    await f.cleanup();
  }
});
test("cancellation and target changes during confirmation do not mutate resources", async () => {
  const f = await scenario(false);
  try {
    assert.equal((await configurePrivateOrigin(f.ctx)).status, "cancelled");
    assert.equal(f.stats().writes, 0);
    f.ctx.ui.confirm = async () => {
      f.p.privateOrigin = "https://other.example.com";
      return true;
    };
    await assert.rejects(() => configurePrivateOrigin(f.ctx), /变化/);
    assert.equal(f.stats().writes, 0);
  } finally {
    await f.cleanup();
  }
});
