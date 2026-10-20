import assert from "node:assert/strict";
import test from "node:test";
import { deploymentPlan, checkSshHost } from "../src/deployment-plan.ts";
import type { Runner } from "../src/process.ts";

const values = {
  deploymentRuntime: "aws-tunnel",
  sshTarget: "deploy@aws-light",
  remoteDirectory: "/opt/fulcord/staging",
  deploymentImage: `ghcr.io/example/fulcord@sha256:${"a".repeat(64)}`,
  tunnelImage: `cloudflare/cloudflared@sha256:${"b".repeat(64)}`,
  appOrigin: "https://app.example.com",
  cloudflareAccountId: "1".repeat(32),
  cloudflareZoneId: "2".repeat(32),
  cloudflareTunnelId: "11111111-2222-4333-8444-555555555555",
  supabaseProjectRef: "abcdefghijklmnopqrst",
  supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
  supabasePublishableKey: "synthetic-publishable-secret",
  cloudflareTunnelToken: "synthetic-tunnel-secret",
};

test("deployment plan defaults to staging and only exposes approved public values", () => {
  const plan = deploymentPlan("fulcord", undefined, {
    ...values,
    apiToken: "synthetic-provider-secret",
    supabaseCleanupKey: "synthetic-cleanup-secret",
  });
  assert.equal(plan.environment, "staging");
  assert.equal(plan.ready, true);
  assert.equal(plan.publicValues.syntheticFilesEnabled, "false");
  for (const value of [
    values.supabasePublishableKey,
    values.cloudflareTunnelToken,
    "synthetic-provider-secret",
    "synthetic-cleanup-secret",
  ])
    assert.equal(JSON.stringify(plan).includes(value), false);
  assert.equal(
    plan.checks.some(
      (check) => check.id === "remoteDeployment" && check.status === "unknown",
    ),
    true,
  );
});

test("production is only selected explicitly and unsafe metadata is never reflected", () => {
  assert.equal(
    deploymentPlan("fulcord", "production", values).environment,
    "production",
  );
  const plan = deploymentPlan("secret;project", "secret;environment", values);
  assert.equal(plan.ready, false);
  assert.equal(JSON.stringify(plan).includes("secret;"), false);
});

test("missing and invalid plan fields fail readiness without leaking their values", () => {
  const invalid: Record<string, string[]> = {
    deploymentRuntime: ["workers"],
    sshTarget: [
      "-oProxyCommand=secret",
      "host;secret",
      "host\nsecret",
      "root@host $(secret)",
      "user@host..com",
    ],
    remoteDirectory: [
      "/",
      "/etc/fulcord",
      "/opt/../etc",
      "/opt/ful cord",
      "/opt/secret;command",
      "/opt",
    ],
    deploymentImage: ["ghcr.io/example/app:latest", "ghcr.io/x@sha256:short"],
    tunnelImage: [
      "evil/cloudflared@sha256:" + "a".repeat(64),
      "cloudflare/cloudflared:latest",
    ],
    appOrigin: [
      "http://app.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://app.workers.dev",
      "https://user:secret@app.example.com",
      "https://app.example.com/path",
      "https://app.example.com?secret",
    ],
    cloudflareAccountId: ["secret"],
    cloudflareZoneId: ["secret"],
    cloudflareTunnelId: ["secret"],
    supabaseProjectRef: ["secret"],
    supabaseUrl: ["https://different.supabase.co"],
    syntheticFilesEnabled: ["yes"],
  };
  for (const [field, entries] of Object.entries(invalid)) {
    for (const value of ["", ...entries]) {
      const plan = deploymentPlan("fulcord", "staging", {
        ...values,
        [field]: value,
      });
      assert.equal(plan.ready, false, `${field}: ${value}`);
      assert.equal(
        plan.checks.find((check) => check.id === field)?.status,
        "missing",
      );
      assert.equal(Object.values(plan.publicValues).includes(value), false);
    }
  }
  for (const field of ["supabasePublishableKey", "cloudflareTunnelToken"])
    assert.equal(
      deploymentPlan("fulcord", "staging", { ...values, [field]: " " }).ready,
      false,
    );
});

