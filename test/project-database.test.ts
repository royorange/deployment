import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runProjectDatabase } from "../src/project-database.ts";
import { databaseOutput } from "../src/project-database-protocol.ts";
import type { Context } from "../src/wizard.ts";

const commit = "a".repeat(40),
  ref = "b".repeat(20);
const sql = "select 1;\n";
const blob = createHash("sha1")
  .update(`blob ${Buffer.byteLength(sql)}\0${sql}`)
  .digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-database-"));
  await mkdir(join(root, "deploy"));
  await writeFile(join(root, "deploy/database.mts"), "// fixture");
  const calls: Array<{
    phase: string;
    request: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  }> = [];
  const logs: string[] = [];
  let applied = false;
  const ctx: Context = {
    root,
    env: "staging",
    config: {
      version: 1,
      project: "fixture",
      repository: "owner/fixture",
      environments: ["staging"],
      migrationStrategy: "project-managed",
      variables: {
        supabaseProjectRef: "REF",
        migrationDatabaseUrl: "DB",
        executorCredential: "EXECUTOR",
      },
      extraFields: {
        migrationDatabaseUrl: { label: "DB", kind: "text", secret: true },
        executorCredential: { label: "Executor", kind: "text", secret: true },
      },
      release: {
        adapter: "deploy/database.mts",
        ciWorkflow: "ci.yml",
        environments: ["staging"],
        components: [],
        database: {
          adapter: "deploy/database.mts",
          environments: ["staging"],
          ledger: "public.schema_migrations",
          sourcePaths: ["supabase/migrations"],
          credentialField: "migrationDatabaseUrl",
          runtimeFields: ["executorCredential"],
        },
      },
    },
    data: {
      credentials: { management: "management-secret" },
      profiles: {
        [JSON.stringify(["fixture", "staging"])]: {
          supabaseProjectRef: ref,
          migrationDatabaseUrl:
            "postgresql://postgres:fixture-password@db.bbbbbbbbbbbbbbbbbbbb.supabase.co:5432/postgres",
          executorCredential: "fixture-executor-secret",
        },
      },
    },
    save: async () => {},
    ui: {
      select: async () => "",
      input: async () => "",
      check: async () => [],
      confirm: async () => true,
      log: (line) => logs.push(line),
    },
    runner: async (command, args, options) => {
      if (command === "git") {
        if (args.includes("rev-parse")) return commit;
        if (args.includes("status")) return "";
        if (args.includes("get-url")) return "git@github.com:owner/fixture.git";
        if (args.includes("-v")) return "H deploy/database.mts\0";
        if (args.includes("ls-tree"))
          return `100644 blob ${blob}\tsupabase/migrations/1_initial.sql\0`;
        if (args.includes("show")) return sql;
        return "deploy/database.mts";
      }
      assert.equal(command, process.execPath);
      const request = JSON.parse(options!.input!);
      const phase = args.at(-1)!;
      calls.push({ phase, request, env: options?.env });
      if (phase === "apply") {
        assert.equal(request.expectedToken, "c".repeat(64));
        applied = true;
      }
      const {
        version,
        repository,
        project,
        environment,
        commit: sha,
        target,
        sourceDigest,
      } = request;
      return JSON.stringify({
        version,
        repository,
        project,
        environment,
        commit: sha,
        target,
        sourceDigest,
        ready: true,
        summary: [],
        missing: [],
        effects: applied ? [] : ["apply 1_initial.sql"],
        snapshot: {
          token: (applied ? "d" : "c").repeat(64),
          state: applied ? "up-to-date" : "pending",
          pending: applied ? [] : ["1"],
          verification: "versions-only",
        },
      });
    },
  };
  return {
    ctx,
    calls,
    logs,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("database freezes committed SQL, rechecks before apply and excludes other credentials", async () => {
  const f = await fixture();
  let checks = 0;
  try {
    const result = await runProjectDatabase(f.ctx, commit, async () => {
      checks++;
    });
    assert.equal(result?.state, "applied");
    assert.equal(result?.verification, "versions-only");
    assert.deepEqual(
      f.calls.map((c) => c.phase),
      ["inspect", "plan", "inspect", "apply", "verify"],
    );
    assert.equal(checks, 1);
    for (const call of f.calls) {
      assert.ok(!JSON.stringify(call).includes("management-secret"));
      assert.ok(!JSON.stringify(call.env).includes("fixture-password"));
      assert.deepEqual(call.request.sources, [
        {
          path: "supabase/migrations/1_initial.sql",
          sql,
          sha256: createHash("sha256").update(sql).digest("hex"),
        },
      ]);
    }
    assert.ok(!JSON.stringify([result, f.logs]).includes("fixture-password"));
  } finally {
    await f.close();
  }
});
test("changed database state during confirmation stops before apply", async () => {
  const f = await fixture();
  let reads = 0;
  const base = f.ctx.runner;
  f.ctx.runner = async (cmd, args, opts) => {
    const raw = await base(cmd, args, opts);
    if (
      cmd === process.execPath &&
      args.at(-1) === "inspect" &&
      ++reads === 2
    ) {
      const body = JSON.parse(raw);
      body.snapshot.token = "e".repeat(64);
      return JSON.stringify(body);
    }
    return raw;
  };
  try {
    await assert.rejects(
      runProjectDatabase(f.ctx, commit, async () => {}),
      /状态|计划/,
    );
    assert.ok(!f.calls.some((c) => c.phase === "apply"));
  } finally {
    await f.close();
  }
});
test("cancelled database plan never applies and reports no completion", async () => {
  const f = await fixture();
  f.ctx.ui.confirm = async () => false;
  try {
    assert.equal(
      await runProjectDatabase(f.ctx, commit, async () => {}),
      undefined,
    );
    assert.ok(!f.calls.some((c) => c.phase === "apply"));
  } finally {
    await f.close();
  }
});
test("database adapter output binds target and source and rejects unknown fields", async () => {
  const f = await fixture();
  try {
    await runProjectDatabase(f.ctx, commit, async () => {});
    const request = f.calls[0]!.request;
    const raw = await f.ctx.runner(process.execPath, ["--phase", "inspect"], {
      input: JSON.stringify(request),
    });
    for (const change of [
      { sourceDigest: "f".repeat(64) },
      { commit: "f".repeat(40) },
      { unexpected: true },
      {
        target: {
          provider: "supabase",
          projectRef: "x".repeat(20),
          ledger: "public.schema_migrations",
        },
      },
    ])
      assert.throws(() =>
        databaseOutput(
          JSON.stringify({ ...JSON.parse(raw), ...change }),
          request as never,
        ),
      );
  } finally {
    await f.close();
  }
});
test("database errors and echoed credentials are redacted even after profile mutation", async () => {
  const f = await fixture();
  const base = f.ctx.runner;
  f.ctx.runner = async (cmd, args, opts) => {
    if (cmd === process.execPath) {
      f.ctx.data.profiles = {};
      throw new Error("fixture-executor-secret");
    }
    return base(cmd, args, opts);
  };
  try {
    await assert.rejects(
      runProjectDatabase(f.ctx, commit, async () => {}),
      (e) =>
        e instanceof Error && !e.message.includes("fixture-executor-secret"),
    );
  } finally {
    await f.close();
  }
});

test("up-to-date database is read again without applying or asking for a write", async () => {
  const f = await fixture();
  const base = f.ctx.runner;
  let confirms = 0,
    checks = 0;
  f.ctx.ui.confirm = async () => {
    confirms++;
    return true;
  };
  f.ctx.runner = async (cmd, args, opts) => {
    const raw = await base(cmd, args, opts);
    if (cmd !== process.execPath) return raw;
    const output = JSON.parse(raw);
    output.snapshot = {
      token: "d".repeat(64),
      state: "up-to-date",
      pending: [],
      verification: "versions-only",
    };
    return JSON.stringify(output);
  };
  try {
    const result = await runProjectDatabase(f.ctx, commit, async () => {
      checks++;
    });
    assert.equal(result?.state, "up-to-date");
    assert.equal(confirms, 0);
    assert.equal(checks, 0);
    assert.deepEqual(
      f.calls.map((c) => c.phase),
      ["inspect", "plan", "verify"],
    );
  } finally {
    await f.close();
  }
});

test("unknown state, failed verify, wrong identity and invalid results fail closed", async () => {
  for (const scenario of [
    "unknown",
    "verify",
    "identity",
    "missing",
    "invalid-json",
    "too-large",
    "pending-empty",
    "unexpected-snapshot",
  ]) {
    const f = await fixture();
    const base = f.ctx.runner;
    f.ctx.runner = async (cmd, args, opts) => {
      const raw = await base(cmd, args, opts);
      if (cmd !== process.execPath) return raw;
      if (scenario === "invalid-json") return "not json";
      if (scenario === "too-large") return "x".repeat(100001);
      const output = JSON.parse(raw);
      if (scenario === "unknown") output.snapshot.state = "unknown";
      if (scenario === "verify" && args.at(-1) === "verify")
        output.snapshot = {
          ...output.snapshot,
          state: "pending",
          pending: ["1"],
        };
      if (scenario === "identity") output.project = "other";
      if (scenario === "missing") output.missing = ["executor unavailable"];
      if (scenario === "pending-empty") output.snapshot.pending = [];
      if (scenario === "unexpected-snapshot")
        output.snapshot.secret = "forbidden";
      return JSON.stringify(output);
    };
    try {
      await assert.rejects(runProjectDatabase(f.ctx, commit, async () => {}));
      if (scenario !== "verify")
        assert.ok(!f.calls.some((c) => c.phase === "apply"));
    } finally {
      await f.close();
    }
  }
});

test("changed source and target during confirmation prevent writes", async () => {
  for (const change of ["target", "source", "plan"]) {
    const f = await fixture();
    const base = f.ctx.runner;
    let changed = false;
    f.ctx.ui.confirm = async () => {
      changed = true;
      if (change === "target")
        f.ctx.data.profiles[
          JSON.stringify(["fixture", "staging"])
        ]!.supabaseProjectRef = "e".repeat(20);
      return true;
    };
    f.ctx.runner = async (cmd, args, opts) => {
      if (
        changed &&
        change === "source" &&
        cmd === "git" &&
        args.includes("status")
      )
        return " M database";
      const raw = await base(cmd, args, opts);
      if (
        change === "plan" &&
        cmd === process.execPath &&
        args.at(-1) === "plan"
      ) {
        const body = JSON.parse(raw);
        body.snapshot.token = "e".repeat(64);
        return JSON.stringify(body);
      }
      return raw;
    };
    try {
      await assert.rejects(runProjectDatabase(f.ctx, commit, async () => {}));
      assert.ok(!f.calls.some((c) => c.phase === "apply"));
    } finally {
      await f.close();
    }
  }
});

test("pre-apply CI failure and production decline prevent SQL execution", async () => {
  for (const scenario of ["ci", "production"]) {
    const f = await fixture();
    let started = false;
    if (scenario === "production") {
      f.ctx.env = "production";
      f.ctx.config.release!.database!.environments.push("production");
      f.ctx.data.profiles[JSON.stringify(["fixture", "production"])] =
        f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])]!;
    }
    try {
      if (scenario === "ci")
        await assert.rejects(
          runProjectDatabase(
            f.ctx,
            commit,
            async () => {
              throw new Error("CI changed");
            },
            () => {
              started = true;
            },
          ),
          /CI/,
        );
      else
        assert.equal(
          await runProjectDatabase(
            f.ctx,
            commit,
            async () => {},
            () => {
              started = true;
            },
          ),
          undefined,
        );
      assert.equal(started, false);
      assert.ok(!f.calls.some((c) => c.phase === "apply"));
    } finally {
      await f.close();
    }
  }
});

