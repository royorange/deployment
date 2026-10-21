import assert from "node:assert/strict";
import { test } from "node:test";
import { guidedWizard, type SetupActions } from "../src/guided-menu.ts";
import { projectKey, type Config } from "../src/config.ts";
import { values, type Context } from "../src/wizard.ts";

const config: Config = {
  version: 1,
  project: "fixture",
  environments: ["staging", "production"],
  deploymentTopology: "aws-tunnel",
  migrationStrategy: "project-managed",
  variables: { appOrigin: "APP_ORIGIN", cloudflareAccountId: "CF_ACCOUNT_ID" },
};
function fixture(answers: string[], actions: SetupActions = {}) {
  const prompts: Array<{ message: string; choices: string[] }> = [];
  const logs: string[] = [];
  const ctx: Context = {
    root: "/fixture",
    config: structuredClone(config),
    env: "staging",
    data: { credentials: {}, profiles: {} },
    runner: async () => {
      throw new Error("no network allowed");
    },
    save: async () => {},
    ui: {
      select: async (message, choices) => {
        prompts.push({
          message,
          choices: choices.map((choice) => choice.value),
        });
        const answer = answers.shift();
        assert.ok(
          choices.some((choice) => choice.value === answer),
          `unexpected ${answer}: ${message}`,
        );
        return answer!;
      },
      input: async () => {
        throw new Error("unexpected input");
      },
      confirm: async () => false,
      check: async () => [],
      log: (line) => logs.push(line),
    },
  };
  return { ctx, prompts, logs, run: () => guidedWizard(ctx, actions) };
}
test("six entry homepage, nested back does not exit, and status is local until explicitly refreshed", async () => {
  const f = fixture([
    "services",
    "cloudflare",
    "back",
    "back",
    "status",
    "back",
    "transfer",
    "back",
    "services",
    "advanced",
    "back",
    "back",
    "exit",
  ]);
  let saves = 0;
  f.ctx.save = async () => {
    saves++;
  };
  await f.run();
  const homes = f.prompts.filter((p) => p.message.includes("— 配置中心"));
  assert.equal(homes.length, 5);
  assert.ok(homes.every((p) => p.choices.length === 6));
  assert.equal(saves, 1);
  assert.ok(f.prompts.some((p) => p.message.includes("本地配置不代表")));
});
test("service actions stay in the service and failure is redacted without changing account evidence", async () => {
  const f = fixture(
    [
      "services",
      "cloudflare",
      "cloudflare.account",
      "continue",
      "back",
      "back",
      "exit",
    ],
    {
      "cloudflare.account": async () => {
        throw new Error("fixture-sensitive-token failed");
      },
    },
  );
  f.ctx.data.credentials.secret = "fixture-sensitive-token";
  await f.run();
  assert.ok(f.logs.some((line) => line.includes("[已隐藏] failed")));
  assert.ok(!JSON.stringify(f.prompts).includes("fixture-sensitive-token"));
  assert.equal(f.ctx.runtime, undefined);
});
test("guide cancel/return recomputes missing requirements and never claims deployment complete", async () => {
  const f = fixture(
    [
      "guide",
      "next",
      "run",
      "continue",
      "back",
      "back",
      "guide",
      "next",
      "back",
      "back",
      "exit",
    ],
    {
      "cloudflare.account": async () => {},
    },
  );
  await f.run();
  const steps = f.prompts.filter((p) => p.choices.includes("run"));
  assert.ok(steps.length >= 3);
  assert.ok(
    steps.every(
      (p) => p.message.includes("缺失") || p.message.includes("未知"),
    ),
  );
  assert.ok(!f.logs.some((line) => /已部署|可运行|全部完成/.test(line)));
});
test("environment switch computes independent readiness, with no persisted guide cursor", async () => {
  const f = fixture([
    "services",
    "advanced",
    "environment",
    "production",
    "back",
    "back",
    "status",
    "back",
    "exit",
  ]);
  values(f.ctx).appOrigin = "https://staging.example.test";
  await f.run();
  assert.equal(f.ctx.env, "production");
  assert.equal(values(f.ctx).appOrigin, undefined);
  assert.equal(
    f.ctx.data.profiles[projectKey("fixture", "staging")]!.appOrigin,
    "https://staging.example.test",
  );
  assert.ok(!JSON.stringify(f.ctx.data).includes("guideStep"));
});
test("topology and auth declarations hide inapplicable provider actions", async () => {
  const f = fixture([
    "services",
    "supabase",
    "back",
    "cloudflare",
    "back",
    "back",
    "exit",
  ]);
  f.ctx.config.setup = { auth: "firebase" };
  await f.run();
  const supabase = f.prompts.find(
    (p) => p.message === "Supabase — 账号与服务",
  )!;
  assert.ok(!supabase.choices.includes("supabase.auth"));
  assert.ok(!supabase.choices.includes("supabase.migrations"));
  const cloudflare = f.prompts.find(
    (p) => p.message === "Cloudflare — 账号与服务",
  )!;
  assert.ok(!cloudflare.choices.includes("cloudflare.worker"));
});
test("status can route a missing item to its configuration action and returns to status", async () => {
  let calls = 0;
  const f = fixture(
    [
      "status",
      "check:cloudflare.account",
      "run",
      "continue",
      "back",
      "back",
      "exit",
    ],
    {
      "cloudflare.account": async () => {
        calls++;
      },
    },
  );
  await f.run();
  assert.equal(calls, 1);
  assert.equal(
    f.prompts.filter((p) => p.choices.includes("details")).length,
    2,
  );
});
