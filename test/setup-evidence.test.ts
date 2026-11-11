import assert from "node:assert/strict";
import { test } from "node:test";
import {
  withPagesEvidence,
  type PagesEvidence,
} from "../src/setup-evidence.ts";
import { setupChecks } from "../src/setup-model.ts";
import type { Config } from "../src/config.ts";
const config: Config = {
  version: 1,
  project: "fixture",
  environments: ["staging"],
  variables: { pagesProject: "PAGES", siteOrigin: "SITE" },
  setup: {
    components: [
      {
        id: "web",
        title: "前台",
        kind: "web",
        hosting: "pages",
        projectField: "pagesProject",
        originField: "siteOrigin",
      },
    ],
  },
};
const values = {
  cloudflareAccountId: "a".repeat(32),
  pagesProject: "fixture-web",
};
const evidence: PagesEvidence = {
  account: values.cloudflareAccountId,
  project: "fixture-web",
  projectField: "pagesProject",
  branch: "staging",
  status: "deployed",
  message: "API 确认发布",
  checkedAt: "2026-10-20T00:00:00Z",
};
test("current Pages evidence reports resource publication while application stays unverified", () => {
  const checks = withPagesEvidence(
    config,
    values,
    setupChecks(config, values),
    [evidence],
  );
  assert.equal(
    checks.find((item) => item.id === "component.web.deployment")!.state,
    "published",
  );
  assert.equal(
    checks.find((item) => item.id === "application.verified")!.state,
    "unknown",
  );
  assert.ok(
    checks
      .find((item) => item.id === "component.web.deployment")!
      .instructions.includes(evidence.checkedAt),
  );
});
test("changed bindings and stale evidence never retain publication state", () => {
  for (const changed of [
    { ...values, cloudflareAccountId: "b".repeat(32) },
    { ...values, pagesProject: "new-web" },
  ]) {
    const checks = withPagesEvidence(
      config,
      changed,
      setupChecks(config, changed),
      [evidence],
    );
    assert.equal(
      checks.find((item) => item.id === "component.web.deployment")!.state,
      "unknown",
    );
  }
  for (const status of ["unknown", "pending", "failed", "empty"] as const) {
    const checks = withPagesEvidence(
      config,
      values,
      setupChecks(config, values),
      [{ ...evidence, status }],
    );
    assert.equal(
      checks.find((item) => item.id === "component.web.deployment")!.state,
      status === "failed" || status === "empty" ? "missing" : "unknown",
    );
  }
});