test("database requires scoped credentials and matching Supabase target before adapter invocation", async () => {
  for (const scenario of [
    "missing",
    "shared",
    "url",
    "disabled",
    "credential-definition",
  ]) {
    const f = await fixture();
    const profile =
      f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])]!;
    if (scenario === "missing") delete profile.migrationDatabaseUrl;
    if (scenario === "url")
      profile.supabaseUrl = `https://${"x".repeat(20)}.supabase.co`;
    if (scenario === "disabled")
      f.ctx.config.release!.database!.environments = [];
    if (scenario === "credential-definition")
      f.ctx.config.extraFields!.migrationDatabaseUrl!.secret = false;
    if (scenario === "shared")
      f.ctx.config.release!.components = [
        {
          id: "app",
          label: "app",
          kind: "application",
          requiresDevice: false,
          migrations: "project-managed",
          runtimeFields: ["migrationDatabaseUrl"],
        },
      ];
    try {
      await assert.rejects(runProjectDatabase(f.ctx, commit, async () => {}));
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("SQL snapshots reject mutable bytes, symlinks, duplicate files and missing declared sources", async () => {
  const { databaseSources } =
    await import("../src/project-database-sources.ts");
  for (const scenario of [
    "bytes",
    "symlink",
    "duplicate",
    "empty",
    "missing",
    "outside",
    "non-sql",
    "invalid-path",
  ]) {
    const f = await fixture();
    const base = f.ctx.runner;
    f.ctx.runner = async (cmd, args, opts) => {
      if (cmd === "git" && args.includes("show") && scenario === "bytes")
        return "modified";
      if (cmd === "git" && args.includes("ls-tree")) {
        if (scenario === "empty") return "";
        const row = `100644 blob ${blob}\tsupabase/migrations/1_initial.sql\0`;
        if (scenario === "symlink") return row.replace("100644", "120000");
        if (scenario === "duplicate") return row + row;
        if (scenario === "outside")
          return row.replace("supabase/migrations/", "other/");
        if (scenario === "non-sql") return row.replace(".sql", ".md");
      }
      return base(cmd, args, opts);
    };
    try {
      await assert.rejects(
        databaseSources(
          f.ctx.root,
          commit,
          scenario === "missing"
            ? ["supabase/migrations", "supabase/absent.sql"]
            : scenario === "invalid-path"
              ? ["../sql"]
              : ["supabase/migrations"],
          f.ctx.runner,
        ),
      );
    } finally {
      await f.close();
    }
  }
});
