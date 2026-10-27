import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, projectKey } from "../src/config.ts";
import type { Context } from "../src/wizard.ts";
export const sha = "a".repeat(40),
  old = "b".repeat(40),
  token = "c".repeat(64);
export const device = {
  id: "host",
  label: "Host",
  host: "192.0.2.1",
  user: "ubuntu",
  port: 22,
};
export function output(state = "running") {
  return {
    ready: true,
    summary: ["fixture healthy"],
    missing: [],
    effects: ["only fixture app and tunnel"],
    snapshot: {
      token,
      state,
      current: old,
      revisions: [
        { revision: old, compatible: true, reason: "same database schema" },
      ],
    },
  };
}
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lifecycle-")));
  await mkdir(join(root, "deploy"));
  await writeFile(join(root, "deploy/lifecycle.mts"), "// synthetic fixture");
  await writeFile(join(root, "deploy/release.mts"), "// synthetic fixture");
  const calls: Array<{
      command: string;
      args: string[];
      input?: string;
      env?: NodeJS.ProcessEnv;
    }> = [],
    logs: string[] = [],
    confirmations: string[] = [];
  const config = validateConfig({
    version: 1,
    project: "fixture",
    repository: "owner/fixture",
    environments: ["staging"],
    variables: {
      appOrigin: "ORIGIN",
      supabasePublishableKey: "KEY",
      cloudflareToken: "TOKEN",
    },
    release: {
      adapter: "deploy/release.mts",
      ciWorkflow: "ci.yml",
      environments: ["staging"],
      publicFields: ["appOrigin"],
      lifecycle: { adapter: "deploy/lifecycle.mts", environments: ["staging"] },
      components: [
        {
          id: "app",
          label: "App",
          kind: "application",
          requiresDevice: true,
          migrations: "none",
        },
      ],
    },
  });
  const ctx: Context = {
    root,
    env: "staging",
    storageMode: "memory",
    config,
    data: {
      credentials: { secret: "synthetic-account-token" },
      profiles: {
        [projectKey("fixture", "staging")]: {
          appOrigin: "https://app.example.test",
          supabasePublishableKey: "sb_publishable_synthetic",
          "@releaseDeviceId": "host",
        },
      },
    },
    save: async () => {},
    releaseDirectory: join(root, "receipts"),
    deviceDirectory: join(root, "devices"),
    ui: {
      select: async () => "back",
      confirm: async (message) => {
        confirmations.push(message);
        return true;
      },
      input: async () => "",
      check: async () => [],
      log: (message) => logs.push(message),
    },
    runner: async (command, args, options) => {
      calls.push({ command, args, input: options?.input, env: options?.env });
      if (command === "git") {
        if (args.includes("status")) return "";
        if (args.includes("get-url")) return "git@github.com:owner/fixture.git";
        if (args.includes("rev-parse")) return sha;
        if (args.includes("-v"))
          return "H deploy/lifecycle.mts\0H deploy/release.mts\0";
        return args.at(-1)!;
      }
      if (command === "gh")
        return JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 1,
              run_number: 1,
              run_attempt: 1,
              created_at: "2026-10-27T00:00:00Z",
              status: "completed",
              conclusion: "success",
              head_sha: sha,
              head_repository: { full_name: "owner/fixture", fork: false },
              path: ".github/workflows/ci.yml",
              event: "push",
            },
          ],
        });
      return JSON.stringify(
        output(args.at(-1) === "apply" ? "stopped" : "running"),
      );
    },
  };
  return {
    root,
    ctx,
    calls,
    logs,
    confirmations,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
