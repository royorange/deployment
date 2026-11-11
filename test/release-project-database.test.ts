import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runRelease } from "../src/release-engine.ts";
import { fixture } from "./release-fixture.ts";
test("composite application Cloudflare capability injects only deployment and verification", async () => {
  const f = await fixture();
  let resolved = 0;
  try {
    const component = f.ctx.config.release!.components[0]!;
    component.migrations = "none";
    component.providerOperations = ["cloudflare-deploy"];
    const result = await runRelease(f.ctx, "app", undefined, {
      cloudflareToken: async () => {
        resolved++;
        return "operation-only-secret";
      },
    });
    assert.equal(result.state, "health-checked");
    const adapters = f.calls.filter((call) => call.cmd === process.execPath);
    assert.equal(adapters[0]!.env?.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(
      adapters[1]!.env?.CLOUDFLARE_API_TOKEN,
      "operation-only-secret",
    );
    assert.equal(
      adapters[2]!.env?.CLOUDFLARE_API_TOKEN,
      "operation-only-secret",
    );
    assert.equal(resolved, 1);
  } finally {
    await f.close();
  }
});

test("project-managed database stages gate application and preserve truthful failure receipts", async () => {
  const { createHash } = await import("node:crypto");
  const sql = "select 1;\n";
  const blob = createHash("sha1")
    .update(`blob ${Buffer.byteLength(sql)}\0${sql}`)
    .digest("hex");
  for (const scenario of [
    "success",
    "apply-failure",
    "inspect-failure",
    "cancel",
  ] as const) {
    const f = await fixture();
    const phases: string[] = [];
    let applied = false;
    try {
      await writeFile(
        join(f.ctx.root, "deploy/database.mts"),
        "// fixture database",
      );
      f.ctx.config.migrationStrategy = "project-managed";
      f.ctx.config.release!.components[0]!.migrations = "project-managed";
      f.ctx.config.variables = {
        ...f.ctx.config.variables,
        supabaseProjectRef: "REF",
        migrationDatabaseUrl: "DATABASE",
      };
      f.ctx.config.extraFields = {
        migrationDatabaseUrl: { label: "DB", kind: "text", secret: true },
      };
      f.ctx.config.release!.database = {
        adapter: "deploy/database.mts",
        environments: ["staging"],
        ledger: "public.schema_migrations",
        sourcePaths: ["supabase/migrations"],
        credentialField: "migrationDatabaseUrl",
      };
      f.ctx.data.profiles[JSON.stringify(["fixture", "staging"])] = {
        supabaseProjectRef: "b".repeat(20),
        migrationDatabaseUrl: "synthetic-database-credential",
      };
      f.ctx.ui.confirm = async (message) =>
        !(scenario === "cancel" && message.startsWith("执行以上项目数据库"));
      const base = f.ctx.runner;
      f.ctx.runner = async (command, args, options) => {
        if (command === "git") {
          if (args.includes("ls-tree"))
            return `100644 blob ${blob}\tsupabase/migrations/1_fixture.sql\0`;
          if (args.includes("show")) return sql;
          if (args.includes("--error-unmatch")) return args.at(-1)!;
        }
        const raw = await base(command, args, options);
        if (command !== process.execPath) return raw;
        const phase = args.at(-1)!;
        if (!args.some((arg) => arg.endsWith("/database.mts"))) {
          phases.push(`app:${phase}`);
          assert.ok(!options!.input!.includes("synthetic-database-credential"));
          return raw;
        }
        phases.push(`database:${phase}`);
        if (phase === "apply") {
          applied = true;
          if (scenario === "apply-failure") throw new Error("failed write");
        }
        const request = JSON.parse(options!.input!);
        const {
          version,
          repository,
          project,
          environment,
          commit,
          target,
          sourceDigest,
        } = request;
        return JSON.stringify({
          version,
          repository,
          project,
          environment,
          commit,
          target,
          sourceDigest,
          ready: scenario !== "inspect-failure",
          summary: [],
          missing: [],
          effects: [],
          snapshot: {
            token: (applied ? "d" : "c").repeat(64),
            state: applied ? "up-to-date" : "pending",
            pending: applied ? [] : ["1"],
            verification: "versions-only",
          },
        });
      };
      const result = await runRelease(f.ctx, "app");
      assert.equal(
        result.state,
        scenario === "success"
          ? "health-checked"
          : scenario === "cancel"
            ? "cancelled"
            : "failed",
      );
      assert.equal(
        result.database,
        scenario === "success"
          ? "applied"
          : scenario === "apply-failure"
            ? "unknown"
            : "not-run",
      );
      if (scenario === "success") {
        assert.equal(result.databaseEvidence?.verification, "versions-only");
        assert.ok(
          phases.indexOf("database:verify") < phases.indexOf("app:deploy"),
        );
      } else assert.ok(!phases.includes("app:deploy"));
      assert.ok(
        !JSON.stringify(result).includes("synthetic-database-credential"),
      );
    } finally {
      await f.close();
    }
  }
});
