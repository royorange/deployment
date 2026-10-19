import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { CommandUnavailableError, run } from "../src/process.ts";
import { modules, wizard, type Context } from "../src/wizard.ts";

const config = validateConfig({
  version: 1,
  project: "fixture",
  environments: ["staging"],
  variables: { appOrigin: "APP_ORIGIN" },
});

test("spawn failures have a typed unavailable error without echoing command arguments", async () => {
  await assert.rejects(
    run("project-setup-fixture-command-does-not-exist", [
      "fixture-sensitive-argument",
    ]),
    (error: unknown) => {
      assert.ok(error instanceof CommandUnavailableError);
      assert.match(error.message, /无法启动/);
      assert.ok(!error.message.includes("fixture-sensitive-argument"));
      return true;
    },
  );
});

test("a CLI that starts and exits unsuccessfully is not classified as unavailable", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(2)"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof CommandUnavailableError));
      assert.match(error.message, /退出码 2/);
      return true;
    },
  );
});

for (const provider of ["supabase", "cloudflare"] as const) {
  test(`missing ${provider} CLI shows a result without asking to log in or changing bindings`, async () => {
    const command = provider === "supabase" ? "supabase" : "wrangler";
    const original = {
      credentials: {},
      profiles: {
        [projectKey(config.project, "staging")]: {
          [`@${provider}Source`]: provider === "supabase" ? "cli" : "wrangler",
          [`@${provider}Profile`]: "original-profile",
          [`@${provider}Identity`]: "original-identity",
          appOrigin: "https://original.example.test",
        },
      },
    };
    const selections = [
      provider,
      provider === "supabase" ? "project" : "account",
      "official",
      "back",
      "exit",
    ];
    const logs: string[] = [];
    const calls: string[][] = [];
    let confirmations = 0;
    let fetches = 0;
    const ctx: Context = {
      root: "/project-setup-fixture-no-node-modules",
      config,
      env: "staging",
      data: structuredClone(original),
      save: async () => {},
      ui: {
        select: async (message, choices) => {
          logs.push(message);
          const answer = selections.shift()!;
          assert.ok(choices.some((choice) => choice.value === answer));
          return answer;
        },
        input: async () => "replacement-profile",
        confirm: async () => {
          confirmations++;
          return false;
        },
        check: async () => [],
        log: (line) => logs.push(line),
      },
      runner: async (actualCommand, args) => {
        calls.push([actualCommand, ...args]);
        if (provider === "cloudflare" && actualCommand === process.execPath)
          assert.ok(args[0]?.endsWith("/wrangler/bin/wrangler.js"));
        else assert.equal(actualCommand, command);
        throw new CommandUnavailableError(command);
      },
      fetcher: async () => {
        fetches++;
        throw new Error("unavailable CLI must not make remote requests");
      },
    };
    await wizard(ctx);
    assert.equal(confirmations, 0);
    assert.equal(fetches, 0);
    assert.equal(calls.length, 1);
    assert.ok(
      !calls.some((args) => args.includes("login") || args.includes("create")),
    );
    assert.deepEqual(ctx.data, original);
    assert.ok(
      logs.some(
        (line) =>
          line.includes("— 操作结果") && line.includes(`无法启动 ${command}`),
      ),
    );
    assert.equal(selections.length, 0);
  });

  test(`${provider} login failures still offer the existing explicit login action`, async () => {
    let confirmations = 0;
    const ctx: Context = {
      root: "/project-setup-fixture-no-node-modules",
      config,
      env: "staging",
      data: { credentials: {}, profiles: {} },
      save: async () => {},
      ui: {
        select: async () => "official",
        input: async () => "fixture-profile",
        confirm: async () => {
          confirmations++;
          return false;
        },
        check: async () => [],
        log: () => {},
      },
      runner: async () => {
        throw new Error("fixture login expired");
      },
    };
    await modules
      .find((module) => module.id === provider)!
      .actions.find(
        (action) =>
          action.id === (provider === "supabase" ? "project" : "account"),
      )!
      .execute(ctx);
    assert.equal(confirmations, 1);
    assert.deepEqual(ctx.data, { credentials: {}, profiles: {} });
  });
}
