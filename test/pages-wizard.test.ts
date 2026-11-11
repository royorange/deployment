import assert from "node:assert/strict";
import { test } from "node:test";
import { modules, values, type Context } from "../src/wizard.ts";
import { projectKey } from "../src/config.ts";
const account = "a".repeat(32);
const published = {
  id: "fixture-deploy",
  created_on: "2026-10-20T00:00:00Z",
  environment: "preview",
  deployment_trigger: { metadata: { branch: "release/test" } },
  latest_stage: { name: "deploy", status: "success" },
  url: "https://abc.fixture-web.pages.dev",
  aliases: [],
};
function fixture(deployments: unknown[], confirms: boolean[] = []) {
  const inputs = ["fixture-web", "release/test"];
  const logs: string[] = [];
  const calls: string[] = [];
  const ctx: Context = {
    root: "/fixture",
    env: "staging",
    config: {
      version: 1,
      project: "fixture",
      environments: ["staging"],
      variables: { pagesProject: "PAGES", siteOrigin: "SITE" },
    },
    data: {
      credentials: { "cloudflare/test": "fixture-secret" },
      profiles: {
        [projectKey("fixture", "staging")]: {
          "@cloudflare": "cloudflare/test",
          cloudflareAccountId: account,
        },
      },
    },
    save: async () => {},
    runner: async () => "",
    fetcher: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return Response.json({
        success: true,
        result: String(url).includes("/deployments?")
          ? deployments
          : {
              name: "fixture-web",
              production_branch: "main",
              subdomain: "fixture-web.pages.dev",
            },
      });
    },
    ui: {
      select: async (_message, choices) => choices[0]!.value,
      input: async () => inputs.shift()!,
      confirm: async () => confirms.shift() ?? false,
      log: (line) => logs.push(line),
      check: async () => [],
    },
  };
  return {
    ctx,
    logs,
    calls,
    run: () =>
      modules[0]!.actions.find((action) => action.id === "pages")!.execute(ctx),
  };
}
test("empty Pages project never invents or saves a staging URL", async () => {
  const f = fixture([]);
  await f.run();
  assert.equal(values(f.ctx).pagesProject, "fixture-web");
  assert.equal(values(f.ctx).siteOrigin, undefined);
  assert.ok(f.logs.some((line) => line.includes("无部署记录")));
  assert.ok(!f.logs.some((line) => line.includes("Pages 已就绪")));
});
test("published Pages URL needs explicit consent and preserves custom origin by default", async () => {
  for (const consent of [false, true]) {
    const f = fixture([published], [consent]);
    values(f.ctx).siteOrigin = "https://custom.example.test";
    await f.run();
    assert.equal(
      values(f.ctx).siteOrigin,
      consent ? published.url : "https://custom.example.test",
    );
    assert.ok(f.logs.some((line) => line.includes(published.url)));
    assert.ok(f.logs.some((line) => line.includes("业务")));
    assert.ok(f.calls.every((call) => call.startsWith("GET ")));
  }
});
test("Pages permission failure stays unknown and never tries resource creation", async () => {
  const f = fixture([]);
  f.ctx.fetcher = async () => new Response("private", { status: 403 });
  await assert.rejects(f.run());
  assert.equal(values(f.ctx).siteOrigin, undefined);
});
test("Pages component mapping edits admin fields without overwriting frontend", async () => {
  const f = fixture([]);
  f.ctx.config.extraFields = {
    adminPages: { label: "后台 Pages", secret: false, kind: "text" },
    adminOrigin: { label: "后台 Origin", secret: false, kind: "origin" },
    adminBranch: { label: "后台分支", secret: false, kind: "text" },
  };
  f.ctx.config.variables = {
    ...f.ctx.config.variables,
    adminPages: "ADMIN_PAGES",
    adminOrigin: "ADMIN_ORIGIN",
    adminBranch: "ADMIN_BRANCH",
  };
  f.ctx.config.setup = {
    components: [
      {
        id: "admin",
        title: "管理后台",
        kind: "admin",
        hosting: "pages",
        projectField: "adminPages",
        originField: "adminOrigin",
        branchField: "adminBranch",
      },
    ],
  };
  values(f.ctx).pagesProject = "frontend-web";
  await f.run();
  assert.equal(values(f.ctx).adminPages, "fixture-web");
  assert.equal(values(f.ctx).adminBranch, "release/test");
  assert.equal(values(f.ctx).pagesProject, "frontend-web");
});

