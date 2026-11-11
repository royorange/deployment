import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import {
  configureTunnel,
  verifyGuideTunnelConfiguration,
} from "../src/deployment-wizard.ts";
import { ApiError } from "../src/providers.ts";
import {
  tunnelConfigurationMatches,
  tunnelReadFailure,
} from "../src/tunnel-readback.ts";
import {
  CloudflareTunnels,
  mergeTunnelIngress,
  type TunnelConfig,
} from "../src/tunnels.ts";
import type { Context } from "../src/wizard.ts";

const account = "a".repeat(32),
  zoneId = "b".repeat(32);
const id = "11111111-2222-3333-4444-555555555555";
const hostname = "app-staging.example.test";
function fixture(
  change?: (config: TunnelConfig) => void,
  failure?: "configuration" | "dns",
) {
  const logs: string[] = [];
  let written = false;
  let configuration: TunnelConfig = {
    originRequest: { connectTimeout: 20 },
    ingress: [
      {
        hostname: "other.example.test",
        service: "http://other:9000",
        originRequest: { noTLSVerify: false },
      },
      { service: "http_status:404" },
    ],
  };
  const zone = {
    id: zoneId,
    name: "example.test",
    status: "active",
    account: { id: account },
  };
  const client = {
    zones: async () => [zone],
    zone: async () => zone,
    tunnels: async () => [
      { id, name: "fixture-staging", status: "inactive", remote_config: true },
    ],
    configuration: async () => {
      if (written && failure === "configuration") throw new ApiError(403);
      return structuredClone(configuration);
    },
    dnsRecords: async () => {
      if (written && failure === "dns") throw new ApiError(429);
      return written
        ? [
            {
              id: "c".repeat(32),
              name: hostname,
              type: "CNAME",
              content: `${id}.cfargotunnel.com`,
              proxied: true,
            },
          ]
        : [];
    },
    updateIngress: async (
      _a: string,
      _i: string,
      _z: string,
      host: string,
      service: string,
      old: TunnelConfig,
    ) => {
      configuration = mergeTunnelIngress(old, host, service);
      configuration["warp-routing"] = { enabled: false };
      for (const rule of configuration.ingress ?? []) rule.originRequest ??= {};
      change?.(configuration);
    },
    ensureDns: async () => {
      written = true;
    },
    token: async () => "synthetic-connector-secret",
  } as unknown as CloudflareTunnels;
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
          appOrigin: `https://${hostname}`,
        },
      },
    },
    save: async () => {},
    runner: async () => "",
    ui: {
      select: async (_m, c) => c[0]!.value,
      input: async (_m, o) => o?.value ?? "",
      check: async () => [],
      confirm: async () => true,
      log: (m) => logs.push(m),
    },
  };
  return { ctx, client, logs };
}
test("write readback accepts only empty origin options and disabled warp routing defaults", async () => {
  const f = fixture();
  assert.equal((await configureTunnel(f.ctx, f.client)).status, "verified");
  assert.equal(
    (await verifyGuideTunnelConfiguration(f.ctx, f.client)).status,
    "verified",
  );
  assert.ok(!f.logs.join(" ").includes("synthetic-connector-secret"));
});
test("semantic readback retains complete configuration and never mutates either snapshot", () => {
  const expected = {
    ingress: [
      { hostname, service: "http://fixture-staging:3000" },
      { service: "http_status:404" },
    ],
  };
  const actual = {
    ...structuredClone(expected),
    originRequest: {},
    "warp-routing": { enabled: false },
  };
  const before = structuredClone(actual);
  assert.equal(tunnelConfigurationMatches(actual, expected), true);
  assert.deepEqual(actual, before);
  assert.deepEqual(expected, {
    ingress: [
      { hostname, service: "http://fixture-staging:3000" },
      { service: "http_status:404" },
    ],
  });
  for (const [key, value] of [
    ["originRequest", null],
    ["originRequest", { noTLSVerify: false }],
    ["warp-routing", {}],
    ["unknown", {}],
  ] as const) {
    assert.equal(
      tunnelConfigurationMatches({ ...actual, [key]: value }, expected),
      false,
    );
  }
});
test("readback rejects changed routes, unrelated settings, added unknown options and security changes", async () => {
  for (const change of [
    (c: TunnelConfig) => {
      c.ingress![1]!.service = "http://unexpected:3000";
    },
    (c: TunnelConfig) => {
      c.ingress![0]!.service = "http://other:9001";
    },
    (c: TunnelConfig) => {
      c.originRequest = {};
    },
    (c: TunnelConfig) => {
      c["warp-routing"] = { enabled: true };
    },
    (c: TunnelConfig) => {
      c["warp-routing"] = { enabled: false, custom: "unknown" };
    },
    (c: TunnelConfig) => {
      c.ingress![0]!.originRequest = { noTLSVerify: true };
    },
    (c: TunnelConfig) => {
      c.ingress![1]!.path = "/restricted";
    },
  ]) {
    const f = fixture(change);
    assert.equal((await configureTunnel(f.ctx, f.client)).status, "configured");
  }
});
test("write readback and read-only checks identify failed HTTP endpoint without raw provider errors", async () => {
  for (const [failure, stage, status] of [
    ["configuration", "路由配置", 403],
    ["dns", "DNS", 429],
  ] as const) {
    const f = fixture(undefined, failure);
    const writeResult = await configureTunnel(f.ctx, f.client);
    assert.equal(writeResult.status, "configured");
    assert.match(
      writeResult.message ?? "",
      new RegExp(`${stage}.*HTTP ${status}`),
    );
    const readResult = await verifyGuideTunnelConfiguration(f.ctx, f.client);
    assert.equal(readResult.status, "configured");
    assert.match(
      readResult.message ?? "",
      new RegExp(`${stage}.*HTTP ${status}`),
    );
    assert.ok(
      !JSON.stringify([writeResult, readResult, f.logs]).includes(
        "synthetic-connector-secret",
      ),
    );
  }
});
test("read-only route verification rejects service, duplicate hostname, wildcard and path conflicts", async () => {
  for (const change of [
    (c: TunnelConfig) => {
      c.ingress![1]!.service = "http://unexpected:3000";
    },
    (c: TunnelConfig) => {
      c.ingress!.splice(1, 0, {
        hostname,
        service: "http://fixture-staging:3000",
      });
    },
    (c: TunnelConfig) => {
      c.ingress!.splice(1, 0, {
        hostname: "*.example.test",
        service: "http://other:3000",
      });
    },
    (c: TunnelConfig) => {
      c.ingress![1]!.path = "/restricted";
    },
  ]) {
    const f = fixture(change);
    await configureTunnel(f.ctx, f.client);
    const checked = await verifyGuideTunnelConfiguration(f.ctx, f.client);
    assert.equal(checked.status, "configured");
    assert.match(checked.message ?? "", /路由配置/);
  }
});
test("diagnostics never include raw exceptions and distinguish credential versus zone scopes", () => {
  assert.ok(
    !tunnelReadFailure("DNS", new Error("synthetic-raw-secret")).includes(
      "synthetic-raw-secret",
    ),
  );
  assert.match(
    tunnelReadFailure("Zone 归属", new ApiError(403)),
    /Zone Read、DNS Edit/,
  );
  assert.match(
    tunnelReadFailure("Tunnel 身份", new ApiError(403)),
    /Cloudflare Tunnel Edit/,
  );
  assert.match(
    tunnelReadFailure("路由配置", new ApiError(401)),
    /Token 可能已失效/,
  );
  assert.match(tunnelReadFailure("DNS", new ApiError(500)), /HTTP 500/);
});
