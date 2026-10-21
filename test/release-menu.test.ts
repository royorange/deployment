import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseMenu } from "../src/release-menu.ts";
import { projectKey } from "../src/config.ts";
import type { Context } from "../src/wizard.ts";
async function fixture(answers: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-menu-")));
  await mkdir(join(root, "deploy"));
  await writeFile(join(root, "deploy/release.mts"), "// synthetic fixture");
  const logs: string[] = [],
    calls: Array<{ command: string; args: string[] }> = [];
  const sha = "a".repeat(40);
  const ctx: Context = {
    root,
    env: "staging",
    storageMode: "memory",
    config: {
      version: 1,
      project: "fixture",
      repository: "owner/fixture",
      environments: ["staging"],
      variables: {},
      release: {
        adapter: "deploy/release.mts",
        ciWorkflow: "ci.yml",
        buildWorkflow: "build.yml",
        buildWorkflowRef: "main",
        environments: ["staging"],
        components: [
          {
            id: "pages",
            label: "Pages",
            kind: "pages",
            requiresDevice: false,
            migrations: "none",
          },
        ],
      },
    },
    data: {
      credentials: { "cf/test": "fixture-secret" },
      profiles: {
        [projectKey("fixture", "staging")]: { "@cloudflareDeploy": "cf/test" },
      },
    },
    save: async () => {},
    runner: async (command, args) => {
      calls.push({ command, args });
      if (command === "git") {
        if (args.includes("status")) return "";
        if (args.includes("get-url")) return "git@github.com:owner/fixture.git";
        if (args.includes("rev-parse")) return sha;
        if (args.includes("-v")) return "H deploy/release.mts\0";
        return "deploy/release.mts";
      }
      if (command === "gh")
        return JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 1,
              run_number: 1,
              created_at: "2026-10-21T00:00:00Z",
              head_sha: sha,
              head_repository: { full_name: "owner/fixture", fork: false },
              path: ".github/workflows/ci.yml",
              event: "push",
              head_branch: "feature",
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      return JSON.stringify({
        ready: true,
        summary: ["done"],
        missing: [],
        effects: [],
      });
    },
    ui: {
      select: async (message, choices) => {
        const chosen = answers.shift();
        assert.ok(
          choices.some((x) => x.value === chosen),
          `unexpected ${chosen}: ${message}`,
        );
        return chosen!;
      },
      input: async () => "",
      confirm: async () => true,
      check: async () => [],
      log: (line) => logs.push(line),
    },
  };
  return {
    ctx,
    calls,
    logs,
    run: () => releaseMenu(ctx),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("dedicated release menu publishes Pages only through CI-gated project adapter", async () => {
  const f = await fixture(["deploy", "component:pages", "back"]);
  try {
    await f.run();
    assert.deepEqual(
      f.calls
        .filter((c) => c.command === process.execPath)
        .map((c) => c.args.at(-1)),
      ["plan", "deploy", "verify"],
    );
    assert.ok(!f.logs.join("\n").includes("fixture-secret"));
  } finally {
    await f.close();
  }
});
test("build workflow ref is independent from the source CI branch", async () => {
  const f = await fixture(["ci", "back"]);
  try {
    await f.run();
    const call = f.calls.find(
      (c) => c.command === "gh" && c.args[0] === "workflow",
    )!;
    assert.equal(call.args[call.args.indexOf("--ref") + 1], "main");
    assert.equal(call.args.at(-1), `commit=${"a".repeat(40)}`);
  } finally {
    await f.close();
  }
});
test("missing release manifest or unsupported topology explains the next step without remote writes", async () => {
  const f = await fixture(["deploy", "tunnel", "export", "back", "back"]);
  try {
    delete f.ctx.config.release;
    await f.run();
    assert.ok(f.logs.some((line) => line.includes("尚未声明")));
    assert.ok(f.logs.some((line) => line.includes("当前自动Tunnel")));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test("device profiles can be added and reused inside deployment without opening a network session", async () => {
  const f = await fixture([
    "devices",
    "add",
    "device:test-host",
    "command",
    "back",
    "back",
    "back",
  ]);
  const inputs = ["test-host", "测试机", "192.0.2.10", "deploy", "22"];
  f.ctx.ui.input = async () => inputs.shift()!;
  try {
    await f.run();
    assert.ok(f.logs.some((line) => line.includes("deploy@192.0.2.10")));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
