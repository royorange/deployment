import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectGuideApplication } from "../src/deployment-guide-inspection.ts";
import { device, fixture, old, sha, output } from "./lifecycle-fixture.ts";

test("guide observes the running revision without CI, secrets, database prompts or publication", async () => {
  const f = await fixture();
  try {
    const result = await inspectGuideApplication(f.ctx, device);
    assert.deepEqual(
      result.map((c) => [c.component, c.state, c.current, c.controllerCommit]),
      [["app", "running", old, sha]],
    );
    assert.equal(
      f.calls.some((c) => c.command === "gh"),
      false,
    );
    const calls = f.calls.filter((c) => c.command === process.execPath);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args.at(-1), "inspect");
    assert.equal(JSON.parse(calls[0]!.input!).operation, "status");
    assert.equal(calls[0]!.input!.includes("synthetic"), false);
    assert.equal(f.confirmations.length, 1);
  } finally {
    await f.close();
  }
});

test("only explicit healthy running snapshots can be retained", async () => {
  for (const variant of [
    { ...output(), ready: false },
    { ...output(), missing: ["unverified public health"] },
    output("stopped"),
    output("degraded"),
    output("unknown"),
    output("busy"),
    { ...output(), snapshot: undefined },
    { ...output(), snapshot: { ...output().snapshot, current: undefined } },
  ]) {
    const f = await fixture();
    try {
      const run = f.ctx.runner;
      f.ctx.runner = (command, args, opts) =>
        command === process.execPath
          ? Promise.resolve(JSON.stringify(variant))
          : run(command, args, opts);
      const [result] = await inspectGuideApplication(f.ctx, device);
      assert.equal(result!.state, "unavailable");
      assert.equal(result!.current, undefined);
    } finally {
      await f.close();
    }
  }
});

test("missing device or inspector cannot invent completion or execute a release", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await inspectGuideApplication(f.ctx, undefined))[0]!.state,
      "unavailable",
    );
    assert.equal(f.calls.length, 0);
    delete f.ctx.config.release!.lifecycle;
    assert.equal(
      (await inspectGuideApplication(f.ctx, device))[0]!.state,
      "unavailable",
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("Pages inspection never invents a branch or claims HTTP health from provider publication", async () => {
  const { inspectGuidePages } =
    await import("../src/deployment-guide-inspection.ts");
  const { fixture: guideFixture } = await import("./guide-fixture.ts");
  const f = await guideFixture([]);
  try {
    f.ctx.fetcher = async () => {
      throw new Error("missing branch must not fetch");
    };
    const missing = await inspectGuidePages(f.ctx);
    assert.equal(missing.status, "configured");
    assert.match(missing.message!, /分支/);
    f.ctx.config.variables.siteBranch = "SITE_BRANCH";
    f.ctx.config.extraFields = {
      siteBranch: { label: "Site branch", kind: "text", secret: false },
    };
    f.ctx.config.setup!.components = [
      {
        id: "web",
        title: "Web",
        kind: "web",
        hosting: "pages",
        projectField: "pagesProject",
        originField: "siteOrigin",
        branchField: "siteBranch",
      },
    ];
    const { values } = await import("../src/wizard.ts");
    values(f.ctx).siteBranch = "staging";
    f.ctx.fetcher = async (input) =>
      new Response(
        JSON.stringify({
          success: true,
          result: String(input).includes("/deployments")
            ? [
                {
                  id: "deployment",
                  url: "https://abc.fixture-site.pages.dev",
                  aliases: [],
                  created_on: "2026-10-28T00:00:00Z",
                  environment: "preview",
                  is_skipped: false,
                  latest_stage: { name: "deploy", status: "success" },
                  deployment_trigger: {
                    metadata: { branch: "staging", commit_hash: sha },
                  },
                },
              ]
            : { name: "fixture-site", production_branch: "main" },
        }),
        { status: 200 },
      );
    const result = await inspectGuidePages(f.ctx);
    assert.equal(result.status, "configured");
    assert.match(result.message!, /API.*发布成功/);
    assert.match(result.message!, /HTTP|实际访问/);
  } finally {
    await f.cleanup();
  }
});
