import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../src/wizard.ts";
const sha = "a".repeat(40);
export async function fixture() {
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
