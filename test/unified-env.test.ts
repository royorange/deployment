import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operations, values, type Context } from "../src/wizard.ts";
import { run } from "../src/process.ts";
async function fixture(answers: string[]) {
  const root = await mkdtemp(join(tmpdir(), "unified-env-"));
  await run("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, ".gitignore"), ".project-setup/\n");
  const logs: string[] = [],
    defaults: string[] = [];
  const ctx: Context = {
    root,
    env: "staging",
    config: {
      version: 1,
      project: "fixture",
      environments: ["staging"],
      variables: {
        appOrigin: "ORIGIN",
        cloudflareToken: "CF_TOKEN",
        supabaseCleanupKey: "CLEANUP",
        cloudflareTunnelToken: "TUNNEL",
      },
    },
    data: { credentials: { "cf/test": "management-fixture" }, profiles: {} },
    runner: run,
    save: async () => {},
    ui: {
      select: async (message, choices) => {
        logs.push(message);
        const answer = answers.shift()!;
        assert.ok(
          choices.some((choice) => choice.value === answer),
          `${message}: ${answer}`,
        );
        return answer;
      },
      input: async (_message, options) => {
        defaults.push(options!.value!);
        return options!.value!;
      },
      check: async (_message, choices) =>
        choices
          .filter((choice) => choice.checked)
          .map((choice) => choice.value),
      confirm: async () => true,
      log: (line) => logs.push(line),
    },
  };
  return {
    ctx,
    root,
    logs,
    defaults,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("one optional env default omits management and cleanup keys and writes private ignored file", async () => {
  const f = await fixture(["env"]);
  try {
    Object.assign(values(f.ctx), {
      appOrigin: "https://app.example",
      cloudflareToken: "management-fixture",
      supabaseCleanupKey: "cleanup-fixture",
      cloudflareTunnelToken: "connector-fixture",
    });
    await operations.export(f.ctx);
    const path = join(f.root, ".project-setup/staging/.env");
    assert.deepEqual(f.defaults, [".project-setup/staging/.env"]);
    const output = await readFile(path, "utf8");
    assert.ok(output.includes("ORIGIN=") && output.includes("TUNNEL="));
    assert.ok(
      !output.includes("management-fixture") &&
        !output.includes("cleanup-fixture"),
    );
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await f.close();
  }
});
test("import conflicts reveal names only and require explicit retain or replace", async () => {
  for (const decision of ["keep", "replace"]) {
    const f = await fixture(["env", decision]);
    try {
      Object.assign(values(f.ctx), {
        appOrigin: "https://existing.example",
        cloudflareTunnelToken: "old-secret-fixture",
      });
      await operations.export({
        ...f.ctx,
        ui: { ...f.ctx.ui, select: async () => "env" },
      });
      Object.assign(values(f.ctx), {
        appOrigin: "https://new.example",
        cloudflareTunnelToken: "new-secret-fixture",
      });
      await operations.import(f.ctx);
      assert.equal(
        values(f.ctx).cloudflareTunnelToken,
        decision === "keep" ? "new-secret-fixture" : "old-secret-fixture",
      );
      assert.ok(f.logs.some((line) => line.includes("TUNNEL")));
      assert.ok(!JSON.stringify(f.logs).includes("secret-fixture"));
    } finally {
      await f.close();
    }
  }
});
test("export conflicts keep or replace file values only after explicit selection", async () => {
  for (const decision of ["keep", "replace"]) {
    const f = await fixture(["env", "env", decision]);
    try {
      values(f.ctx).appOrigin = "https://existing.example";
      await operations.export(f.ctx);
      values(f.ctx).appOrigin = "https://updated.example";
      await operations.export(f.ctx);
      const output = await readFile(
        join(f.root, ".project-setup/staging/.env"),
        "utf8",
      );
      assert.ok(
        output.includes(
          decision === "keep"
            ? "https://existing.example"
            : "https://updated.example",
        ),
      );
    } finally {
      await f.close();
    }
  }
});
test("explicit env imports cannot bind management tokens from project variables", async () => {
  const f = await fixture(["env", "env"]);
  try {
    values(f.ctx).cloudflareToken = "management-fixture";
    values(f.ctx).appOrigin = "https://app.example";
    f.ctx.ui.check = async (_message, choices) =>
      choices.map((choice) => choice.value);
    await operations.export(f.ctx);
    delete values(f.ctx).cloudflareToken;
    await operations.import(f.ctx);
    assert.equal(values(f.ctx).cloudflareToken, undefined);
  } finally {
    await f.close();
  }
});