test("synthetic file operations require their cleanup key", () => {
  assert.equal(
    deploymentPlan("fulcord", "staging", {
      ...values,
      syntheticFilesEnabled: "true",
    }).ready,
    false,
  );
  assert.equal(
    deploymentPlan("fulcord", "staging", {
      ...values,
      syntheticFilesEnabled: "true",
      supabaseCleanupKey: "synthetic-cleanup",
    }).ready,
    false,
  );
  assert.equal(
    deploymentPlan("fulcord", "staging", {
      ...values,
      syntheticFilesEnabled: "true",
      cleanupEnabled: "true",
      supabaseCleanupKey: "synthetic-cleanup",
    }).ready,
    true,
  );
});

test("independent cleanup requires a key and only accepts explicit boolean values", () => {
  assert.equal(
    deploymentPlan("fulcord", "staging", { ...values, cleanupEnabled: "true" })
      .ready,
    false,
  );
  assert.equal(
    deploymentPlan("fulcord", "staging", {
      ...values,
      cleanupEnabled: "true",
      supabaseCleanupKey: "synthetic-key",
    }).ready,
    true,
  );
  assert.equal(
    deploymentPlan("fulcord", "staging", { ...values, cleanupEnabled: "yes" })
      .ready,
    false,
  );
});

const output =
  "PROJECT_SETUP_PREFLIGHT=1\narchitecture=aarch64\nmemoryMiB=1024\ndiskMiB=8192\ndockerAvailable=1\ncomposeAvailable=1\nrunningContainers=2\nlisteningPorts=22,443\n";

test("SSH preflight uses strict host keys and a fixed read-only stdin script", async () => {
  const runner: Runner = async (command, args, options) => {
    assert.equal(command, "ssh");
    assert.deepEqual(args, [
      "-oBatchMode=yes",
      "-oStrictHostKeyChecking=yes",
      "-oConnectTimeout=10",
      "-oConnectionAttempts=1",
      "-oClearAllForwardings=yes",
      "-oForwardAgent=no",
      "-oPermitLocalCommand=no",
      "-T",
      "--",
      "deploy@aws-light",
      "sh",
      "-s",
    ]);
    assert.equal(options?.timeout, 30_000);
    assert.match(options?.input ?? "", /docker ps/);
    assert.doesNotMatch(
      options?.input ?? "",
      /sudo|inspect|keyscan|\.env|install/,
    );
    return output;
  };
  const result = await checkSshHost("deploy@aws-light", runner);
  assert.equal(result.reachable, true);
  assert.deepEqual(result.facts?.listeningPorts, [22, 443]);
  assert.equal(result.facts?.runningContainers, 2);
});

test("SSH invalid targets are blocked and all command failures are redacted", async () => {
  let called = false;
  const result = await checkSshHost(
    "-oProxyCommand=synthetic-secret",
    async () => {
      called = true;
      return output;
    },
  );
  assert.equal(called, false);
  assert.equal(result.reachable, false);
  const failure = await checkSshHost("aws-light", async () => {
    throw new Error("synthetic-secret");
  });
  assert.equal(failure.reachable, false);
  assert.equal(JSON.stringify(failure).includes("synthetic-secret"), false);
});

test("SSH parser rejects extra data, malformed and out-of-range fields without reflecting stdout", async () => {
  for (const malformed of [
    output + "secret=synthetic-secret\n",
    output + "architecture=x86_64\n",
    output.replace("1024", "NaN"),
    output.replace("22,443", "22,70000"),
    output.replace("aarch64", "synthetic-secret"),
    "synthetic-secret",
  ]) {
    const result = await checkSshHost("aws-light", async () => malformed);
    assert.equal(result.reachable, true);
    assert.equal(result.facts, undefined);
    assert.equal(result.checks[0]?.status, "unknown");
    assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  }
});

test("SSH reports unavailable tooling and small hosts as missing or unknown", async () => {
  const result = await checkSshHost("aws-light", async () =>
    output
      .replace("dockerAvailable=1", "dockerAvailable=0")
      .replace("composeAvailable=1", "composeAvailable=0")
      .replace("memoryMiB=1024", "memoryMiB=256")
      .replace("diskMiB=8192", "diskMiB=512"),
  );
  assert.equal(
    result.checks.find((check) => check.id === "docker")?.status,
    "missing",
  );
  assert.equal(
    result.checks.find((check) => check.id === "memory")?.status,
    "unknown",
  );
});
