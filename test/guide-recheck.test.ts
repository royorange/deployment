import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig, projectKey } from "../src/config.ts";
import { deploymentGuide } from "../src/deployment-guide.ts";
import type { Context } from "../src/wizard.ts";
function fixture(answers: string[]) {
  const messages: string[] = [];
  const prompts: Array<{ message: string; first: string }> = [];
  const ctx: Context = {
    root: "/synthetic",
    env: "staging",
    storageMode: "memory",
    config: validateConfig({
      version: 1,
      project: "fixture",
      repository: "fixture/repo",
      environments: ["staging"],
      variables: {
        cloudflareAccountId: "ACCOUNT",
        pagesProject: "PAGES",
        appOrigin: "ORIGIN",
        siteOrigin: "SITE",
      },
      release: {
        adapter: "deploy/release.mts",
        ciWorkflow: "ci.yml",
        environments: ["staging"],
        components: [
          {
            id: "web",
            label: "Web",
            kind: "pages",
            requiresDevice: false,
            migrations: "none",
          },
        ],
      },
    }),
    data: {
      credentials: { "cloudflare/work": "synthetic-hidden-token" },
      profiles: {
        [projectKey("fixture", "staging")]: {
          cloudflareAccountId: "a".repeat(32),
          pagesProject: "fixture-web",
          appOrigin: "https://app.example.test",
          siteOrigin: "https://site.example.test",
          "@cloudflare": "cloudflare/work",
        },
      },
    },
    save: async () => {},
    runner: async () => "a".repeat(40),
    ui: {
      select: async (message, choices) => {
        messages.push(message);
        prompts.push({ message, first: choices[0]!.value });
        const answer = answers.shift();
        assert.ok(
          choices.some((c) => c.value === answer),
          `Unexpected choice ${answer}: ${message}`,
        );
        return answer!;
      },
      confirm: async () => false,
      input: async () => {
        throw new Error("unexpected input");
      },
      check: async () => [],
      log: (message) => messages.push(message),
    },
  };
  return { ctx, messages, prompts };
}
test("a transient Cloudflare read failure can be retried without reconnecting or changing bindings", async () => {
  const f = fixture(["skip", "recheck", "exit"]);
  let probes = 0;
  const before = structuredClone(f.ctx.data);
  await deploymentGuide(
    f.ctx,
    {
      "cloudflare.account": async () => {
        throw new Error("must not reconnect");
      },
    },
    {
      commit: async () => "a".repeat(40),
      probe: async () => {
        if (++probes === 1) throw new Error("Cloudflare Pages HTTP 429");
        return { status: "verified" };
      },
    },
  );
  assert.equal(probes, 2);
  assert.equal(
    f.prompts.find((p) => p.message.includes("HTTP 429"))?.first,
    "recheck",
  );
  assert.deepEqual(f.ctx.data, before);
  assert.ok(f.messages.some((m) => m.includes("Pages 发布与验证")));
});
test("a configured readonly result keeps its actionable message while hiding known credentials", async () => {
  const f = fixture(["skip", "exit"]);
  await deploymentGuide(
    f.ctx,
    {},
    {
      commit: async () => "a".repeat(40),
      probe: async () => ({
        status: "configured",
        message: "项目不存在；请选择 Pages 项目。synthetic-hidden-token",
      }),
    },
  );
  assert.ok(
    f.messages.some((m) => m.includes("项目不存在；请选择 Pages 项目")),
  );
  assert.equal(
    f.prompts.find((p) => p.message.includes("项目不存在"))?.first,
    "run",
  );
  assert.ok(!f.messages.join(" ").includes("synthetic-hidden-token"));
});
