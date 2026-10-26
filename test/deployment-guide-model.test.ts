import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deploymentGuideStages,
  guideBinding,
} from "../src/deployment-guide-model.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  version: 1,
  project: "fixture",
  repository: "owner/repo",
  deploymentTopology: "aws-tunnel",
  migrationStrategy: "supabase-cli",
  environments: ["staging"],
  variables: {
    cloudflareAccountId: "CF_ACCOUNT_ID",
    supabaseProjectRef: "SUPABASE_PROJECT_REF",
    supabaseUrl: "SUPABASE_URL",
    supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
    cloudflareTunnelId: "CF_TUNNEL_ID",
    cloudflareTunnelToken: "CF_TUNNEL_TOKEN",
    appOrigin: "APP_ORIGIN",
    deploymentImage: "APP_IMAGE",
  },
  setup: { auth: "supabase" },
  release: {
    adapter: "deploy/release.mts",
    ciWorkflow: "ci.yml",
    environments: ["staging"],
    components: [
      {
        id: "application",
        label: "App",
        kind: "application",
        requiresDevice: true,
        migrations: "supabase-cli",
      },
      {
        id: "pages",
        label: "Pages",
        kind: "pages",
        requiresDevice: false,
        migrations: "none",
      },
    ],
  },
};
const device = {
  id: "target",
  label: "Host",
  host: "192.0.2.10",
  user: "deploy",
  port: 22,
};
const values = {
  cloudflareAccountId: "a".repeat(32),
  supabaseProjectRef: "abcdefghijklmnopqrst",
  supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
  supabasePublishableKey: "sb_publishable_fixture",
  cloudflareTunnelId: "12345678-1234-1234-1234-123456789abc",
  cloudflareTunnelToken: "synthetic-token",
  appOrigin: "https://staging.example.com",
};
test("deployment stages are declarative, local inputs do not establish remote success", () => {
  const stages = deploymentGuideStages({ config, values, device });
  assert.deepEqual(
    stages.map((item) => item.id),
    [
      "import",
      "cloudflare",
      "device",
      "configuration",
      "tunnel",
      "supabase",
      "auth",
      "application",
      "pages",
      "acceptance",
    ],
  );
  assert.equal(
    stages.find((item) => item.id === "device")?.state,
    "configured",
  );
  assert.equal(
    stages.find((item) => item.id === "supabase")?.state,
    "configured",
  );
  assert.equal(
    stages.find((item) => item.id === "application")?.state,
    "missing",
  );
  assert.equal(
    stages.find((item) => item.id === "acceptance")?.state,
    "manual",
  );
  assert.equal(
    deploymentGuideStages({
      config,
      values,
      device,
      evidence: { tunnel: "verified", auth: "blocked" },
    }).find((item) => item.id === "tunnel")?.state,
    "verified",
  );
  assert.equal(
    deploymentGuideStages({
      config,
      values,
      device,
      evidence: { auth: "blocked" },
    }).find((item) => item.id === "auth")?.state,
    "blocked",
  );
});
test("unneeded provider/device/auth phases are omitted without inventing app deployment", () => {
  const onlyPages: Config = {
    ...config,
    deploymentTopology: undefined,
    variables: { pagesProject: "PAGES_PROJECT" },
    setup: { auth: "none" },
    release: {
      ...config.release!,
      components: [config.release!.components[1]!],
    },
  };
  assert.deepEqual(
    deploymentGuideStages({ config: onlyPages, values: {} }).map(
      (item) => item.id,
    ),
    ["import", "cloudflare", "configuration", "pages", "acceptance"],
  );
});
test("binding changes with public targets and commit/device, never secret values", () => {
  const binding = guideBinding(config, values, device, "a".repeat(40));
  assert.equal(
    guideBinding(
      config,
      {
        ...values,
        supabasePublishableKey: "rotated",
        cloudflareTunnelToken: "rotated",
      },
      device,
      "a".repeat(40),
    ),
    binding,
  );
  for (const changed of [
    { ...values, appOrigin: "https://other.example.com" },
    { ...values, supabaseProjectRef: "other-ref" },
    { ...values, cloudflareAccountId: "b".repeat(32) },
  ])
    assert.notEqual(
      guideBinding(config, changed, device, "a".repeat(40)),
      binding,
    );
  assert.notEqual(
    guideBinding(config, values, { ...device, port: 2222 }, "a".repeat(40)),
    binding,
  );
  assert.notEqual(
    guideBinding(config, values, device, "b".repeat(40)),
    binding,
  );
  for (const field of [
    "@cloudflareSource",
    "@cloudflareProfile",
    "@cloudflareIdentity",
    "@cloudflare",
    "@cloudflareDeploy",
    "@cloudflareTunnelManagement",
    "@supabaseSource",
    "@supabaseProfile",
    "@supabaseIdentity",
    "@supabase",
  ])
    assert.notEqual(
      guideBinding(
        config,
        { ...values, [field]: "new-public-binding" },
        device,
        "a".repeat(40),
      ),
      binding,
    );
  assert.equal(
    guideBinding(
      config,
      { ...values, "@credentialValue": "private-secret" },
      device,
      "a".repeat(40),
    ),
    binding,
  );
});
test("a historical success cannot become this-session verification and cancellation stays actionable", () => {
  const binding = guideBinding(config, values, device);
  const progress = {
    version: 1 as const,
    scope: { root: "/fixture", project: "fixture", environment: "staging" },
    binding,
    history: [
      {
        stage: "application" as const,
        observedAt: "2026-10-26T00:00:00.000Z",
        outcome: "verified" as const,
      },
      {
        stage: "auth" as const,
        observedAt: "2026-10-26T00:00:01.000Z",
        outcome: "cancelled" as const,
      },
    ],
  };
  const stages = deploymentGuideStages({ config, values, device, progress });
  assert.equal(
    stages.find((item) => item.id === "application")?.state,
    "historical",
  );
  assert.notEqual(stages.find((item) => item.id === "auth")?.state, "verified");
  assert.equal(
    deploymentGuideStages({
      config,
      values: { ...values, appOrigin: "https://other.example.com" },
      device,
      progress,
    }).find((item) => item.id === "application")?.state,
    "missing",
  );
});
test("missing or invalid current inputs cannot be verified by a stale success flag", () => {
  const stages = deploymentGuideStages({
    config,
    values: {
      ...values,
      supabaseProjectRef: "invalid-ref",
      cloudflareTunnelToken: "",
    },
    evidence: { supabase: "verified", tunnel: "verified", device: "verified" },
  });
  assert.equal(stages.find((item) => item.id === "supabase")?.state, "missing");
  assert.deepEqual(
    stages.find((item) => item.id === "supabase")?.missingFields,
    ["supabaseProjectRef"],
  );
  assert.equal(stages.find((item) => item.id === "tunnel")?.state, "missing");
  assert.equal(stages.find((item) => item.id === "device")?.state, "missing");
  const external = deploymentGuideStages({
    config: { ...config, setup: { auth: "external" } },
    values,
  });
  assert.equal(external.find((item) => item.id === "auth")?.state, "manual");
});
