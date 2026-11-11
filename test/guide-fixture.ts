import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey, validateConfig } from "../src/config.ts";
import type { Context } from "../src/wizard.ts";
import type { ReleaseFlowResult } from "../src/release-flow.ts";
export const sha = "a".repeat(40);
export async function fixture(answers: string[], auth = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guide-flow-")));
  const messages: string[] = [];
  const config = validateConfig({
    version: 1,
    project: "fixture",
    repository: "fixture/repo",
    environments: ["staging"],
    variables: {
      cloudflareAccountId: "ACCOUNT",
      pagesProject: "PAGES",
      siteOrigin: "SITE",
      appOrigin: "ORIGIN",
      ...(auth
        ? {
            supabaseProjectRef: "REF",
            supabaseUrl: "URL",
            supabasePublishableKey: "KEY",
          }
        : {}),
    },
    setup: { auth: auth ? "supabase" : "none" },
    release: {
      adapter: "deploy/release.mts",
      ciWorkflow: "ci.yml",
      environments: ["staging"],
      components: [
        {
          id: "api",
          label: "API",
          kind: "application",
          requiresDevice: false,
          migrations: "none",
        },
        {
          id: "web",
          label: "Web",
          kind: "pages",
          requiresDevice: false,
          migrations: "none",
        },
      ],
    },
  });
  const ctx: Context = {
    root,
    deviceDirectory: join(root, "devices"),
    config,
    env: "staging",
    storageMode: "metadata",
    data: {
      credentials: {
        "cloudflare/work": "fixture-hidden-cloudflare",
        "supabase/work": "fixture-hidden-supabase",
      },
      profiles: {
        [projectKey("fixture", "staging")]: {
          cloudflareAccountId: "a".repeat(32),
          pagesProject: "fixture-site",
          siteOrigin: "https://site.example.test",
          appOrigin: "https://app.example.test",
          "@cloudflareSource": "manual",
          "@cloudflare": "cloudflare/work",
          ...(auth
            ? {
                supabaseProjectRef: "b".repeat(20),
                supabaseUrl: `https://${"b".repeat(20)}.supabase.co`,
                supabasePublishableKey: "sb_publishable_fixture",
                "@supabaseSource": "manual",
                "@supabase": "supabase/work",
              }
            : {}),
        },
      },
    },
    save: async () => {},
    runner: async () => sha,
    ui: {
      select: async (message, choices) => {
        messages.push(message);
        const value = answers.shift();
        assert.ok(value, `Unexpected prompt: ${message}`);
        assert.ok(
          choices.some((c) => c.value === value),
          `Invalid answer ${value}: ${message}`,
        );
        return value!;
      },
      input: async () => {
        throw new Error("unexpected input");
      },
      confirm: async () => false,
      check: async () => [],
      log: (m) => messages.push(m),
    },
  };
  return {
    ctx,
    root,
    messages,
    options: {
      directory: join(root, "guides"),
      commit: async () => sha,
      probe: async () => ({ status: "verified" as const }),
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
export function published(
  ctx: Context,
  id: string,
  database: "applied" | "not-run" = "not-run",
): ReleaseFlowResult {
  return {
    state: "health-checked",
    receipts: [
      {
        version: 1,
        project: ctx.config.project,
        environment: ctx.env,
        component: id,
        commit: sha,
        ciRunId: 1,
        state: "health-checked",
        database,
        phase: "verify",
        checkedAt: new Date().toISOString(),
      },
    ],
  };
}
