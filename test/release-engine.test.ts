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
test("v2 runtime fields are frozen per component, stdin only and redacted after profile changes", async () => {
  const f = await fixture();
  const logs: string[] = [];
  try {
    f.ctx.config.release!.components[0]!.runtimeFields = [
      "supabasePublishableKey",
    ];
    f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])] = {
      supabasePublishableKey: "sb_publishable_frozen",
    };
    f.ctx.ui.log = (line) => logs.push(line);
    const original = f.ctx.runner;
    f.ctx.runner = async (cmd, args, options) => {
      const output = await original(cmd, args, options);
      if (cmd === process.execPath) {
        f.ctx.data.profiles[
          JSON.stringify(["fixture", "staging"])
        ]!.supabasePublishableKey = "sb_publishable_changed";
        return JSON.stringify({
          ready: true,
          summary: ["sb_publishable_frozen"],
          missing: [],
          effects: [],
        });
      }
      return output;
    };
    const result = await runRelease(f.ctx, "app", undefined, {
      migrate: async () => ({
        state: "up-to-date",
        ref: "b".repeat(20),
        files: [],
      }),
    });
    assert.equal(result.state, "health-checked");
    const calls = f.calls.filter((call) => call.cmd === process.execPath);
    for (const call of calls) {
      const request = JSON.parse(call.input!);
      assert.equal(request.version, 2);
      assert.deepEqual(request.runtimeValues, {
        supabasePublishableKey: "sb_publishable_frozen",
      });
      assert.ok(
        !JSON.stringify([call.args, call.env]).includes(
          "sb_publishable_frozen",
        ),
      );
    }
    assert.ok(
      !JSON.stringify([logs, result]).includes("sb_publishable_frozen"),
    );
  } finally {
    await f.close();
  }
});
test("empty runtime fields opt in to v2 without handing adapters project secrets", async () => {
  const f = await fixture();
  try {
    f.ctx.config.release!.components[0]!.runtimeFields = [];
    f.ctx.config.release!.components[0]!.migrations = "none";
    const result = await runRelease(f.ctx, "app");
    assert.equal(result.state, "health-checked");
    const request = JSON.parse(
      f.calls.find((call) => call.cmd === process.execPath)!.input!,
    );
    assert.equal(request.version, 2);
    assert.deepEqual(request.runtimeValues, {});
  } finally {
    await f.close();
  }
});
test("frozen runtime and operation tokens are redacted before truncating long adapter errors", async () => {
  for (const kind of ["application", "pages"] as const) {
    const f = await fixture();
    const secret = "connector-sensitive-".repeat(100);
    const logs: string[] = [];
    try {
      const component = f.ctx.config.release!.components[0]!;
      component.kind = kind;
      component.migrations = "none";
      component.runtimeFields =
        kind === "pages" ? [] : ["cloudflareTunnelToken"];
      f.ctx.config.variables.cloudflareTunnelToken = "CONNECTOR";
      f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])] = {
        cloudflareTunnelToken: secret,
      };
      f.ctx.ui.log = (line) => logs.push(line);
      const original = f.ctx.runner;
      f.ctx.runner = async (cmd, args, options) => {
        if (cmd === process.execPath) {
          delete f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])]!
            .cloudflareTunnelToken;
          throw new Error(`${"x".repeat(990)}${secret}`);
        }
        return original(cmd, args, options);
      };
      const result = await runRelease(f.ctx, "app", undefined, {
        cloudflareToken: async () => secret,
      });
      assert.equal(result.state, "failed");
      assert.ok(!logs.join("\n").includes("connector-"));
    } finally {
      await f.close();
    }
  }
});
test("runtime credentials are not resolved before trust and mismatched Supabase refs block adapters", async () => {
  for (const trusted of [false, true]) {
    const f = await fixture();
    let reads = 0;
    try {
      f.ctx.config.release!.components[0]!.runtimeFields = [
        "supabasePublishableKey",
      ];
      f.ctx.ui.confirm = async () => trusted;
      f.ctx.fetcher = async () => {
        reads++;
        throw new Error("unexpected provider access");
      };
      f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])] = {
        supabaseProjectRef: "b".repeat(20),
        supabaseUrl: `https://${"c".repeat(20)}.supabase.co`,
        "@supabase": "fixture",
      };
      const result = await runRelease(f.ctx, "app");
      assert.equal(result.state, trusted ? "failed" : "cancelled");
      assert.equal(reads, 0);
      assert.ok(!f.calls.some((call) => call.cmd === process.execPath));
    } finally {
      await f.close();
    }
  }
});
test("declared runtime fields cannot read secrets from other environments or management aliases", async () => {
  const f = await fixture();
  try {
    f.ctx.config.release!.components[0]!.runtimeFields = [
      "cloudflareTunnelToken",
    ];
    f.ctx.config.variables.cloudflareTunnelToken = "CONNECTOR";
    f.ctx.config.release!.components[0]!.migrations = "none";
    f.ctx.data.profiles[JSON.stringify(["fixture", "production"])] = {
      cloudflareTunnelToken: "other-env-secret",
    };
    const result = await runRelease(f.ctx, "app");
    assert.equal(result.state, "health-checked");
    const request = JSON.parse(
      f.calls.find((call) => call.cmd === process.execPath)!.input!,
    );
    assert.deepEqual(request.runtimeValues, {});
    assert.ok(!JSON.stringify(request).includes("secret"));
    f.ctx.config.release!.components[0]!.runtimeFields = ["cloudflareToken"];
    assert.equal((await runRelease(f.ctx, "app")).state, "failed");
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

test("CI attempt changes stop before migrations even when the run id stays unchanged", async () => {
  const f = await fixture();
  let reads = 0,
    migrated = false;
  const runner = f.ctx.runner;
  f.ctx.runner = async (command, args, options) => {
    const raw = await runner(command, args, options);
    if (command !== "gh") return raw;
    const body = JSON.parse(raw);
    body.workflow_runs[0].run_attempt = ++reads;
    return JSON.stringify(body);
  };
  try {
    const result = await runRelease(f.ctx, "app", undefined, {
      migrate: async () => {
        migrated = true;
        return undefined;
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(migrated, false);
    assert.equal(f.calls.filter((c) => c.cmd === process.execPath).length, 1);
  } finally {
    await f.close();
  }
});

test("confirmed transient fallback is audited without inventing CI identities or skipping migration", async () => {
  const { CommandExecutionError } = await import("../src/process.ts");
  const f = await fixture();
  f.ctx.config.release!.ciTransientFallback = {
    environments: ["staging"],
    maxAgeSeconds: 300,
  };
  const runner = f.ctx.runner;
  let reads = 0,
    migrations = 0,
    fallbacks = 0;
  f.ctx.runner = async (command, args, options) => {
    if (command === "gh" && reads++ > 0)
      throw new CommandExecutionError("gh", 1, {
        httpStatus: 429,
        rateLimited: true,
      });
    return runner(command, args, options);
  };
  f.ctx.ui.confirm = async (message) => {
    if (message.includes("GitHub 暂时")) fallbacks++;
    return true;
  };
  try {
    const result = await runRelease(f.ctx, "app", undefined, {
      ciSleep: async () => {},
      migrate: async () => {
        migrations++;
        return { state: "up-to-date", ref: "b".repeat(20), files: [] };
      },
    });
    assert.equal(result.state, "health-checked");
    assert.equal(result.ciVerification?.degraded, true);
    assert.equal(result.ciRunId, 1);
    assert.equal(result.ciRunAttempt, 1);
    assert.equal(result.database, "up-to-date");
    assert.equal(migrations, 1);
    assert.equal(fallbacks, 2);
    assert.ok(
      f.calls
        .filter((call) => call.cmd === process.execPath)
        .every((call) => JSON.parse(call.input!).ci.runId === 1),
    );
  } finally {
    await f.close();
  }
});

test("changing environment or database target during plan confirmation blocks all writes", async () => {
  for (const change of [
    "environment",
    "database",
    "repository",
    "declaration",
  ]) {
    const f = await fixture();
    let confirmations = 0,
      migrated = false;
    f.ctx.ui.confirm = async () => {
      if (++confirmations === 2) {
        if (change === "environment") f.ctx.env = "production";
        if (change === "database")
          f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])] = {
            supabaseProjectRef: "x".repeat(20),
          };
        if (change === "repository") f.ctx.config.repository = "other/fixture";
        if (change === "declaration")
          f.ctx.config.release!.ciWorkflow = "other.yml";
      }
      return true;
    };
    try {
      const result = await runRelease(f.ctx, "app", undefined, {
        migrate: async () => {
          migrated = true;
          return undefined;
        },
      });
      assert.equal(result.state, "failed");
      assert.equal(migrated, false);
      assert.equal(f.calls.filter((c) => c.cmd === process.execPath).length, 1);
    } finally {
      await f.close();
    }
  }
});

test("CI expiry or failure during SQL confirmation blocks the pre-apply boundary without claiming a database write", async () => {
  const { CommandExecutionError } = await import("../src/process.ts");
  for (const scenario of ["expired", "failed"] as const) {
    const f = await fixture();
    let now = 0,
      reads = 0,
      writes = 0;
    const logs: string[] = [];
    f.ctx.config.release!.ciTransientFallback = {
      environments: ["staging"],
      maxAgeSeconds: 300,
    };
    f.ctx.ui.log = (message) => logs.push(message);
    const runner = f.ctx.runner;
    f.ctx.runner = async (command, args, options) => {
      if (command === "gh" && reads++ >= 2) {
        if (scenario === "expired")
          throw new CommandExecutionError("gh", 1, {
            httpStatus: 429,
            retryAfterSeconds: 60,
          });
        const body = JSON.parse(await runner(command, args, options));
        body.workflow_runs[0].conclusion = "failure";
        return JSON.stringify(body);
      }
      return runner(command, args, options);
    };
    f.ctx.ui.confirm = async (message) => {
      if (message === "fixture SQL confirmation") now = 301_000;
      return true;
    };
    try {
      const result = await runRelease(f.ctx, "app", undefined, {
        ciNow: () => now,
        ciSleep: async () => {},
        migrate: async (ctx, _commit, beforeApply) => {
          await ctx.ui.confirm("fixture SQL confirmation");
          assert.equal(typeof beforeApply, "function");
          await beforeApply!();
          writes++;
          return {
            state: "applied",
            ref: "b".repeat(20),
            files: ["1_fixture.sql"],
          };
        },
      });
      assert.equal(result.state, "failed");
      assert.equal(result.phase, "pre-migration-check");
      assert.equal(result.database, "not-run");
      assert.equal(writes, 0);
      assert.ok(!logs.some((line) => line.includes("数据库可能已有变更")));
      assert.equal(
        f.calls.filter((call) => call.cmd === process.execPath).length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("CI fallback confirmation cannot hide changed source or expiry during the final source check", async () => {
  const { CommandExecutionError } = await import("../src/process.ts");
  for (const scenario of ["source", "expiry"]) {
    const f = await fixture();
    let reads = 0,
      confirmed = false,
      now = 0,
      migrated = false;
    f.ctx.config.release!.ciTransientFallback = {
      environments: ["staging"],
      maxAgeSeconds: 300,
    };
    const runner = f.ctx.runner;
    f.ctx.runner = async (command, args, options) => {
      if (command === "gh" && reads++ > 0)
        throw new CommandExecutionError("gh", 1, {
          httpStatus: 429,
          retryAfterSeconds: 60,
        });
      if (command === "git" && confirmed) {
        if (scenario === "expiry") now = 301_000;
        else if (args.includes("rev-parse")) return "b".repeat(40);
      }
      return runner(command, args, options);
    };
    f.ctx.ui.confirm = async (message) => {
      if (message.includes("GitHub 暂时")) confirmed = true;
      return true;
    };
    try {
      const result = await runRelease(f.ctx, "app", undefined, {
        ciNow: () => now,
        ciSleep: async () => {},
        migrate: async () => {
          migrated = true;
          return undefined;
        },
      });
      assert.equal(result.state, "failed");
      assert.equal(migrated, false);
    } finally {
      await f.close();
    }
  }
});
