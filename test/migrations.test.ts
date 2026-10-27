import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationSession } from "../src/migrations.ts";
import { run, type RunOptions } from "../src/process.ts";
import { releaseMigrations, type Context } from "../src/wizard.ts";
import { projectKey } from "../src/config.ts";

test("official-profile migrations recheck the account before apply and do not receive a management PAT", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-migration-test-"));
  const uid = "11111111-1111-4111-8111-111111111111";
  let currentIdentity = uid;
  let applies = 0;
  try {
    await mkdir(join(root, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase/migrations/202610120001_initial.sql"),
      "select 1;",
    );
    const session = await migrationSession(
      root,
      "a".repeat(20),
      undefined,
      "fixture-password",
      async (_command, args, options) => {
        if (args[0] === "--version") return "2.120.0";
        assert.ok(args.includes("--profile") && args.includes("fulcord-new"));
        assert.equal(options?.env?.SUPABASE_ACCESS_TOKEN, undefined);
        if (args[0] === "whoami")
          return JSON.stringify({
            id: currentIdentity,
            email: "user@example.test",
          });
        if (args[0] === "db" && !args.includes("--dry-run")) applies++;
        return "202610120001_initial.sql";
      },
      { profile: "fulcord-new", identity: uid },
    );
    try {
      await session.preview();
      currentIdentity = "22222222-2222-4222-8222-222222222222";
      await assert.rejects(session.apply(), /身份已变化/);
    } finally {
      await session.close();
    }
    assert.equal(applies, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration preview/apply uses isolated immutable snapshot, skips Vault and never passes passwords as arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-migration-test-"));
  const calls: Array<{ args: string[]; options?: RunOptions }> = [];
  let workdir = "";
  try {
    await mkdir(join(root, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase/migrations/202610120001_initial.sql"),
      "select 1;",
    );
    await writeFile(
      join(root, "supabase/config.toml"),
      "project_id = 'never-copy-local-config'",
    );
    const session = await migrationSession(
      root,
      "a".repeat(20),
      "fixture-pat",
      "fixture-password",
      async (_command, args, options) => {
        calls.push({ args, options });
        if (args[0] === "--version") return "2.120.0";
        workdir = options!.cwd!;
        return "";
      },
    );
    try {
      assert.notEqual(workdir, root);
      await writeFile(
        join(root, "supabase/migrations/202610120001_initial.sql"),
        "drop table changed;",
      );
      await assert.rejects(session.apply(), /先完成预演/);
      await session.preview();
      assert.equal(
        await readFile(
          join(workdir, "supabase/migrations/202610120001_initial.sql"),
          "utf8",
        ),
        "select 1;",
      );
      await session.apply();
      const pushes = calls.filter((call) => call.args[0] === "db");
      assert.equal(pushes.length, 2);
      assert.ok(
        pushes.every(
          (call) =>
            call.args.includes("--skip-vault") &&
            call.args.includes("--project-ref") &&
            call.args.includes("a".repeat(20)),
        ),
      );
      assert.ok(pushes[0]?.args.includes("--dry-run"));
      assert.ok(!pushes[1]?.args.includes("--dry-run"));
      assert.ok(
        calls.every((call) => !call.args.join(" ").includes("fixture-")),
      );
      assert.equal(
        pushes[1]?.options?.env?.SUPABASE_DB_PASSWORD,
        "fixture-password",
      );
    } finally {
      await session.close();
    }
    await assert.rejects(stat(workdir));
    assert.match(
      await readFile(join(root, "supabase/config.toml"), "utf8"),
      /never-copy/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration history failure prevents application and removes temporary link state", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-migration-test-"));
  let workdir = "";
  let writes = 0;
  try {
    await mkdir(join(root, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase/migrations/202610120001_initial.sql"),
      "select 1;",
    );
    const session = await migrationSession(
      root,
      "a".repeat(20),
      "fixture-pat",
      "fixture-password",
      async (_command, args, options) => {
        if (args[0] === "--version") return "2.120.0";
        workdir = options!.cwd!;
        if (args.includes("--dry-run")) throw new Error("history mismatch");
        if (args[0] === "db") writes++;
        return "";
      },
    );
    try {
      await assert.rejects(session.preview());
      await assert.rejects(session.apply(), /先完成预演/);
    } finally {
      await session.close();
    }
    assert.equal(writes, 0);
    await assert.rejects(stat(workdir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource-scoped migrations revalidate organization before link, preview and apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-resource-migration-"));
  let allowed = true;
  let verifications = 0;
  let applies = 0;
  try {
    await mkdir(join(root, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase/migrations/202610120001_initial.sql"),
      "select 1;",
    );
    const session = await migrationSession(
      root,
      "a".repeat(20),
      "sbp_fc_fixture",
      "fixture-password",
      async (_command, args) => {
        if (args[0] === "--version") return "2.120.0";
        assert.ok(!args.includes("whoami"));
        if (args[0] === "db" && !args.includes("--dry-run")) applies++;
        return "202610120001_initial.sql";
      },
      undefined,
      async () => {
        verifications++;
        if (!allowed) throw new Error("项目组织与绑定不同");
      },
    );
    try {
      await session.preview();
      assert.ok(verifications >= 3);
      allowed = false;
      await assert.rejects(session.apply(), /组织与绑定不同/);
      assert.equal(applies, 0);
    } finally {
      await session.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session only trusts exact successful up-to-date dry-run evidence and clears stale evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-migration-evidence-"));
  const file = "202610120001_initial.sql";
  try {
    await mkdir(join(root, "supabase/migrations"), { recursive: true });
    await writeFile(join(root, "supabase/migrations", file), "select 1;");
    let output = "Remote database is up to date.";
    let fail = false;
    const session = await migrationSession(
      root,
      "a".repeat(20),
      "fixture-token",
      "fixture-password",
      async (_command, args) => {
        if (args[0] === "--version") return "2.120.0";
        if (args.includes("--dry-run")) {
          if (fail) throw new Error("private output");
          return output;
        }
        return "";
      },
    );
    try {
      assert.equal(session.upToDate, false);
      for (const text of [
        "Remote database is up to date.",
        "Linked project is up to date.",
        "notice\nRemote database is up to date.\n",
      ]) {
        output = text;
        assert.deepEqual(await session.preview(), []);
        assert.equal(session.upToDate, true);
      }
      for (const text of [
        "",
        "Almost Remote database is up to date.",
        "Remote database is up to date. maybe",
        "Remote database is up to date.\n" + file,
      ]) {
        output = text;
        await session.preview();
        assert.equal(session.upToDate, false);
      }
      output = "Remote database is up to date.";
      await session.preview();
      await session.apply();
      assert.equal(session.upToDate, false);
      await session.preview();
      fail = true;
      await assert.rejects(session.preview());
      assert.equal(session.upToDate, false);
      await assert.rejects(session.apply(), /先完成预演/);
    } finally {
      await session.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const releaseRef = "a".repeat(20);
const releaseFile = "202610120001_initial.sql";
async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "setup-release-migrations-"));
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  await writeFile(join(root, "supabase/migrations", releaseFile), "select 1;");
  const calls: string[][] = [];
  const logs: string[] = [];
  const identity = "11111111-1111-4111-8111-111111111111";
  const inputs = ["fixture-db-password"];
  const prompts: string[] = [];
  const confirmations: string[] = [];
  let outputs = [releaseFile, "Remote database is up to date."];
  const ctx: Context = {
    root,
    env: "staging",
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
          supabaseProjectRef: releaseRef,
        },
      },
    },
    save: async () => {},
    ui: {
      input: async (message) => {
        prompts.push(message);
        return inputs.shift() ?? "";
      },
      confirm: async (message) => {
        confirmations.push(message);
        return true;
      },
      select: async () => "",
      check: async () => [],
      log: (s) => logs.push(s),
    },
    runner: async (command, args, options) => {
      assert.equal(command, "supabase");
      calls.push([...args]);
      assert.ok(!args.join(" ").includes("fixture-db-password"));
      assert.equal(options?.env?.SUPABASE_ACCESS_TOKEN, undefined);
      if (args[0] === "--version") return "2.120.0";
      if (args[0] === "whoami")
        return JSON.stringify({ id: identity, email: "fixture@example.test" });
      if (args.includes("--dry-run")) return outputs.shift() ?? "";
      if (args[0] === "db")
        assert.equal(options?.env?.SUPABASE_DB_PASSWORD, "fixture-db-password");
      return "";
    },
  };
  return {
    ctx,
    calls,
    logs,
    inputs,
    prompts,
    confirmations,
    setOutputs: (next: string[]) => {
      outputs = next;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("release migrations returns cancellation for installer, empty password and apply refusal", async () => {
  for (const stop of ["install", "password", "apply"]) {
    const f = await releaseFixture();
    try {
      if (stop === "install") f.ctx.ensureSupabaseCli = async () => false;
      if (stop === "password") f.inputs[0] = "";
      if (stop === "apply")
        f.ctx.ui.confirm = async (message) => !message.includes("实际应用");
      assert.equal(await releaseMigrations(f.ctx), undefined);
      assert.equal(
        f.calls.filter(
          (args) => args[0] === "db" && !args.includes("--dry-run"),
        ).length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});
test("release migrations accepts confirmed up-to-date evidence without writes or apply confirmation", async () => {
  const f = await releaseFixture();
  try {
    f.setOutputs(["Linked project is up to date."]);
    assert.deepEqual(await releaseMigrations(f.ctx), {
      state: "up-to-date",
      ref: releaseRef,
      files: [],
    });
    assert.equal(f.inputs.length, 0);
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.calls.filter((args) => args[0] === "db").length, 1);
  } finally {
    await f.close();
  }
});
test("release migrations blocks unknown dry-run output rather than assuming database initialized", async () => {
  const f = await releaseFixture();
  try {
    f.setOutputs([""]);
    await assert.rejects(releaseMigrations(f.ctx), /无法确认|未识别|未知/);
    assert.equal(
      f.calls.filter((args) => args[0] === "db" && !args.includes("--dry-run"))
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});
test("release migrations applies reviewed snapshot then verifies up-to-date before returning", async () => {
  const f = await releaseFixture();
  try {
    assert.deepEqual(await releaseMigrations(f.ctx), {
      state: "applied",
      ref: releaseRef,
      files: [releaseFile],
    });
    assert.equal(f.prompts.length, 1);
    assert.equal(f.confirmations.length, 1);
    assert.match(f.confirmations[0]!, /实际应用.*fixture\/staging/);
    assert.ok(f.logs.some((message) => message.includes(releaseRef)));
    const pushes = f.calls.filter((args) => args[0] === "db");
    assert.equal(pushes.length, 3);
    assert.ok(pushes[0]!.includes("--dry-run"));
    assert.ok(!pushes[1]!.includes("--dry-run"));
    assert.ok(pushes[2]!.includes("--dry-run"));
    assert.ok(
      f.calls.every(
        (args) =>
          !args.some((arg) =>
            ["reset", "repair", "seed", "down"].includes(arg),
          ),
      ),
    );
  } finally {
    await f.close();
  }
});
test("release migration post-apply uncertainty blocks application without database rollback", async () => {
  for (const failure of ["pending", "network"]) {
    const f = await releaseFixture();
    try {
      f.setOutputs([releaseFile, releaseFile]);
      if (failure === "network") {
        const original = f.ctx.runner;
        let dry = 0;
        f.ctx.runner = async (command, args, options) => {
          if (args.includes("--dry-run") && ++dry === 2)
            throw new Error("private database error");
          return original(command, args, options);
        };
      }
      await assert.rejects(
        releaseMigrations(f.ctx),
        (error) =>
          error instanceof Error &&
          /可能已应用/.test(error.message) &&
          !/private database error/.test(error.message),
      );
      assert.equal(
        f.calls.filter(
          (args) => args[0] === "db" && !args.includes("--dry-run"),
        ).length,
        1,
      );
      assert.ok(
        f.calls.every(
          (args) =>
            !args.includes("down") &&
            !args.includes("reset") &&
            !args.includes("repair"),
        ),
      );
    } finally {
      await f.close();
    }
  }
});
test("nonproduction migrations use a single boolean apply confirmation without typing the Ref", async () => {
  const f = await releaseFixture();
  try {
    f.ctx.env = "development";
    f.ctx.data.profiles[projectKey("fixture", "development")] =
      f.ctx.data.profiles[projectKey("fixture", "staging")]!;
    assert.equal((await releaseMigrations(f.ctx))?.state, "applied");
    assert.equal(f.prompts.length, 1);
    assert.equal(f.confirmations.length, 1);
    assert.match(f.confirmations[0]!, /fixture\/development/);
  } finally {
    await f.close();
  }
});
test("production migrations require the readable project/environment rather than a typed Ref", async () => {
  for (const answer of [
    "fixture/production",
    "wrong/production",
    releaseRef,
    "",
  ]) {
    const f = await releaseFixture();
    try {
      f.ctx.env = "production";
      f.ctx.data.profiles[projectKey("fixture", "production")] =
        f.ctx.data.profiles[projectKey("fixture", "staging")]!;
      f.inputs.push(answer);
      const result = await releaseMigrations(f.ctx);
      assert.equal(
        result?.state,
        answer === "fixture/production" ? "applied" : undefined,
      );
      assert.equal(f.confirmations.length, 0);
      assert.match(f.prompts[1]!, /fixture\/production/);
      assert.ok(!f.prompts[1]!.includes(releaseRef));
      assert.equal(
        f.calls.filter(
          (args) => args[0] === "db" && !args.includes("--dry-run"),
        ).length,
        answer === "fixture/production" ? 1 : 0,
      );
    } finally {
      await f.close();
    }
  }
});
test("migration apply confirmation cannot authorize a changed project, environment or binding", async () => {
  for (const change of [
    "ref",
    "environment",
    "project",
    "profile",
    "identity",
    "root",
  ] as const) {
    const f = await releaseFixture();
    try {
      const confirm = f.ctx.ui.confirm;
      f.ctx.ui.confirm = async (message) => {
        if (message.includes("实际应用")) {
          const profile =
            f.ctx.data.profiles[projectKey("fixture", "staging")]!;
          if (change === "ref") profile.supabaseProjectRef = "b".repeat(20);
          if (change === "environment") f.ctx.env = "production";
          if (change === "project")
            f.ctx.config = { ...f.ctx.config, project: "other" };
          if (change === "profile") profile["@supabaseProfile"] = "other";
          if (change === "identity") profile["@supabaseIdentity"] = "other";
          if (change === "root") f.ctx.root = join(f.ctx.root, "other");
        }
        return confirm(message);
      };
      await assert.rejects(releaseMigrations(f.ctx), /目标.*变化|绑定.*变化/);
      assert.equal(f.ctx.runtime?.supabaseDatabasePassword, undefined);
      assert.equal(
        f.calls.filter(
          (args) => args[0] === "db" && !args.includes("--dry-run"),
        ).length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});
test("production confirmation cannot authorize a target changed while typing the readable name", async () => {
  const f = await releaseFixture();
  try {
    f.ctx.env = "production";
    const profile = f.ctx.data.profiles[projectKey("fixture", "staging")]!;
    f.ctx.data.profiles[projectKey("fixture", "production")] = profile;
    f.ctx.ui.input = async (_message, options) => {
      if (options?.secret) return "fixture-db-password";
      profile.supabaseProjectRef = "b".repeat(20);
      return "fixture/production";
    };
    await assert.rejects(releaseMigrations(f.ctx), /目标.*变化|绑定.*变化/);
    assert.equal(
      f.calls.filter((args) => args[0] === "db" && !args.includes("--dry-run"))
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});
test("cancelling the apply confirmation stops publication without a database write", async () => {
  const f = await releaseFixture();
  try {
    f.ctx.ui.confirm = async (message) => {
      if (message.includes("实际应用")) {
        const error = new Error("cancelled");
        error.name = "AbortPromptError";
        throw error;
      }
      return true;
    };
    assert.equal(await releaseMigrations(f.ctx), undefined);
    assert.equal(
      f.calls.filter((args) => args[0] === "db" && !args.includes("--dry-run"))
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});
test("release prompt cancellation is distinct from migration failure", async () => {
  for (const name of ["ExitPromptError", "AbortPromptError"]) {
    const f = await releaseFixture();
    try {
      f.ctx.ui.input = async () => {
        const error = new Error("cancelled");
        error.name = name;
        throw error;
      };
      assert.equal(await releaseMigrations(f.ctx), undefined);
      assert.equal(f.calls.filter((args) => args[0] === "db").length, 0);
    } finally {
      await f.close();
    }
  }
});
async function commitFixture(root: string): Promise<string> {
  await run("git", ["init", "--initial-branch=main"], { cwd: root });
  await run("git", ["add", "--", "supabase"], { cwd: root });
  await run(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${join(root, "no-hooks")}`,
      "commit",
      "-m",
      "test: migration snapshot",
    ],
    { cwd: root },
  );
  return (await run("git", ["rev-parse", "HEAD"], { cwd: root })).trim();
}
test("release migrations use exact CI commit SQL despite live SQL mutation during password prompt", async () => {
  for (const change of ["modify", "add", "remove"]) {
    const f = await releaseFixture();
    try {
      const sha = await commitFixture(f.ctx.root);
      const input = f.ctx.ui.input;
      f.ctx.ui.input = async (message, options) => {
        if (options?.secret) {
          const path = join(f.ctx.root, "supabase/migrations", releaseFile);
          if (change === "modify")
            await writeFile(path, "drop table live_unreviewed;");
          if (change === "add")
            await writeFile(
              join(
                f.ctx.root,
                "supabase/migrations/202610130001_unreviewed.sql",
              ),
              "drop table live_unreviewed;",
            );
          if (change === "remove") await rm(path);
        }
        return input(message, options);
      };
      const original = f.ctx.runner;
      f.ctx.runner = async (command, args, options) => {
        if (command === "git") return run(command, args, options);
        if (args[0] === "db") {
          assert.equal(
            await readFile(
              join(options!.cwd!, "supabase/migrations", releaseFile),
              "utf8",
            ),
            "select 1;",
          );
          const { readdir } = await import("node:fs/promises");
          assert.deepEqual(
            await readdir(join(options!.cwd!, "supabase/migrations")),
            [releaseFile],
          );
        }
        return original(command, args, options);
      };
      assert.equal((await releaseMigrations(f.ctx, sha))?.state, "applied");
    } finally {
      await f.close();
    }
  }
});
test("exact commit session rejects modified temporary snapshot before apply", async () => {
  const f = await releaseFixture();
  try {
    const sha = await commitFixture(f.ctx.root);
    let cwd = "";
    const session = await migrationSession(
      f.ctx.root,
      releaseRef,
      undefined,
      "fixture-db-password",
      async (command, args, options) => {
        if (command === "git") return run(command, args, options);
        cwd = options?.cwd ?? cwd;
        return f.ctx.runner(command, args, options);
      },
      { profile: "fixture", identity: "11111111-1111-4111-8111-111111111111" },
      undefined,
      sha,
    );
    try {
      await session.preview();
      await writeFile(
        join(cwd, "supabase/migrations", releaseFile),
        "drop table tampered;",
      );
      await assert.rejects(session.apply(), /快照/);
      assert.equal(
        f.calls.filter(
          (args) => args[0] === "db" && !args.includes("--dry-run"),
        ).length,
        0,
      );
    } finally {
      await session.close();
    }
  } finally {
    await f.close();
  }
});
test("exact commit session refuses invalid SHA and symlink blobs without db operations", async () => {
  const f = await releaseFixture();
  try {
    const sha = await commitFixture(f.ctx.root);
    let db = 0;
    f.ctx.runner = async (command, args, options) => {
      if (command === "git") {
        if (args.includes("ls-tree"))
          return `120000 blob ${"b".repeat(40)}\tsupabase/migrations/${releaseFile}\0`;
        return run(command, args, options);
      }
      if (args[0] === "--version") return "2.120.0";
      if (args[0] === "whoami")
        return JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          email: "fixture@example.test",
        });
      if (args[0] === "db") db++;
      return "";
    };
    await assert.rejects(releaseMigrations(f.ctx, sha), /迁移|快照|文件/);
    assert.equal(db, 0);
    await assert.rejects(
      migrationSession(
        f.ctx.root,
        releaseRef,
        undefined,
        "fixture-db-password",
        f.ctx.runner,
        undefined,
        undefined,
        "HEAD",
      ),
      /SHA|commit/,
    );
  } finally {
    await f.close();
  }
});
test("commit snapshot rejects malformed tree records and mismatched blob bytes before linking", async () => {
  const f = await releaseFixture();
  try {
    for (const mode of ["unterminated", "blob-mismatch", "nested-sql"]) {
      let linked = false;
      const runner: typeof f.ctx.runner = async (command, args) => {
        if (command === "git") {
          if (args.includes("ls-tree")) {
            const path =
              mode === "nested-sql"
                ? `supabase/migrations/nested/${releaseFile}`
                : `supabase/migrations/${releaseFile}`;
            return `100644 blob ${"b".repeat(40)}\t${path}${mode === "unterminated" ? "" : "\0"}`;
          }
          if (args.includes("show")) return "unverified bytes";
        }
        if (args[0] === "link") linked = true;
        if (args[0] === "--version") return "2.120.0";
        return "";
      };
      await assert.rejects(
        migrationSession(
          f.ctx.root,
          releaseRef,
          undefined,
          "fixture-db-password",
          runner,
          undefined,
          undefined,
          "c".repeat(40),
        ),
        /迁移|提交/,
      );
      assert.equal(linked, false);
    }
  } finally {
    await f.close();
  }
});
test("exact commit migrations ignore local git replacement refs", async () => {
  const f = await releaseFixture();
  try {
    const sha = await commitFixture(f.ctx.root);
    await writeFile(
      join(f.ctx.root, "supabase/migrations", releaseFile),
      "drop table unreviewed_replacement;",
    );
    const replacement = await commitFixture(f.ctx.root);
    await run("git", ["replace", sha, replacement], { cwd: f.ctx.root });
    const original = f.ctx.runner;
    f.ctx.runner = async (command, args, options) => {
      if (command === "git") return run(command, args, options);
      if (args[0] === "db")
        assert.equal(
          await readFile(
            join(options!.cwd!, "supabase/migrations", releaseFile),
            "utf8",
          ),
          "select 1;",
        );
      return original(command, args, options);
    };
    assert.equal((await releaseMigrations(f.ctx, sha))?.state, "applied");
  } finally {
    await f.close();
  }
});
