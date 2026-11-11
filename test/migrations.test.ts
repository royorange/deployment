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
import type { RunOptions } from "../src/process.ts";

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
