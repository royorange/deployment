import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, projectKey } from "../src/config.ts";
import {
  configureTunnel,
  showDeploymentPlan,
  configureDeployment,
  checkDeploymentHost,
  exportTunnelToken,
} from "../src/deployment-wizard.ts";
import type { Context } from "../src/wizard.ts";
import { CloudflareTunnels } from "../src/tunnels.ts";

const account = "a".repeat(32),
  zone = "b".repeat(32);
const tunnel = "11111111-2222-3333-4444-555555555555";
function fixture() {
  const logs: string[] = [];
  const config = validateConfig({
    version: 1,
    project: "fixture",
    deploymentTopology: "aws-tunnel",
    environments: ["staging"],
    variables: {
      appOrigin: "APP_ORIGIN",
      cloudflareTunnelToken: "TUNNEL_TOKEN",
    },
  });
  const ctx: Context = {
    root: "/fixture",
    config,
    env: "staging",
    storageMode: "vault",
    data: {
      credentials: {},
      profiles: {
        [projectKey("fixture", "staging")]: { cloudflareAccountId: account },
      },
    },
    save: async () => {},
    runner: async () => "",
    ui: {
      select: async (_m, choices) => choices[0]!.value,
      input: async (_m, options) => options?.value ?? "",
      confirm: async () => false,
      check: async () => [],
      log: (m) => logs.push(m),
    },
  };
  return { ctx, logs };
}
test("undeclared and Worker/private-origin topologies cannot be rewritten as a direct app Tunnel", async () => {
  for (const topology of [undefined, "worker-private-origin"] as const) {
    const { ctx } = fixture();
    ctx.config.deploymentTopology = topology;
    const before = structuredClone(ctx.data);
    await assert.rejects(
      configureTunnel(ctx, {} as CloudflareTunnels),
      /部署|拓扑/,
    );
    await assert.rejects(configureDeployment(ctx), /部署|拓扑/);
    assert.deepEqual(ctx.data, before);
  }
});
test("Tunnel setup previews its own environment before creating any remote resource", async () => {
  const { ctx, logs } = fixture();
  let writes = 0;
  const client = {
    zones: async () => [
      {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      },
    ],
    tunnels: async () => [],
    createTunnel: async () => {
      writes++;
      throw new Error("unexpected write");
    },
  } as unknown as CloudflareTunnels;
  await configureTunnel(ctx, client);
  assert.equal(writes, 0);
  assert.match(logs.join("\n"), /fixture-staging/);
  assert.match(logs.join("\n"), /http:\/\/app:3000/);
});
test("Tunnel setup preserves existing routes and stores token without displaying it", async () => {
  const { ctx, logs } = fixture();
  const writes: string[] = [];
  ctx.ui.confirm = async () => true;
  const original = {
    ingress: [
      { hostname: "other.example.test", service: "http://other:3000" },
      { service: "http_status:404" },
    ],
  };
  const client = {
    zones: async () => [
      {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      },
    ],
    tunnels: async () => [
      {
        id: tunnel,
        name: "fixture-staging",
        status: "inactive",
        remote_config: true,
      },
    ],
    configuration: async () => original,
    dnsRecords: async () => [],
    updateIngress: async (...args: unknown[]) => {
      assert.deepEqual(args[5], original);
      writes.push("ingress");
    },
    ensureDns: async () => {
      writes.push("dns");
      return "created";
    },
    token: async () => "fixture-sensitive-tunnel-token",
  } as unknown as CloudflareTunnels;
  await configureTunnel(ctx, client);
  assert.deepEqual(writes, ["ingress", "dns"]);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.cloudflareTunnelToken,
    "fixture-sensitive-tunnel-token",
  );
  assert.ok(!logs.join("\n").includes("fixture-sensitive-tunnel-token"));
});
test("deployment plan output never prints a stored tunnel token or cleanup key", async () => {
  const { ctx, logs } = fixture();
  Object.assign(ctx.data.profiles[projectKey("fixture", "staging")]!, {
    cloudflareTunnelToken: "fixture-tunnel-secret",
    supabaseCleanupKey: "fixture-cleanup-secret",
  });
  await showDeploymentPlan(ctx);
  const output = logs.join("\n");
  assert.ok(!output.includes("fixture-tunnel-secret"));
  assert.ok(!output.includes("fixture-cleanup-secret"));
  assert.match(output, /未就绪|缺少|未配置|missing/);
});
test("Tunnel setup rejects DNS conflicts before updating existing ingress", async () => {
  const { ctx } = fixture();
  let writes = 0;
  ctx.ui.confirm = async () => true;
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
    configuration: async () => ({ ingress: [{ service: "http_status:404" }] }),
    dnsRecords: async () => [
      { type: "A", content: "192.0.2.1", proxied: true },
    ],
    updateIngress: async () => {
      writes++;
    },
  } as unknown as CloudflareTunnels;
  await assert.rejects(configureTunnel(ctx, client), /DNS/);
  assert.equal(writes, 0);
});
test("new Tunnel IDs survive a later configuration error and errors cannot expose tokens", async () => {
  const { ctx } = fixture();
  ctx.ui.confirm = async () => true;
  let saves = 0;
  ctx.save = async () => {
    saves++;
  };
  const client = {
    zones: async () => [
      {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      },
    ],
    tunnels: async () => [],
    dnsRecords: async () => [],
    createTunnel: async () => ({ id: tunnel, name: "fixture-staging" }),
    configuration: async () => {
      throw new Error("synthetic-secret");
    },
  } as unknown as CloudflareTunnels;
  await assert.rejects(
    configureTunnel(ctx, client),
    (error) =>
      error instanceof Error &&
      /控制台/.test(error.message) &&
      !error.message.includes("synthetic-secret"),
  );
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]?.cloudflareTunnelId,
    tunnel,
  );
  assert.equal(saves, 1);
});
test("manual Zone selection is available after zone listing failure", async () => {
  const { ctx } = fixture();
  ctx.ui.input = async (message, options) =>
    message.includes("Zone ID") ? zone : (options?.value ?? "");
  let manual = 0;
  const client = {
    zones: async () => {
      throw new Error("synthetic-secret");
    },
    zone: async (_account: string, id: string) => {
      assert.equal(id, zone);
      manual++;
      return {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      };
    },
    tunnels: async () => [],
  } as unknown as CloudflareTunnels;
  await configureTunnel(ctx, client);
  assert.equal(manual, 1);
});
test("deployment host inspection requires explicit confirmation and never executes for a rejected target", async () => {
  const { ctx } = fixture();
  let calls = 0;
  ctx.runner = async () => {
    calls++;
    return "";
  };
  ctx.data.profiles[projectKey("fixture", "staging")]!.sshTarget = "aws-light";
  await checkDeploymentHost(ctx);
  assert.equal(calls, 0);
  ctx.ui.confirm = async () => true;
  ctx.data.profiles[projectKey("fixture", "staging")]!.sshTarget =
    "-oProxyCommand=secret";
  await checkDeploymentHost(ctx);
  assert.equal(calls, 0);
});
test("deployment configuration sets safe defaults and does not write blank inputs", async () => {
  const { ctx } = fixture();
  ctx.ui.input = async (message, options) =>
    message.includes("远端") ? (options?.value ?? "") : "";
  await configureDeployment(ctx);
  const current = ctx.data.profiles[projectKey("fixture", "staging")]!;
  assert.equal(current.remoteDirectory, "/opt/fixture/staging");
  assert.equal(current.deploymentRuntime, "aws-tunnel");
  assert.equal(current.syntheticFilesEnabled, "false");
  assert.equal(current.sshTarget, undefined);
});
test("token export does nothing when there is no token", async () => {
  const { ctx } = fixture();
  ctx.runner = async () => {
    throw new Error("unexpected command");
  };
  await exportTunnelToken(ctx);
});

