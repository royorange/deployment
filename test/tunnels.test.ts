import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudflareTunnels, mergeTunnelIngress } from "../src/tunnels.ts";

const account = "a".repeat(32);
const zoneId = "b".repeat(32);
const tunnelId = "12345678-1234-1234-1234-123456789abc";
const zone = {
  id: zoneId,
  name: "example.com",
  status: "active",
  account: { id: account },
};
const tunnel = {
  id: tunnelId,
  name: "test-api",
  account_tag: account,
  remote_config: true,
  status: "inactive",
  token: "sensitive-token",
  credentials_file: { TunnelSecret: "sensitive-token" },
};
const result = (value: unknown, pages = 1) =>
  Response.json({
    success: true,
    result: value,
    result_info: { total_pages: pages },
  });

test("tunnel API pins host, paginates account-scoped zones and remotely managed tunnels without secrets", async () => {
  const calls: string[] = [];
  const api = new CloudflareTunnels("fixture", async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.cloudflare.com");
    assert.equal(init?.redirect, "error");
    calls.push(parsed.pathname + parsed.search);
    return result(
      parsed.searchParams.get("page") === "1"
        ? [parsed.pathname.endsWith("zones") ? zone : tunnel]
        : [],
      2,
    );
  });
  assert.deepEqual(await api.zones(account), [zone]);
  const tunnels = await api.tunnels(account);
  assert.equal(tunnels.length, 1);
  assert.ok(!JSON.stringify(tunnels).includes("sensitive-token"));
  assert.ok(calls[0]?.includes(`account.id=${account}`));
  assert.equal(calls.length, 4);
});

test("tunnel creation uses remote configuration and token is returned only by its explicit endpoint", async () => {
  const api = new CloudflareTunnels("fixture", async (url, init) => {
    if (String(url).endsWith("/token"))
      return result("synthetic-connector-token");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      name: "test-api",
      config_src: "cloudflare",
    });
    return result(tunnel);
  });
  assert.deepEqual(await api.createTunnel(account, "test-api"), {
    id: tunnelId,
    name: "test-api",
    status: "inactive",
    remote_config: true,
  });
  assert.equal(await api.token(account, tunnelId), "synthetic-connector-token");
});

test("ingress merge preserves unrelated routes and origin settings with final 404", () => {
  const current = {
    originRequest: { connectTimeout: 20 },
    ingress: [
      {
        hostname: "other.example.com",
        service: "http://other:8080",
        originRequest: { httpHostHeader: "other" },
      },
      { service: "http_status:404" },
    ],
  };
  const planned = mergeTunnelIngress(
    current,
    "api.example.com",
    "http://app:3000",
  );
  assert.deepEqual(planned.ingress, [
    current.ingress[0],
    { hostname: "api.example.com", service: "http://app:3000" },
    current.ingress[1],
  ]);
  assert.deepEqual(planned.originRequest, current.originRequest);
  assert.equal(current.ingress.length, 2);
  assert.deepEqual(mergeTunnelIngress({}, "api.example.com").ingress, [
    { hostname: "api.example.com", service: "http://app:3000" },
    { service: "http_status:404" },
  ]);
  assert.throws(
    () =>
      mergeTunnelIngress(
        { ingress: [{ service: "http://unrelated:3000" }] },
        "api.example.com",
      ),
    /404/,
  );
  assert.throws(
    () =>
      mergeTunnelIngress(
        {
          ingress: [
            {
              hostname: "api.example.com",
              path: "/a",
              service: "http://app:3000",
            },
            { service: "http_status:404" },
          ],
        },
        "api.example.com",
      ),
    /冲突/,
  );
});

test("ingress writes revalidate zone and reviewed configuration before PUT", async () => {
  const current = { ingress: [{ service: "http_status:404" }] };
  const calls: string[] = [];
  const api = new CloudflareTunnels("fixture", async (url, init) => {
    calls.push(init?.method ?? "GET");
    if (String(url).includes(`/zones/${zoneId}`)) return result(zone);
    if (init?.method === "PUT") {
      assert.deepEqual(JSON.parse(String(init.body)), {
        config: mergeTunnelIngress(current, "api.example.com"),
      });
      return result({});
    }
    return result({ config: current });
  });
  await api.updateIngress(
    account,
    tunnelId,
    zoneId,
    "api.example.com",
    "http://app:3000",
    current,
  );
  assert.deepEqual(calls, ["GET", "GET", "PUT"]);
  await assert.rejects(
    api.updateIngress(
      account,
      tunnelId,
      zoneId,
      "api.example.com",
      "http://app:3000",
      {},
    ),
    /变化/,
  );
});

