import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRelease } from "../src/release-engine.ts";
import type { Context } from "../src/wizard.ts";
const sha = "a".repeat(40);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "release-engine-"));
  await mkdir(join(root, "deploy"));
  await writeFile(join(root, "deploy/release.mts"), "// fixture");
  const calls: Array<{
    cmd: string;
    args: string[];
    input?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  const ctx: Context = {
    root,
    env: "staging",
    config: {
      version: 1,
      project: "fixture",
      repository: "owner/fixture",
      environments: ["staging"],
      migrationStrategy: "supabase-cli",
      variables: {
        appOrigin: "APP_ORIGIN",
        supabasePublishableKey: "PUBLISHABLE",
      },
      release: {
        adapter: "deploy/release.mts",
        ciWorkflow: "ci.yml",
        environments: ["staging"],
        publicFields: ["appOrigin"],
        components: [
          {
            id: "app",
            label: "API",
            kind: "application",
            requiresDevice: false,
            migrations: "supabase-cli",
          },
        ],
      },
    },
    data: { credentials: { fixture: "secret-fixture" }, profiles: {} },
    save: async () => {},
    ui: {
      select: async () => "",
      input: async () => "",
      check: async () => [],
      confirm: async () => true,
      log: () => {},
    },
    runner: async (cmd, args, options) => {
      calls.push({ cmd, args, input: options?.input, env: options?.env });
      if (cmd === "git") {
        if (args.includes("status")) return "";
        if (args.includes("get-url")) return "git@github.com:owner/fixture.git";
        if (args.includes("rev-parse")) return sha;
        if (args.includes("-v")) return "H deploy/release.mts\0";
        return "deploy/release.mts";
      }
      if (cmd === "gh")
        return JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 1,
              run_number: 1,
              run_attempt: 1,
              created_at: "2026-10-21T00:00:00Z",
              status: "completed",
              conclusion: "success",
              head_sha: sha,
              head_repository: { full_name: "owner/fixture", fork: false },
              path: ".github/workflows/ci.yml",
              event: "push",
              head_branch: "main",
            },
          ],
        });
      return JSON.stringify({
        ready: true,
        summary: ["fixture phase complete"],
        missing: [],
        effects: ["deploy fixture"],
      });
    },
  };
  return {
    ctx,
    calls,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("release gates CI, runs migrations once before deploy and verify, excludes secrets from request", async () => {
  const f = await fixture();
  try {
    const result = await runRelease(f.ctx, "app", undefined, {
      migrate: async () => ({
        state: "applied",
        ref: "b".repeat(20),
        files: ["1_fixture.sql"],
      }),
    });
    assert.equal(result.state, "health-checked");
    const adapters = f.calls.filter((x) => x.cmd === process.execPath);
    assert.deepEqual(
      adapters.map((x) => x.args.at(-1)),
      ["plan", "deploy", "verify"],
    );
    assert.ok(
      adapters.every(
        (x) =>
          !x.input!.includes("secret-fixture") &&
          !x.input!.includes("PUBLISHABLE"),
      ),
    );
    assert.ok(!("SUPABASE_ACCESS_TOKEN" in adapters[0]!.env!));
  } finally {
    await f.close();
  }
});
test("cancelled migration prevents application deploy and records cancellation", async () => {
  const f = await fixture();
  try {
    const result = await runRelease(f.ctx, "app", undefined, {
      migrate: async () => undefined,
    });
    assert.equal(result.state, "cancelled");
    assert.equal(f.calls.filter((x) => x.cmd === process.execPath).length, 1);
  } finally {
    await f.close();
  }
});
test("dirty checkout and a failing CI never execute repository adapters", async () => {
  for (const failure of ["dirty", "ci"]) {
    const f = await fixture();
    try {
      const base = f.ctx.runner;
      f.ctx.runner = async (cmd, args, opts) =>
        failure === "dirty" && cmd === "git" && args.includes("status")
          ? " M file"
          : failure === "ci" && cmd === "gh"
            ? "{}"
            : base(cmd, args, opts);
      await assert.rejects(runRelease(f.ctx, "app"));
      assert.equal(f.calls.filter((x) => x.cmd === process.execPath).length, 0);
    } finally {
      await f.close();
    }
  }
});
test("migration success and application failure remain distinct without any database rollback", async () => {
  const f = await fixture();
  try {
    const base = f.ctx.runner;
    f.ctx.runner = async (cmd, args, opts) => {
      if (cmd === process.execPath && args.at(-1) === "deploy")
        throw new Error("secret-fixture");
      return base(cmd, args, opts);
    };
    const result = await runRelease(f.ctx, "app", undefined, {
      migrate: async () => ({
        state: "applied",
        ref: "b".repeat(20),
        files: ["1_fixture.sql"],
      }),
    });
    assert.equal(result.state, "failed");
    assert.equal(result.database, "applied");
    assert.ok(!JSON.stringify(result).includes("secret-fixture"));
    assert.ok(
      !f.calls.some(
        (c) => c.args.includes("reset") || c.args.includes("repair"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("prompt interruption records cancellation and does not run a project adapter", async () => {
  const f = await fixture();
  try {
    f.ctx.ui.confirm = async () => {
      const error = new Error("cancelled");
      error.name = "ExitPromptError";
      throw error;
    };
    await assert.rejects(runRelease(f.ctx, "app"), { name: "ExitPromptError" });
    assert.equal(f.calls.filter((c) => c.cmd === process.execPath).length, 0);
  } finally {
    await f.close();
  }
});
test("git replacement objects cannot substitute unreviewed adapter code for a passed commit", async () => {
  const f = await fixture();
  try {
    const { execFileSync } = await import("node:child_process");
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: f.ctx.root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      }).trim();
    git(["init", "-q"]);
    git(["config", "user.name", "fixture"]);
    git(["config", "user.email", "fixture@example.test"]);
    git(["add", "."]);
    git(["-c", "commit.gpgsign=false", "commit", "-qm", "reviewed"]);
    const reviewed = git(["rev-parse", "HEAD"]);
    await writeFile(
      join(f.ctx.root, "deploy/release.mts"),
      "// unreviewed replacement",
    );
    git(["add", "."]);
    git(["-c", "commit.gpgsign=false", "commit", "-qm", "replacement"]);
    const replacement = git(["rev-parse", "HEAD"]);
    git(["replace", reviewed, replacement]);
    git(["reset", "--hard", reviewed]);
    git(["remote", "add", "origin", "git@github.com:owner/fixture.git"]);
    assert.equal(git(["status", "--porcelain"]), "");
    f.ctx.runner = async (command, args) => {
      assert.equal(command, "git");
      return git(args);
    };
    const { releaseCheckout } = await import("../src/release-preflight.ts");
    await assert.rejects(releaseCheckout(f.ctx), /干净/);
  } finally {
    await f.close();
  }
});

test("explicit declines stop both adapter execution and production changes", async () => {
  for (const stage of ["trust", "plan", "production"] as const) {
    const f = await fixture();
    try {
      let confirms = 0;
      f.ctx.ui.confirm = async () =>
        stage === "trust" ? false : stage === "plan" ? ++confirms === 1 : true;
      if (stage === "production") {
        f.ctx.env = "production";
        f.ctx.config.environments.push("production");
        f.ctx.config.release!.environments.push("production");
        f.ctx.ui.input = async () => "";
      }
      const result = await runRelease(f.ctx, "app", undefined, {
        migrate: async () => {
          throw new Error("must not migrate");
        },
      });
      assert.equal(result.state, "cancelled");
      assert.equal(
        f.calls.filter((x) => x.cmd === process.execPath).length,
        stage === "trust" ? 0 : 1,
      );
    } finally {
      await f.close();
    }
  }
});
test("unsupported migration ledgers and missing device requirements fail before side effects", async () => {
  const f = await fixture();
  try {
    const component = f.ctx.config.release!.components[0]!;
    component.requiresDevice = true;
    await assert.rejects(runRelease(f.ctx, "app"), /SSH/);
    component.requiresDevice = false;
    component.migrations = "project-managed";
    await assert.rejects(runRelease(f.ctx, "app"), /项目自管/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test("CI rerun or local edits during migration stop application publication after recording database changes", async () => {
  for (const change of ["ci", "git"] as const) {
    const f = await fixture();
    try {
      const base = f.ctx.runner;
      let mutated = false;
      f.ctx.runner = async (cmd, args, options) => {
        if (
          mutated &&
          change === "git" &&
          cmd === "git" &&
          args.includes("status")
        )
          return " M sql";
        if (mutated && change === "ci" && cmd === "gh") return "{}";
        return base(cmd, args, options);
      };
      const result = await runRelease(f.ctx, "app", undefined, {
        migrate: async () => {
          mutated = true;
          return {
            state: "applied",
            ref: "b".repeat(20),
            files: ["1_fixture.sql"],
          };
        },
      });
      assert.equal(result.state, "failed");
      assert.equal(result.database, "applied");
      assert.equal(f.calls.filter((x) => x.cmd === process.execPath).length, 1);
    } finally {
      await f.close();
    }
  }
});
test("private receipts preserve completed migration on failed deploy and release locks prevent overlaps", async () => {
  const f = await fixture();
  try {
    f.ctx.releaseDirectory = join(f.ctx.root, "receipts");
    f.ctx.storageMode = "vault";
    const base = f.ctx.runner;
    f.ctx.runner = async (cmd, args, options) => {
      if (cmd === process.execPath && args.at(-1) === "plan") {
        await assert.rejects(runRelease(f.ctx, "app"), /发布正在/);
      }
      return base(cmd, args, options);
    };
    const result = await runRelease(f.ctx, "app", undefined, {
      migrate: async () => ({
        state: "up-to-date",
        ref: "b".repeat(20),
        files: [],
      }),
    });
    assert.equal(result.state, "health-checked");
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(f.ctx.releaseDirectory);
    assert.equal(files.length, 1);
    const receipt = JSON.parse(
      await readFile(join(f.ctx.releaseDirectory, files[0]!), "utf8"),
    );
    assert.equal(receipt.database, "up-to-date");
    assert.ok(!JSON.stringify(receipt).includes("secret-fixture"));
  } finally {
    await f.close();
  }
});
test("single-operation Pages token never appears in logs or request even if adapter echoes it", async () => {
  const f = await fixture();
  try {
    const logs: string[] = [];
    f.ctx.ui.log = (line) => logs.push(line);
    const c = f.ctx.config.release!.components[0]!;
    c.kind = "pages";
    c.migrations = "none";
    const base = f.ctx.runner;
    f.ctx.runner = async (cmd, args, options) =>
      cmd === process.execPath
        ? JSON.stringify({
            ready: true,
            summary: ["one-shot-token"],
            missing: [],
            effects: [],
          })
        : base(cmd, args, options);
    const result = await runRelease(f.ctx, "app", undefined, {
      cloudflareToken: async () => "one-shot-token",
    });
    assert.equal(result.state, "health-checked");
    assert.ok(!logs.join("").includes("one-shot-token"));
  } finally {
    await f.close();
  }
});

test("adapter edited during trust confirmation cannot execute even the plan phase", async () => {
  const f = await fixture();
  try {
    let changed = false;
    const base = f.ctx.runner;
    f.ctx.ui.confirm = async () => {
      changed = true;
      return true;
    };
    f.ctx.runner = async (cmd, args, options) =>
      changed && cmd === "git" && args.includes("status")
        ? " M deploy/release.mts"
        : base(cmd, args, options);
    const result = await runRelease(f.ctx, "app");
    assert.equal(result.state, "failed");
    assert.equal(f.calls.filter((c) => c.cmd === process.execPath).length, 0);
  } finally {
    await f.close();
  }
});
test("assume-unchanged tracked source blocks publication despite a clean status", async () => {
  const f = await fixture();
  try {
    const base = f.ctx.runner;
    f.ctx.runner = async (cmd, args, options) =>
      cmd === "git" && args.includes("-v")
        ? "h deploy/release.mts\0"
        : base(cmd, args, options);
    const { releaseCheckout } = await import("../src/release-preflight.ts");
    await assert.rejects(releaseCheckout(f.ctx), /索引/);
  } finally {
    await f.close();
  }
});
