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
