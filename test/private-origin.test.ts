import assert from "node:assert/strict";
import test from "node:test";
import {
  privateOriginPlan,
  accessPolicyMatches,
  CloudflarePrivateOrigin,
} from "../src/private-origin.ts";
const input = {
  project: "sample",
  environment: "staging",
  accountId: "a".repeat(32),
  zoneId: "b".repeat(32),
  zoneName: "example.com",
  publicOrigin: "https://staging.example.com",
  privateOrigin: "https://api-staging.example.com",
  workerName: "sample-edge-staging",
};
test("private plan separates Worker and Tunnel with Host rewrite and terminal deny", () => {
  const p = privateOriginPlan(input);
  assert.equal(p.hostname, "api-staging.example.com");
  assert.equal(p.publicHostname, "staging.example.com");
  assert.equal(p.service, "http://sample-staging:3000");
  assert.deepEqual(p.originRequest, { httpHostHeader: "staging.example.com" });
  for (const change of [
    { privateOrigin: input.publicOrigin },
    { privateOrigin: "https://foreign.example.net" },
    { publicOrigin: "http://staging.example.com" },
    { project: "../escape" },
  ])
    assert.throws(() => privateOriginPlan({ ...input, ...change }));
});
test("Access verification only accepts the exact service token and no additional allow/bypass", () => {
  const policy = {
    decision: "non_identity",
    include: [{ service_token: { token_id: "token-id" } }],
    exclude: [],
    require: [],
  };
  assert.equal(accessPolicyMatches([policy], "token-id"), true);
  for (const policies of [
    [{ ...policy, decision: "allow" }],
    [policy, { ...policy, decision: "bypass" }],
    [{ ...policy, include: [{ everyone: {} }] }],
    [{ ...policy, exclude: [{ everyone: {} }] }],
  ])
    assert.equal(accessPolicyMatches(policies, "token-id"), false);
});
test("existing foreign app is rejected without writes", async () => {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    methods.push(options?.method ?? "GET");
    return Response.json({
      success: true,
      result: [
        {
          id: "other",
          name: "other-owner",
          domain: "api-staging.example.com",
          type: "self_hosted",
        },
      ],
    });
  };
  const client = new CloudflarePrivateOrigin("fixture-token", fetcher);
  await assert.rejects(
    () => client.inspectAccess(privateOriginPlan(input)),
    /冲突/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("more-specific Access paths and wildcard/destination overlaps cannot bypass the root policy", async () => {
  for (const conflicting of [
    {
      id: "path",
      name: "foreign",
      domain: "api-staging.example.com/api/*",
      type: "self_hosted",
    },
    {
      id: "wild",
      name: "foreign",
      domain: "*.example.com",
      type: "self_hosted",
    },
    {
      id: "dest",
      name: "foreign",
      domain: "other.example.com",
      type: "self_hosted",
      destinations: [{ type: "public", uri: "api-staging.example.com/admin" }],
    },
  ]) {
    const client = new CloudflarePrivateOrigin("fixture", async () =>
      Response.json({ success: true, result: [conflicting] }),
    );
    await assert.rejects(
      () => client.inspectAccess(privateOriginPlan(input)),
      /冲突/,
    );
  }
});