test("DNS creates only absent proxied CNAME and refuses every conflicting existing record", async () => {
  for (const existing of [
    [],
    [
      {
        id: "c".repeat(32),
        name: "api.example.com",
        type: "CNAME",
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      },
    ],
    [
      {
        id: "c".repeat(32),
        name: "api.example.com",
        type: "A",
        content: "192.0.2.1",
        proxied: true,
      },
    ],
  ]) {
    let writes = 0;
    const api = new CloudflareTunnels("fixture", async (url, init) => {
      if (String(url).endsWith(`/zones/${zoneId}`)) return result(zone);
      if (init?.method === "POST") {
        writes++;
        assert.deepEqual(JSON.parse(String(init.body)), {
          type: "CNAME",
          name: "api.example.com",
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
          ttl: 1,
        });
        return result({});
      }
      return result(existing);
    });
    if (existing[0]?.type === "A")
      await assert.rejects(
        api.ensureDns(account, zoneId, "api.example.com", tunnelId),
        /冲突/,
      );
    else
      assert.equal(
        await api.ensureDns(account, zoneId, "api.example.com", tunnelId),
        existing.length ? "existing" : "created",
      );
    assert.equal(writes, existing.length ? 0 : 1);
  }
});

test("invalid identifiers, hosts and origins are rejected before requests", async () => {
  let calls = 0;
  const api = new CloudflareTunnels("fixture", async () => {
    calls++;
    return result(zone);
  });
  await assert.rejects(api.zones("bad"), /Account/);
  await assert.rejects(api.zone(account, "bad"), /Zone/);
  await assert.rejects(api.token(account, "bad"), /Tunnel/);
  await assert.rejects(api.createTunnel(account, "bad/name"), /名称/);
  for (const host of [
    "localhost",
    "127.0.0.1",
    "https://api.example.com",
    "*.example.com",
    "api.example.com.",
    "api..example.com",
    "a.example.com/path",
  ])
    assert.throws(() => mergeTunnelIngress({}, host), /域名/);
  for (const service of [
    "https://app:3000",
    "http://evil.example.com:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "file:///etc/passwd",
    "http://app:0",
    "http://app:65536",
    "http://app:3000/path",
    "http://app:3000@evil",
  ])
    assert.throws(
      () => mergeTunnelIngress({}, "api.example.com", service),
      /服务/,
    );
  assert.equal(calls, 0);
});

test("zone ownership, inactive zones and non-zone hosts fail closed", async () => {
  for (const value of [
    { ...zone, account: { id: "c".repeat(32) } },
    { ...zone, status: "pending" },
  ]) {
    const api = new CloudflareTunnels("fixture", async () => result(value));
    await assert.rejects(api.zone(account, zoneId), /归属|激活/);
  }
  const api = new CloudflareTunnels("fixture", async () => result(zone));
  await assert.rejects(
    api.dnsRecords(account, zoneId, "badexample.com"),
    /区域/,
  );
});

test("permission and write failures never leak tokens, masquerade as absence, or retry", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let calls = 0;
    const api = new CloudflareTunnels("sensitive-token", async () => {
      calls++;
      return new Response("sensitive-token", { status });
    });
    await assert.rejects(
      api.createTunnel(account, "test-api"),
      (error: Error) =>
        error.message.includes(String(status)) &&
        !error.message.includes("sensitive-token"),
    );
    assert.equal(calls, 1);
  }
});

test("malformed and excessive list/config/token responses fail closed", async () => {
  for (const body of [
    { success: false, result: [], errors: ["sensitive-token"] },
    { success: true, result: "sensitive-token" },
    { success: true, result: [], result_info: { total_pages: -1 } },
  ]) {
    const api = new CloudflareTunnels("fixture", async () =>
      Response.json(body),
    );
    await assert.rejects(
      api.zones(account),
      (error: Error) => !error.message.includes("sensitive-token"),
    );
  }
  let calls = 0;
  const api = new CloudflareTunnels("fixture", async () => {
    calls++;
    return result([], 21);
  });
  await assert.rejects(api.tunnels(account), /分页超过/);
  assert.equal(calls, 20);
  for (const bad of [null, "sensitive-token", { ingress: [null] }]) {
    const malformed = new CloudflareTunnels("fixture", async () =>
      result({ config: bad }),
    );
    await assert.rejects(
      malformed.configuration(account, tunnelId),
      /配置响应/,
    );
  }
  const malformed = new CloudflareTunnels("fixture", async () =>
    result("sensitive token\n"),
  );
  await assert.rejects(
    malformed.token(account, tunnelId),
    (error: Error) => !error.message.includes("sensitive token"),
  );
  const denied = new CloudflareTunnels(
    "fixture",
    async () => new Response("sensitive-token", { status: 403 }),
  );
  await assert.rejects(denied.configuration(account, tunnelId), /403/);
});

test("existing route updates retain its options while wildcard/catch-all conflicts are rejected", () => {
  const current = {
    ingress: [
      {
        hostname: "api.example.com",
        service: "http://app:3000",
        originRequest: { connectTimeout: 10 },
      },
      { service: "http_status:404" },
    ],
  };
  const planned = mergeTunnelIngress(
    current,
    "api.example.com",
    "http://api:4000",
  );
  assert.deepEqual(planned.ingress?.[0], {
    ...current.ingress[0],
    service: "http://api:4000",
  });
  assert.equal(current.ingress[0]?.service, "http://app:3000");
  for (const rules of [
    [
      { hostname: "*.example.com", service: "http://other:3000" },
      { service: "http_status:404" },
    ],
    [{ service: "http://other:3000" }, { service: "http_status:404" }],
  ])
    assert.throws(
      () => mergeTunnelIngress({ ingress: rules }, "api.example.com"),
      /冲突|提前匹配/,
    );
});
