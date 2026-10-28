import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../src/config.ts";
const base = {
  version: 1,
  project: "fixture",
  repository: "owner/fixture",
  environments: ["staging"],
  variables: {},
};
const release = {
  ciWorkflow: "ci.yml",
  adapter: "deploy/release.mts",
  environments: ["staging"],
  components: [
    {
      id: "pages",
      label: "页面",
      kind: "pages",
      requiresDevice: false,
      migrations: "none",
    },
  ],
};
test("release declarations are bounded and declarative, not arbitrary commands", () => {
  assert.deepEqual(validateConfig({ ...base, release }).release, release);
  for (const invalid of [
    { ...release, adapter: "../evil.mts" },
    { ...release, adapter: "deploy/file.mts;sh" },
    { ...release, command: "rm -rf /" },
    { ...release, ciWorkflow: "../ci.yml" },
    { ...release, environments: ["production"] },
    {
      ...release,
      components: [{ ...release.components[0], migrations: "supabase-cli" }],
    },
    {
      ...release,
      components: [
        { ...release.components[0], id: "back" },
        { ...release.components[0], id: "back" },
      ],
    },
  ])
    assert.throws(() => validateConfig({ ...base, release: invalid }));
});
test("official release migrations must match the project ledger declaration", () => {
  const app = {
    id: "application",
    label: "API",
    kind: "application",
    requiresDevice: true,
    migrations: "supabase-cli",
  };
  assert.throws(() =>
    validateConfig({ ...base, release: { ...release, components: [app] } }),
  );
  assert.ok(
    validateConfig({
      ...base,
      migrationStrategy: "supabase-cli",
      release: { ...release, components: [app] },
    }),
  );
});
test("runtime fields explicitly permit project secrets and reject management credentials and aliases", () => {
  const variables = {
    supabasePublishableKey: "KEY",
    cloudflareTunnelToken: "TUNNEL",
    cloudflareToken: "MANAGEMENT",
    supabaseCleanupKey: "CLEANUP",
    appOrigin: "ORIGIN",
  };
  const component = release.components[0]!;
  for (const runtimeFields of [
    [],
    ["supabasePublishableKey", "cloudflareTunnelToken"],
  ])
    assert.ok(
      validateConfig({
        ...base,
        variables,
        release: { ...release, components: [{ ...component, runtimeFields }] },
      }),
    );
  for (const runtimeFields of [
    ["cloudflareToken"],
    ["supabaseCleanupKey"],
    ["@supabase"],
    ["appOrigin"],
    ["unknown"],
    ["cloudflareTunnelToken", "cloudflareTunnelToken"],
    "bad",
  ])
    assert.throws(() =>
      validateConfig({
        ...base,
        variables,
        release: { ...release, components: [{ ...component, runtimeFields }] },
      }),
    );
});

test("local build declarations are tracked adapters with public outputs and bounded environments", () => {
  const config = {
    ...base,
    variables: { deploymentImage: "IMAGE", cloudflareToken: "TOKEN" },
  };
  const localBuild = {
    adapter: "deploy/build.mts",
    environments: ["staging"],
    outputFields: ["deploymentImage"],
  };
  const declaration = {
    ...release,
    publicFields: ["deploymentImage"],
    localBuild,
  };
  assert.ok(validateConfig({ ...config, release: declaration }));
  for (const invalid of [
    { ...localBuild, adapter: "../build.mts" },
    { ...localBuild, adapter: "deploy/../build.mts" },
    { ...localBuild, environments: ["production"] },
    { ...localBuild, outputFields: [] },
    { ...localBuild, outputFields: ["cloudflareToken"] },
    { ...localBuild, outputFields: ["unknown"] },
    { ...localBuild, command: "sh build.sh" },
  ])
    assert.throws(() =>
      validateConfig({
        ...config,
        release: { ...declaration, localBuild: invalid },
      }),
    );
  assert.throws(() =>
    validateConfig({
      ...config,
      release: { ...declaration, publicFields: [] },
    }),
  );
});

test("transient CI fallback is explicitly scoped, short lived and never production", () => {
  const ciTransientFallback = { environments: ["staging"], maxAgeSeconds: 300 };
  assert.ok(
    validateConfig({ ...base, release: { ...release, ciTransientFallback } }),
  );
  for (const invalid of [
    { ...ciTransientFallback, environments: [] },
    { ...ciTransientFallback, environments: ["production"] },
    { ...ciTransientFallback, environments: ["prod"] },
    { ...ciTransientFallback, maxAgeSeconds: 301 },
    { ...ciTransientFallback, maxAgeSeconds: 0 },
    { ...ciTransientFallback, maxAgeSeconds: "300" },
    { ...ciTransientFallback, skipFailures: true },
  ])
    assert.throws(() =>
      validateConfig({
        ...base,
        release: { ...release, ciTransientFallback: invalid },
      }),
    );
});

test("explicit component order lists every component once without changing old manifests", () => {
  const components = [
    release.components[0]!,
    { ...release.components[0]!, id: "api", kind: "application" },
  ];
  const declaration = { ...release, components, order: ["pages", "api"] };
  assert.ok(validateConfig({ ...base, release: declaration }));
  for (const order of [
    ["api"],
    ["pages", "pages"],
    ["pages", "unknown"],
    "pages",
  ])
    assert.throws(() =>
      validateConfig({ ...base, release: { ...declaration, order } }),
    );
});