test("token export writes exact contents privately after local Git checks and confirmation", async () => {
  const { ctx, logs } = fixture();
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "deployment-token-"),
  );
  ctx.root = root;
  ctx.data.profiles[projectKey("fixture", "staging")]!.cloudflareTunnelToken =
    "synthetic-file-token";
  ctx.ui.confirm = async () => true;
  ctx.runner = async (command, args) => {
    assert.equal(command, "git");
    if (args[0] === "ls-files") throw new Error("untracked");
    return "";
  };
  try {
    await exportTunnelToken(ctx);
    const path = join(root, ".fulcord/aws/staging/tunnel-token");
    assert.equal(await readFile(path, "utf8"), "synthetic-file-token\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(logs.join("\n").includes("synthetic-file-token"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new Tunnel selection discards a token belonging to the previous Tunnel", async () => {
  const { ctx } = fixture();
  ctx.ui.confirm = async () => true;
  Object.assign(ctx.data.profiles[projectKey("fixture", "staging")]!, {
    cloudflareTunnelId: "99999999-2222-3333-4444-555555555555",
    cloudflareTunnelToken: "stale-synthetic-token",
  });
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
      throw new Error("cannot read");
    },
  } as unknown as CloudflareTunnels;
  await assert.rejects(configureTunnel(ctx, client));
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]!.cloudflareTunnelToken,
    undefined,
  );
});

test("deployment host inspection prints strictly parsed facts after one confirmation", async () => {
  const { ctx, logs } = fixture();
  let confirmations = 0;
  ctx.data.profiles[projectKey("fixture", "staging")]!.sshTarget = "aws-light";
  ctx.ui.confirm = async () => {
    confirmations++;
    return true;
  };
  ctx.runner = async () =>
    "PROJECT_SETUP_PREFLIGHT=1\narchitecture=aarch64\nmemoryMiB=1024\ndiskMiB=4096\ndockerAvailable=1\ncomposeAvailable=1\nrunningContainers=0\nlisteningPorts=22\n";
  await checkDeploymentHost(ctx);
  assert.equal(confirmations, 1);
  assert.match(logs.join("\n"), /aarch64/);
});

