import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExportPath, clipboard, run } from "../src/process.ts";
import { wizard, type Context } from "../src/wizard.ts";
import { projectKey, validateConfig } from "../src/config.ts";
import { parseEnv } from "../src/files.ts";

test("env exports require ignored untracked paths and cannot escape the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-export-test-"));
  try {
    await run("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env*\n.project-setup/\n");
    await writeFile(join(root, ".env.tracked"), "KEY=value", { mode: 0o600 });
    await run("git", ["add", "--force", ".env.tracked"], { cwd: root });
    assert.equal(
      await localExportPath(root, ".env.local"),
      join(root, ".env.local"),
    );
    await assert.rejects(localExportPath(root, ".env.tracked"), /已跟踪/);
    await assert.rejects(localExportPath(root, "public.txt"), /gitignore/);
    await assert.rejects(localExportPath(root, "../escape"), /项目内/);
    await assert.rejects(localExportPath(root, ".git/credentials"), /项目内/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Fulcord unified export offers one path and excludes unselected management credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-export-test-"));
  const config = validateConfig(
    JSON.parse(
      await readFile(
        new URL("../examples/fulcord.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const selects = ["export", "env", "exit"];
  try {
    await run("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env*\n.project-setup/\n");
    const ctx: Context = {
      root,
      config,
      env: "staging",
      runner: run,
      save: async () => {},
      data: {
        credentials: { "cloudflare/test": "sensitive-token" },
        profiles: {
          [projectKey("fulcord", "staging")]: {
            ...config.defaults!.staging,
            cloudflareAccountId: "a".repeat(32),
            appOrigin: "https://app.example",
            supabaseUrl: "https://test.supabase.co",
            supabasePublishableKey: "sb_publishable_example",
            "@cloudflare": "cloudflare/test",
          },
        },
      },
      ui: {
        select: async (message, choices) => {
          if (message.includes("— 操作结果")) return "back";
          const answer = selects.shift()!;
          assert.ok(choices.some((choice) => choice.value === answer));
          return answer;
        },
        input: async (_message, options) => options!.value!,
        confirm: async () => true,
        check: async (_message, choices) =>
          choices
            .filter((choice) => choice.checked)
            .map((choice) => choice.value),
        log: () => {},
      },
    };
    await wizard(ctx);
    const env = parseEnv(
      await readFile(join(root, ".project-setup/staging/.env"), "utf8"),
    );
    assert.ok(Object.keys(env).length > 5);
    assert.equal(env.CF_PAGES_PROJECT, "fulcord-web");
    assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(env.SUPABASE_PUBLISHABLE_KEY, "sb_publishable_example");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clipboard value stays on stdin and missing desktop support fails without printing it", async () => {
  const secret = "fixture-sensitive-clipboard";
  await clipboard(secret, async (_command, args, options) => {
    assert.ok(!args.join(" ").includes(secret));
    assert.equal(options?.input, secret);
    return "";
  });
  await assert.rejects(
    clipboard(secret, async () => {
      throw new Error(secret);
    }),
    (error: Error) =>
      !error.message.includes(secret) && error.message.includes("剪贴板"),
  );
});
