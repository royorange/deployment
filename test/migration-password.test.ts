import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../src/config.ts";
import { StateStore } from "../src/state.ts";
import { releaseRuntimeValues } from "../src/release-runtime.ts";
import { runRelease } from "../src/release-engine.ts";
import {
  modules,
  releaseMigrations,
  safeMessage,
  type Context,
} from "../src/wizard.ts";

const password = "synthetic-database-password";
const ref = "a".repeat(20);
const identity = "11111111-1111-4111-8111-111111111111";
const file = "202610120001_initial.sql";
async function fixture(passwordValue = password) {
  const root = await mkdtemp(join(tmpdir(), "migration-password-"));
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  await writeFile(join(root, "supabase/migrations", file), "select 1;");
  const calls: string[][] = [],
    prompts: string[] = [],
    confirmations: string[] = [],
    logs: string[] = [];
  let output = "Remote database is up to date.";
  const ctx: Context = {
    root,
    env: "staging",
    storageMode: "metadata",
    config: {
      version: 1,
      project: "fixture",
      environments: ["staging"],
      migrationStrategy: "supabase-cli",
      variables: { supabaseProjectRef: "PROJECT_REF" },
    },
    data: {
      credentials: {},
      profiles: {
        [projectKey("fixture", "staging")]: {
          "@supabaseSource": "cli",
          "@supabaseProfile": "fixture",
          "@supabaseIdentity": identity,
          supabaseProjectRef: ref,
        },
      },
    },
    save: async () => {},
    ui: {
      input: async (message, options) => {
        prompts.push(message);
        assert.equal(options?.secret, true);
        return passwordValue;
      },
      confirm: async (message) => {
        confirmations.push(message);
        return true;
      },
      select: async () => "",
      check: async () => [],
      log: (message) => logs.push(message),
    },
    runner: async (_command, args, options) => {
      calls.push([...args]);
      assert.ok(!JSON.stringify(args).includes(passwordValue));
      if (args[0] === "--version") return "2.120.0";
      if (args[0] === "whoami")
        return JSON.stringify({ id: identity, email: "fixture@example.test" });
      if (args[0] === "db")
        assert.equal(options?.env?.SUPABASE_DB_PASSWORD, passwordValue);
      return args.includes("--dry-run") ? output : "";
    },
  };
  return {
    ctx,
    calls,
    prompts,
    confirmations,
    logs,
    setOutput: (value: string) => {
      output = value;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
const manual = (ctx: Context) =>
  modules
    .find((module) => module.id === "supabase")!
    .actions.find((action) => action.id === "migrations")!
    .execute(ctx);

test("release retry reuses only the process password while rechecking identity and the CLI ledger", async () => {
  const f = await fixture();
  try {
    await releaseMigrations(f.ctx);
    const firstChecks = f.calls.filter((args) => args[0] === "whoami").length;
    await releaseMigrations(f.ctx);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.confirmations.length, 0);
    assert.equal(
      f.calls.filter((args) => args.includes("--dry-run")).length,
      2,
    );
    assert.ok(
      f.calls.filter((args) => args[0] === "whoami").length > firstChecks,
    );
    assert.ok(f.logs.some((message) => /只读.*账本/.test(message)));
    assert.ok(!f.logs.join("\n").includes(password));
  } finally {
    await f.close();
  }
});
test("application failure retains the verified password without handing it to adapters or receipts", async () => {
  for (const phase of ["deploy", "verify"]) {
    const f = await fixture();
    try {
      const sha = "c".repeat(40);
      await mkdir(join(f.ctx.root, "deploy"));
      await writeFile(
        join(f.ctx.root, "deploy/release.mts"),
        "// synthetic fixture",
      );
      f.ctx.config.repository = "owner/fixture";
      f.ctx.config.release = {
        adapter: "deploy/release.mts",
        ciWorkflow: "ci.yml",
        environments: ["staging"],
        components: [
          {
            id: "app",
            label: "App",
            kind: "application",
            requiresDevice: false,
            migrations: "supabase-cli",
            runtimeFields: [],
          },
        ],
      };
      f.ctx.releaseDirectory = join(f.ctx.root, "receipts");
      const runner = f.ctx.runner;
      let fail = true;
      f.ctx.runner = async (command, args, options) => {
        if (command === "git") {
          if (args.includes("rev-parse")) return sha;
          if (args.includes("status")) return "";
          if (args.includes("get-url"))
            return "git@github.com:owner/fixture.git";
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
        if (command === process.execPath) {
          assert.ok(!JSON.stringify([args, options]).includes(password));
          if (fail && args.at(-1) === phase)
            throw new Error(`complete failed ${password}`);
          return JSON.stringify({
            ready: true,
            summary: [],
            missing: [],
            effects: [],
          });
        }
        return runner(command, args, options);
      };
      const migrate = (ctx: Context) => releaseMigrations(ctx);
      const failed = await runRelease(f.ctx, "app", undefined, { migrate });
      assert.equal(failed.state, "failed");
      assert.equal(failed.database, "up-to-date");
      assert.ok(f.ctx.runtime?.supabaseDatabasePassword);
      fail = false;
      assert.equal(
        (await runRelease(f.ctx, "app", undefined, { migrate })).state,
        "health-checked",
      );
      assert.equal(f.prompts.length, 1);
      assert.equal(
        f.calls.filter((args) => args.includes("--dry-run")).length,
        2,
      );
      assert.ok(!f.logs.join("\n").includes(password));
      const { readdir } = await import("node:fs/promises");
      for (const name of await readdir(f.ctx.releaseDirectory))
        assert.ok(
          !(
            await readFile(join(f.ctx.releaseDirectory, name), "utf8")
          ).includes(password),
        );
    } finally {
      await f.close();
    }
  }
});
test("manual migration keeps the preview confirmation and cancelling does not verify a candidate", async () => {
  const f = await fixture();
  try {
    f.ctx.ui.confirm = async (message) => {
      f.confirmations.push(message);
      return false;
    };
    await manual(f.ctx);
    assert.equal(f.calls.filter((args) => args[0] === "db").length, 0);
    await manual(f.ctx);
    assert.equal(f.prompts.length, 2);
    assert.equal(f.confirmations.length, 2);
  } finally {
    await f.close();
  }
});
test("unknown CLI output and rejected first password never create a reusable credential", async () => {
  for (const failure of ["unknown", "authentication"]) {
    const f = await fixture();
    try {
      const runner = f.ctx.runner;
      if (failure === "unknown") f.setOutput("unrecognized database response");
      else
        f.ctx.runner = async (command, args, options) => {
          if (args.includes("--dry-run"))
            throw new Error(`rejected ${password}`);
          return runner(command, args, options);
        };
      await assert.rejects(
        releaseMigrations(f.ctx),
        (error) => error instanceof Error && !error.message.includes(password),
      );
      assert.equal(f.ctx.runtime?.supabaseDatabasePassword, undefined);
      f.ctx.runner = runner;
      f.setOutput("Remote database is up to date.");
      await releaseMigrations(f.ctx);
      assert.equal(f.prompts.length, 2);
    } finally {
      await f.close();
    }
  }
});
test("a cached password rejection clears it and redacts errors before retrying input", async () => {
  const f = await fixture();
  try {
    await releaseMigrations(f.ctx);
    assert.equal(
      safeMessage(new Error(`sensitive ${password}`), f.ctx),
      "sensitive [已隐藏]",
    );
    const runner = f.ctx.runner;
    f.ctx.runner = async (command, args, options) => {
      if (args.includes("--dry-run")) throw new Error(`expired ${password}`);
      return runner(command, args, options);
    };
    await assert.rejects(
      releaseMigrations(f.ctx),
      (error) =>
        error instanceof Error &&
        /expired/.test(error.message) &&
        !error.message.includes(password),
    );
    assert.equal(f.ctx.runtime?.supabaseDatabasePassword, undefined);
    f.ctx.runner = runner;
    await releaseMigrations(f.ctx);
    assert.equal(f.prompts.length, 2);
  } finally {
    await f.close();
  }
});
test("candidate and cached database errors redact URI and JSON encodings and reject raw error names", async () => {
  const special = 'synthetic@db:/\\"%中文';
  const encoded = encodeURIComponent(special);
  const uri = new URL("https://example.invalid");
  uri.password = special;
  const json = JSON.stringify(special).slice(1, -1);
  const forms = [
    special,
    encoded,
    encoded.replace(/%[A-F0-9]{2}/g, (part) => part.toLowerCase()),
    encodeURI(special),
    uri.password,
    json,
    json.replaceAll("/", "\\/"),
  ];
  for (const cached of [false, true]) {
    const f = await fixture(special);
    try {
      if (cached) await releaseMigrations(f.ctx);
      const runner = f.ctx.runner;
      f.ctx.runner = async (command, args, options) => {
        if (args.includes("--dry-run")) {
          const error = new Error(
            `authentication failed: ${forms.join(" | ")}`,
          );
          error.name = `secret-name-${encoded}`;
          throw error;
        }
        return runner(command, args, options);
      };
      await assert.rejects(releaseMigrations(f.ctx), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "Error");
        assert.match(error.message, /authentication failed/);
        for (const form of forms) assert.ok(!error.message.includes(form));
        return true;
      });
      assert.equal(f.ctx.runtime?.supabaseDatabasePassword, undefined);
      assert.equal(f.ctx.runtime?.transientSupabaseDatabasePassword, undefined);
      assert.ok(!f.logs.join("\n").includes(encoded));
    } finally {
      await f.close();
    }
  }
});
test("database secret redaction handles unpaired Unicode surrogates without throwing", async () => {
  const f = await fixture();
  try {
    const value = "synthetic-\ud800-password";
    f.ctx.runtime = { statuses: {}, transientSupabaseDatabasePassword: value };
    const message = safeMessage(
      new Error(`${value} ${JSON.stringify(value).slice(1, -1)}`),
      f.ctx,
    );
    assert.equal(message, "[已隐藏] [已隐藏]");
  } finally {
    await f.close();
  }
});
test("target and identity binding changes replace the single cached slot", async () => {
  for (const change of ["ref", "profile", "environment", "source"] as const) {
    const f = await fixture();
    try {
      await releaseMigrations(f.ctx);
      const before = structuredClone(f.ctx.data);
      const p = f.ctx.data.profiles[projectKey("fixture", "staging")]!;
      if (change === "ref") p.supabaseProjectRef = "b".repeat(20);
      if (change === "profile") p["@supabaseProfile"] = "another";
      if (change === "environment") {
        f.ctx.env = "development";
        f.ctx.data.profiles[projectKey("fixture", "development")] = { ...p };
      }
      if (change === "source") {
        p["@supabaseSource"] = "token";
        p["@supabase"] = "supabase/personal";
        p["@supabaseIdentityMode"] = "resource";
        p["@supabaseOrganization"] = "org-fixture";
        f.ctx.data.credentials["supabase/personal"] = "synthetic-pat";
        f.ctx.fetcher = async () =>
          Response.json({ id: ref, organization_id: "org-fixture" });
      }
      await releaseMigrations(f.ctx);
      assert.equal(f.prompts.length, 2);
      f.ctx.data = before;
      f.ctx.env = "staging";
      await releaseMigrations(f.ctx);
      assert.equal(f.prompts.length, 3);
    } finally {
      await f.close();
    }
  }
});
test("verified passwords stay outside save data, public disk and adapter runtime fields", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.ctx.data);
    await releaseMigrations(f.ctx);
    assert.deepEqual(f.ctx.data, before);
    const state = await StateStore.open(f.ctx.root, f.ctx.root, f.ctx.config);
    f.ctx.save = async () => {
      assert.ok(!JSON.stringify(f.ctx.data).includes(password));
      await state.save(f.ctx.data);
    };
    await f.ctx.save();
    assert.ok(!(await readFile(state.path, "utf8")).includes(password));
    assert.deepEqual(
      await releaseRuntimeValues(f.ctx, {
        id: "app",
        label: "App",
        kind: "application",
        requiresDevice: true,
        migrations: "supabase-cli",
        runtimeFields: [],
      }),
      {},
    );
    assert.ok(!JSON.stringify(f.ctx.data).includes(password));
  } finally {
    await f.close();
  }
});
test("cancelling actual migration apply never writes and an interrupted verification clears the cache", async () => {
  const f = await fixture();
  try {
    f.setOutput(file);
    f.ctx.ui.confirm = async () => false;
    assert.equal(await releaseMigrations(f.ctx), undefined);
    assert.equal(
      f.calls.filter((args) => args[0] === "db" && !args.includes("--dry-run"))
        .length,
      0,
    );
    f.ctx.runner = async () => {
      const error = new Error(`aborted ${password}`);
      error.name = "AbortPromptError";
      throw error;
    };
    assert.equal(await releaseMigrations(f.ctx), undefined);
    assert.equal(f.ctx.runtime?.supabaseDatabasePassword, undefined);
    assert.ok(!f.logs.join("\n").includes(password));
  } finally {
    await f.close();
  }
});