test("deployment configuration rejects unsafe SSH input without saving edits", async () => {
  const { ctx } = fixture();
  ctx.ui.input = async (message) =>
    message.includes("SSH") ? "bad;secret" : "";
  await assert.rejects(configureDeployment(ctx), /sshTarget/);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "staging")]!.sshTarget,
    undefined,
  );
});

test("Tunnel route success in memory mode explicitly describes temporary token use", async () => {
  const { ctx, logs } = fixture();
  ctx.storageMode = "memory";
  ctx.ui.confirm = async () => true;
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
    configuration: async () => ({ ingress: [{ service: "http_status:404" }] }),
    dnsRecords: async () => [],
    updateIngress: async () => {},
    ensureDns: async () => "existing",
    token: async () => "synthetic-memory-token",
  } as unknown as CloudflareTunnels;
  await configureTunnel(ctx, client);
  assert.match(logs.join("\n"), /本次内存/);
  assert.equal(logs.join("\n").includes("synthetic-memory-token"), false);
});

test("Tunnel setup rejects missing account, cross-zone hosts and duplicate names", async () => {
  const { ctx } = fixture();
  const zoneValue = {
    id: zone,
    name: "example.test",
    status: "active",
    account: { id: account },
  };
  const client = {
    zones: async () => [zoneValue],
    tunnels: async () => [
      { id: tunnel, name: "fixture-staging" },
      { id: tunnel, name: "fixture-staging" },
    ],
  } as unknown as CloudflareTunnels;
  await assert.rejects(configureTunnel(ctx, client), /重复/);
  ctx.ui.input = async () => "https://app.other.test";
  await assert.rejects(configureTunnel(ctx, client), /不属于/);
  delete ctx.data.profiles[projectKey("fixture", "staging")]!
    .cloudflareAccountId;
  await assert.rejects(configureTunnel(ctx, client), /账号/);
});

test("Tunnel setup preserves a custom production origin and reuses matching DNS", async () => {
  const { ctx } = fixture();
  ctx.env = "production";
  ctx.data.profiles[projectKey("fixture", "production")] = {
    cloudflareAccountId: account,
    cloudflareTunnelId: tunnel,
    appOrigin: "https://custom.example.test",
  };
  const client = {
    zones: async () => [
      {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      },
    ],
    tunnels: async () => [{ id: tunnel, name: "fixture-production" }],
    configuration: async () => ({ ingress: [{ service: "http_status:404" }] }),
    dnsRecords: async () => [
      { type: "CNAME", content: `${tunnel}.cfargotunnel.com`, proxied: true },
    ],
  } as unknown as CloudflareTunnels;
  await configureTunnel(ctx, client);
  assert.equal(
    ctx.data.profiles[projectKey("fixture", "production")]!.appOrigin,
    "https://custom.example.test",
  );
});

test("Tunnel setup safely reports partial remote writes and token reading errors", async () => {
  const { ctx } = fixture();
  ctx.ui.confirm = async () => true;
  const base = {
    zones: async () => [
      {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      },
    ],
    tunnels: async () => [{ id: tunnel, name: "fixture-staging" }],
    configuration: async () => ({ ingress: [{ service: "http_status:404" }] }),
    dnsRecords: async () => [],
    updateIngress: async () => {},
    ensureDns: async () => {
      throw new Error("synthetic-sensitive-error");
    },
    token: async () => {
      throw new Error("synthetic-sensitive-error");
    },
  };
  await assert.rejects(
    configureTunnel(ctx, base as unknown as CloudflareTunnels),
    (error) =>
      error instanceof Error &&
      /未全部完成/.test(error.message) &&
      !error.message.includes("synthetic-sensitive-error"),
  );
  await assert.rejects(
    configureTunnel(ctx, {
      ...base,
      ensureDns: async () => "created",
    } as unknown as CloudflareTunnels),
    (error) =>
      error instanceof Error &&
      /读取/.test(error.message) &&
      !error.message.includes("synthetic-sensitive-error"),
  );
});

test("Tunnel setup does not create a new resource over conflicting DNS", async () => {
  const { ctx } = fixture();
  ctx.ui.confirm = async () => true;
  let writes = 0;
  const client = {
    zones: async () => [
      {
        id: zone,
        name: "example.test",
        status: "active",
        account: { id: account },
      },
    ],
    tunnels: async () => [],
    dnsRecords: async () => [
      { type: "A", content: "192.0.2.1", proxied: true },
    ],
    createTunnel: async () => {
      writes++;
    },
  } as unknown as CloudflareTunnels;
  await assert.rejects(configureTunnel(ctx, client), /DNS/);
  assert.equal(writes, 0);
});