test("new Pages component defaults are separate and reuse requires consent", async () => {
  const f = fixture([]);
  f.ctx.config.extraFields = {
    adminPages: { label: "后台 Pages", kind: "text", secret: false },
    adminOrigin: { label: "后台入口", kind: "origin", secret: false },
  };
  Object.assign(f.ctx.config.variables, {
    adminPages: "ADMIN_PAGES",
    adminOrigin: "ADMIN_ORIGIN",
  });
  f.ctx.config.setup = {
    components: [
      {
        id: "web",
        title: "前台",
        hosting: "pages",
        kind: "web",
        projectField: "pagesProject",
        originField: "siteOrigin",
      },
      {
        id: "admin",
        title: "后台",
        hosting: "pages",
        kind: "admin",
        projectField: "adminPages",
        originField: "adminOrigin",
      },
    ],
  };
  f.ctx.ui.select = async () => "component:admin";
  let defaults: string | undefined;
  f.ctx.ui.input = async (message, options) => {
    if (message.includes("分支")) return "release/test";
    defaults = options?.value;
    return options!.value!;
  };
  f.ctx.fetcher = async (url) =>
    Response.json({
      success: true,
      result: String(url).includes("/deployments?")
        ? []
        : { name: "fixture-admin", production_branch: "main" },
    });
  await f.run();
  assert.equal(defaults, "fixture-admin");
  assert.equal(values(f.ctx).adminPages, "fixture-admin");
  values(f.ctx).pagesProject = "frontend-web";
  delete values(f.ctx).adminPages;
  f.ctx.ui.input = async () => "frontend-web";
  let requested = "";
  f.ctx.ui.confirm = async (message) => {
    requested = message;
    return false;
  };
  await f.run();
  assert.match(requested, /前台.*复用/);
  assert.equal(values(f.ctx).adminPages, undefined);
});
test("Cloudflare account switch clears all hosted component bindings only in current environment", async () => {
  const f = fixture([]);
  f.ctx.config.environments.push("production");
  f.ctx.config.extraFields = {
    adminPages: { label: "后台项目", secret: false, kind: "text" },
    adminOrigin: { label: "后台入口", secret: false, kind: "origin" },
    adminBranch: { label: "后台分支", secret: false, kind: "text" },
    apiOrigin: { label: "API", secret: false, kind: "origin" },
  };
  Object.assign(f.ctx.config.variables, {
    adminPages: "ADMIN_PAGES",
    adminOrigin: "ADMIN_ORIGIN",
    adminBranch: "ADMIN_BRANCH",
    apiOrigin: "API_ORIGIN",
  });
  f.ctx.config.setup = {
    components: [
      {
        id: "admin",
        title: "后台",
        kind: "admin",
        hosting: "pages",
        projectField: "adminPages",
        originField: "adminOrigin",
        branchField: "adminBranch",
      },
      {
        id: "api",
        title: "API",
        kind: "api",
        hosting: "external",
        originField: "apiOrigin",
      },
    ],
  };
  Object.assign(values(f.ctx), {
    adminPages: "old-admin",
    adminOrigin: "https://old.example.test",
    adminBranch: "staging",
    apiOrigin: "https://api.example.test",
  });
  f.ctx.data.profiles[projectKey("fixture", "production")] = {
    adminPages: "prod-admin",
  };
  const next = "b".repeat(32);
  const answers = ["cloudflare/test", next];
  f.ctx.ui.select = async () => answers.shift()!;
  f.ctx.ui.confirm = async () => true;
  f.ctx.fetcher = async () =>
    Response.json({ success: true, result: [{ id: next, name: "new" }] });
  await modules[0]!.actions
    .find((action) => action.id === "account")!
    .execute(f.ctx);
  assert.equal(values(f.ctx).adminPages, undefined);
  assert.equal(values(f.ctx).adminOrigin, undefined);
  assert.equal(values(f.ctx).adminBranch, undefined);
  assert.equal(values(f.ctx).apiOrigin, "https://api.example.test");
  assert.equal(
    f.ctx.data.profiles[projectKey("fixture", "production")]!.adminPages,
    "prod-admin",
  );
});

test("Pages component IDs cannot collide with navigation values", async () => {
  const f = fixture([]);
  f.ctx.config.setup = {
    components: [
      {
        id: "back",
        title: "后台",
        kind: "admin",
        hosting: "pages",
        projectField: "pagesProject",
        originField: "siteOrigin",
      },
    ],
  };
  await f.run();
  assert.equal(values(f.ctx).pagesProject, "fixture-web");
});

test("rechecking Pages discards old session publication evidence before a permission failure", async () => {
  const f = fixture([published]);
  await f.run();
  assert.equal(f.ctx.runtime?.pagesEvidence?.staging?.[0]?.status, "deployed");
  f.ctx.fetcher = async () => new Response("private", { status: 403 });
  f.ctx.ui.input = async () => "fixture-web";
  await assert.rejects(f.run());
  assert.equal(f.ctx.runtime?.pagesEvidence?.staging, undefined);
});

test("checking multiple Pages components preserves independent evidence when one refresh fails", async () => {
  const f = fixture([]);
  f.ctx.config.extraFields = {
    adminPages: { label: "后台项目", secret: false, kind: "text" },
    adminOrigin: { label: "后台入口", secret: false, kind: "origin" },
  };
  Object.assign(f.ctx.config.variables, {
    adminPages: "ADMIN_PAGES",
    adminOrigin: "ADMIN_ORIGIN",
  });
  f.ctx.config.setup = {
    components: [
      {
        id: "web",
        title: "前台",
        kind: "web",
        hosting: "pages",
        projectField: "pagesProject",
        originField: "siteOrigin",
      },
      {
        id: "admin",
        title: "后台",
        kind: "admin",
        hosting: "pages",
        projectField: "adminPages",
        originField: "adminOrigin",
      },
    ],
  };
  const selected = ["component:web", "component:admin", "component:web"];
  const inputs = [
    "fixture-web",
    "release/test",
    "fixture-admin",
    "release/test",
    "fixture-web",
  ];
  f.ctx.ui.select = async () => selected.shift()!;
  f.ctx.ui.input = async () => inputs.shift()!;
  f.ctx.fetcher = async (url) => {
    const project = String(url).includes("fixture-admin")
      ? "fixture-admin"
      : "fixture-web";
    return Response.json({
      success: true,
      result: String(url).includes("/deployments?")
        ? [{ ...published, url: `https://abc.${project}.pages.dev` }]
        : { name: project, production_branch: "main" },
    });
  };
  await f.run();
  await f.run();
  assert.equal(f.ctx.runtime!.pagesEvidence!.staging!.length, 2);
  f.ctx.fetcher = async () => new Response("private", { status: 403 });
  await assert.rejects(f.run());
  assert.equal(f.ctx.runtime!.pagesEvidence!.staging!.length, 1);
  assert.equal(
    f.ctx.runtime!.pagesEvidence!.staging![0]!.projectField,
    "adminPages",
  );
});
