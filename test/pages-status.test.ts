import assert from "node:assert/strict";
import { test } from "node:test";
import { Cloudflare } from "../src/providers.ts";
import { inspectPagesDeployment } from "../src/pages-status.ts";

const account = "a".repeat(32);
const project = {
  name: "example",
  production_branch: "main",
  subdomain: "example.pages.dev",
};
const deployment = {
  id: "deployment-fixture",
  created_on: "2026-10-20T10:00:00Z",
  environment: "preview",
  deployment_trigger: { metadata: { branch: "staging" } },
  latest_stage: { name: "deploy", status: "success" },
  url: "https://abc123.example.pages.dev",
  aliases: ["https://staging.example.pages.dev"],
  is_skipped: false,
};

function fixture(result: unknown[], projectStatus = 200): Cloudflare {
  return new Cloudflare("synthetic-token", async (url, init) => {
    assert.equal(init?.method, "GET");
    if (String(url).includes("/deployments?"))
      return Response.json({ success: true, result });
    return projectStatus === 200
      ? Response.json({ success: true, result: project })
      : new Response("private response body", { status: projectStatus });
  });
}

test("Pages project existence, missing branch, and successful deployment are separate evidence", async () => {
  assert.equal(
    (
      await inspectPagesDeployment(fixture([], 404), account, "example", {
        branch: "staging",
      })
    ).status,
    "missing-project",
  );
  assert.equal(
    (
      await inspectPagesDeployment(fixture([]), account, "example", {
        branch: "staging",
      })
    ).status,
    "empty",
  );
  assert.equal(
    (
      await inspectPagesDeployment(
        fixture([
          {
            ...deployment,
            deployment_trigger: { metadata: { branch: "main" } },
          },
        ]),
        account,
        "example",
        { branch: "staging" },
      )
    ).status,
    "missing-deployment",
  );
  const ready = await inspectPagesDeployment(
    fixture([deployment]),
    account,
    "example",
    { branch: "staging", environment: "preview" },
  );
  assert.equal(ready.status, "deployed");
  assert.equal(ready.deployment?.url, deployment.url);
  assert.equal(ready.applicationReachability, "unverified");
});

test("Pages selects latest exact branch/environment and never treats a successful build stage as published", async () => {
  for (const [stage, status] of [
    [{ name: "build", status: "success" }, "pending"],
    [{ name: "deploy", status: "active" }, "pending"],
    [{ name: "deploy", status: "idle" }, "pending"],
    [{ name: "build", status: "failure" }, "failed"],
    [{ name: "deploy", status: "canceled" }, "failed"],
    [{ name: "deploy", status: "future-status" }, "unknown"],
  ] as const) {
    const result = await inspectPagesDeployment(
      fixture([
        { ...deployment, created_on: "2026-10-19T10:00:00Z" },
        { ...deployment, latest_stage: stage },
        {
          ...deployment,
          environment: "production",
          created_on: "2026-10-21T10:00:00Z",
        },
      ]),
      account,
      "example",
      { branch: "staging", environment: "preview" },
    );
    assert.equal(result.status, status);
  }
  assert.equal(
    (
      await inspectPagesDeployment(
        fixture([{ ...deployment, is_skipped: true }]),
        account,
        "example",
        { branch: "staging" },
      )
    ).status,
    "failed",
  );
});

test("Pages rejects unsafe deployment URLs and filters unsafe aliases without fetching them", async () => {
  for (const url of [
    "not a URL",
    "http://abc.example.pages.dev",
    "https://example.pages.dev.evil.test",
    "https://evil.test",
    "https://user:pass@abc.example.pages.dev",
    "https://abc.example.pages.dev:444",
    "https://abc.example.pages.dev/path",
    "https://abc.example.pages.dev/?token=secret",
  ]) {
    const result = await inspectPagesDeployment(
      fixture([{ ...deployment, url }]),
      account,
      "example",
      { branch: "staging" },
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.deployment, undefined);
  }
  const result = await inspectPagesDeployment(
    fixture([
      { ...deployment, aliases: [...deployment.aliases, "https://evil.test"] },
    ]),
    account,
    "example",
    { branch: "staging" },
  );
  assert.deepEqual(result.deployment?.aliases, deployment.aliases);
});

test("Pages permission/network/malformed evidence is unknown and does not create resources or expose bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    const result = await inspectPagesDeployment(
      fixture([], status),
      account,
      "example",
      { branch: "staging" },
    );
    assert.equal(result.status, "unknown");
    assert.ok(!JSON.stringify(result).includes("private response body"));
  }
  for (const entry of [
    null,
    { ...deployment, created_on: "invalid" },
    { ...deployment, latest_stage: undefined },
  ]) {
    const result = await inspectPagesDeployment(
      fixture([entry]),
      account,
      "example",
      { branch: "staging" },
    );
    assert.equal(result.status, "unknown");
  }
  const result = await inspectPagesDeployment(
    new Cloudflare("synthetic-token", async () => {
      throw new Error("sensitive-token");
    }),
    account,
    "example",
    { branch: "staging" },
  );
  assert.equal(result.status, "unknown");
  assert.ok(!JSON.stringify(result).includes("sensitive-token"));
});

test("Pages deployment list is paginated, bounded and strips build environment values", async () => {
  let calls = 0;
  const cf = new Cloudflare("synthetic-token", async (url, init) => {
    assert.equal(init?.method, "GET");
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.cloudflare.com");
    assert.equal(parsed.searchParams.get("env"), "preview");
    assert.equal(parsed.searchParams.get("page"), String(++calls));
    return Response.json({
      success: true,
      result: [
        {
          ...deployment,
          id: `fixture-${calls}`,
          env_vars: { SECRET: { value: "private-build-value" } },
        },
      ],
      result_info: { total_pages: 2 },
    });
  });
  const result = await cf.pagesDeployments(account, "example", {
    environment: "preview",
  });
  assert.equal(calls, 2);
  assert.equal(result.length, 2);
  assert.ok(!JSON.stringify(result).includes("private-build-value"));
  calls = 0;
  const excessive = new Cloudflare("synthetic-token", async () => {
    calls++;
    return Response.json({
      success: true,
      result: [],
      result_info: { total_pages: 21 },
    });
  });
  await assert.rejects(
    excessive.pagesDeployments(account, "example"),
    /分页超过限制/,
  );
  assert.equal(calls, 20);
});

test("Pages branch must be explicit and malformed API lists fail closed", async () => {
  await assert.rejects(
    inspectPagesDeployment(fixture([]), account, "example", { branch: "" }),
    /分支/,
  );
  const malformed = new Cloudflare("synthetic-token", async () =>
    Response.json({ success: true, result: {} }),
  );
  await assert.rejects(
    malformed.pagesDeployments(account, "example"),
    /部署列表/,
  );
  const invalidPagination = new Cloudflare("synthetic-token", async () =>
    Response.json({
      success: true,
      result: [],
      result_info: { total_pages: "2" },
    }),
  );
  await assert.rejects(
    invalidPagination.pagesDeployments(account, "example"),
    /分页响应不合法/,
  );
  const failedList = new Cloudflare("synthetic-token", async () =>
    Response.json({ success: false, result: [] }),
  );
  await assert.rejects(
    failedList.pagesDeployments(account, "example"),
    /部署列表/,
  );
});
