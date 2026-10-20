import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfig, type Config } from "../src/config.ts";
import { ProjectStore } from "../src/projects.ts";
import { setupChecks } from "../src/setup-model.ts";

const base = (): Config => ({
  version: 1,
  project: "sample-project",
  environments: ["staging"],
  variables: {
    cloudflareAccountId: "CF_ACCOUNT_ID",
    pagesProject: "PAGES_PROJECT",
    appOrigin: "APP_ORIGIN",
    supabaseProjectRef: "SUPABASE_PROJECT_REF",
    supabaseUrl: "SUPABASE_URL",
    supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
  },
});

const declared = (): Config => ({
  ...base(),
  migrationStrategy: "project-managed",
  setup: {
    auth: "firebase",
    components: [
      {
        id: "web",
        title: "用户前台",
        kind: "web",
        hosting: "pages",
        originField: "appOrigin",
        projectField: "pagesProject",
        docs: "deploy/README.md",
      },
      {
        id: "admin",
        title: "管理后台",
        kind: "admin",
        hosting: "external",
        instructions: "检查 Access 精确邮箱策略。",
        docs: "https://example.com/docs",
      },
      {
        id: "api",
        title: "业务 API",
        kind: "api",
        hosting: "aws",
        instructions: "运行项目已有基础设施检查。",
      },
    ],
    requirements: [
      {
        id: "storage",
        title: "Storage 业务检查",
        purpose: "验证文件操作。",
        instructions: "使用测试对象进行读写删除。",
      },
      {
        id: "database",
        title: "数据库连接",
        purpose: "运行时连接数据库。",
        instructions: "在项目内配置执行器。",
        fields: ["supabaseUrl"],
      },
    ],
  },
});

test("setup manifest supports distinct components and survives public project mapping", async () => {
  const config = validateConfig(declared());
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "setup-model-"),
  );
  try {
    const store = new ProjectStore(directory);
    await store.save(join(directory, "project"), config);
    assert.deepEqual(
      (await store.read(join(directory, "project")))?.config.setup,
      config.setup,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup manifest rejects executable, unknown, oversized and unsafe input", () => {
  const invalid = [
    { command: "sh deploy.sh" },
    { auth: "other" },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          command: "deploy",
        },
      ],
    },
    {
      components: [
        { id: "web", title: "bad\ntext", kind: "web", hosting: "pages" },
      ],
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          originField: "pagesProject",
        },
      ],
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          projectField: "supabasePublishableKey",
        },
      ],
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          projectField: "workerName",
        },
      ],
    },
    {
      requirements: [
        {
          id: "check",
          title: "check",
          purpose: "purpose",
          instructions: "do it",
          fields: ["unknown"],
        },
      ],
    },
    {
      requirements: [
        {
          id: "check",
          title: "check",
          purpose: "purpose",
          instructions: "x".repeat(2001),
        },
      ],
    },
    {
      requirements: Array.from({ length: 21 }, (_, index) => ({
        id: `check-${index}`,
        title: "check",
        purpose: "purpose",
        instructions: "do it",
      })),
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          docs: "https://user:password@example.com/docs",
        },
      ],
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          docs: "https://example.com/docs?token=value",
        },
      ],
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          docs: "../outside.md",
        },
      ],
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          docs: "javascript:alert(1)",
        },
      ],
    },
    {
      components: [
        { id: "web", title: "web", kind: "web", hosting: "pages" },
        { id: "web", title: "web", kind: "web", hosting: "pages" },
      ],
    },
  ];
  for (const setup of invalid)
    assert.throws(
      () => validateConfig({ ...base(), setup }),
      /引导|组件|要求|文档/,
    );
});

test("AWS topology never requires a Worker or treats configured values as deployment proof", () => {
  const config = {
    ...base(),
    deploymentTopology: "aws-tunnel" as const,
    migrationStrategy: "supabase-cli" as const,
  };
  const checks = setupChecks(config, {
    cloudflareAccountId: "a".repeat(32),
    appOrigin: "https://app.example.com",
    pagesProject: "sample-project",
    workerName: "legacy-worker",
  });
  assert.ok(checks.some((check) => check.action === "deployment.tunnel"));
  assert.ok(checks.some((check) => check.action === "supabase.migrations"));
  assert.ok(!checks.some((check) => /Worker/.test(check.title)));
  assert.equal(
    checks.find((check) => check.id === "application.verified")?.state,
    "unknown",
  );
  assert.equal(
    checks.find((check) => check.id === "cloudflare.account")?.state,
    "configured",
  );
});

test("private Worker origin is never routed to whole-app Tunnel writes", () => {
  const checks = setupChecks(
    { ...base(), deploymentTopology: "worker-private-origin" },
    {},
  );
  assert.ok(!checks.some((check) => check.action?.startsWith("deployment.")));
  assert.ok(
    checks.some(
      (check) =>
        check.id === "worker.private-origin" && check.state === "manual",
    ),
  );
});

test("Firebase setup and project-managed migrations require project workflows", () => {
  const checks = setupChecks(declared(), {
    appOrigin: "https://app.example.com",
    pagesProject: "sample-project",
    supabaseUrl: "https://project.supabase.co",
  });
  assert.ok(
    !checks.some(
      (check) =>
        check.action === "supabase.auth" ||
        check.action === "supabase.migrations",
    ),
  );
  assert.equal(
    checks.find((check) => check.id === "supabase.migrations")?.state,
    "manual",
  );
  assert.equal(
    checks.find((check) => check.id === "component.web.config")?.state,
    "configured",
  );
  assert.equal(
    checks.find((check) => check.id === "component.web.deployment")?.state,
    "unknown",
  );
  assert.equal(
    checks.find((check) => check.id === "component.admin.config")?.state,
    "manual",
  );
  assert.equal(
    checks.find((check) => check.id === "requirement.storage")?.state,
    "manual",
  );
  assert.equal(
    checks.find((check) => check.id === "requirement.database")?.state,
    "configured",
  );
  assert.ok(
    checks
      .find((check) => check.id === "component.web.config")
      ?.instructions.includes("deploy/README.md"),
  );
});

test("legacy configurations stay conservative and do not infer auth or migration ownership", () => {
  const checks = setupChecks(base(), {});
  assert.ok(
    !checks.some(
      (check) =>
        check.action === "supabase.auth" ||
        check.action === "supabase.migrations",
    ),
  );
  assert.equal(
    checks.find((check) => check.id === "supabase.migrations")?.state,
    "manual",
  );
  assert.equal(
    checks.find((check) => check.id === "deployment.topology")?.state,
    "manual",
  );
  assert.equal(
    checks.find((check) => check.id === "supabase.auth")?.state,
    "manual",
  );
  assert.ok(checks.every((check) => check.purpose && check.instructions));
});

test("setup checks recompute from local values and never disclose credentials", () => {
  const config = { ...base(), setup: { auth: "supabase" as const } };
  const before = setupChecks(config, {});
  const after = setupChecks(config, {
    supabaseProjectRef: "x".repeat(20),
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_synthetic",
  });
  assert.equal(
    before.find((check) => check.id === "supabase.project")?.state,
    "missing",
  );
  assert.equal(
    after.find((check) => check.id === "supabase.project")?.state,
    "configured",
  );
  assert.ok(after.some((check) => check.action === "supabase.auth"));
  assert.ok(!JSON.stringify(after).includes("sb_publishable_synthetic"));
  assert.equal(
    setupChecks(config, { supabaseProjectRef: "invalid" }).find(
      (check) => check.id === "supabase.project",
    )?.state,
    "missing",
  );
});

test("setup declaration validates bounded field references, documents and identifiers", () => {
  const invalid = [
    null,
    [],
    { components: {} },
    {
      components: [
        { id: "Invalid", title: "web", kind: "web", hosting: "pages" },
      ],
    },
    { components: [{ id: "web", title: "", kind: "web", hosting: "pages" }] },
    {
      components: [
        { id: "web", title: "web", kind: "other", hosting: "pages" },
      ],
    },
    {
      components: [{ id: "web", title: "web", kind: "web", hosting: "other" }],
    },
    {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          docs: "https://localhost/docs",
        },
      ],
    },
    {
      requirements: [
        {
          id: "check",
          title: "check",
          purpose: "purpose",
          instructions: "check",
          fields: [],
        },
      ],
    },
    {
      requirements: [
        {
          id: "check",
          title: "check",
          purpose: "purpose",
          instructions: "check",
          fields: ["supabaseUrl", "supabaseUrl"],
        },
      ],
    },
    {
      requirements: [
        {
          id: "check",
          title: "check",
          purpose: "purpose",
          instructions: "check",
        },
        {
          id: "check",
          title: "check",
          purpose: "purpose",
          instructions: "check",
        },
      ],
    },
  ];
  for (const setup of invalid)
    assert.throws(() => validateConfig({ ...base(), setup }));
  assert.doesNotThrow(() => validateConfig({ ...base(), setup: {} }));
});

test("model includes only declared optional services and keeps manual evidence unknown", () => {
  const config = validateConfig({
    ...base(),
    deploymentTopology: "worker-private-origin",
    repository: "example/project",
    setup: {
      auth: "external",
      components: [{ id: "web", title: "web", kind: "web", hosting: "worker" }],
      requirements: [
        {
          id: "payments",
          title: "支付",
          purpose: "支付闭环",
          instructions: "在沙盒环境人工检查。",
          docs: "https://example.com/docs",
        },
      ],
    },
  });
  const checks = setupChecks(config, {});
  assert.ok(
    checks.some(
      (check) =>
        check.id === "github.account" && check.action === "github.connect",
    ),
  );
  assert.ok(checks.some((check) => check.id === "auth.external"));
  assert.equal(
    checks.find((check) => check.id === "requirement.payments")?.state,
    "manual",
  );
  assert.ok(!checks.some((check) => /push|backup|ai/.test(check.id)));
  const none = setupChecks(
    validateConfig({
      version: 1,
      project: "bare-project",
      environments: ["staging"],
      variables: {},
      setup: { auth: "none" },
    }),
    {},
  );
  assert.ok(
    !none.some(
      (check) =>
        check.id.startsWith("supabase.") || check.id.startsWith("cloudflare."),
    ),
  );
});

test("component deployment branch comes from mapped environment values", () => {
  const config = validateConfig({
    ...base(),
    variables: { ...base().variables, frontendBranch: "FRONTEND_BRANCH" },
    extraFields: {
      frontendBranch: { label: "前台部署分支", kind: "text", secret: false },
    },
    setup: {
      components: [
        {
          id: "web",
          title: "web",
          kind: "web",
          hosting: "pages",
          originField: "appOrigin",
          projectField: "pagesProject",
          branchField: "frontendBranch",
        },
      ],
    },
  });
  const values = {
    appOrigin: "https://app.example.com",
    pagesProject: "sample-project",
  };
  assert.equal(
    setupChecks(config, values).find(
      (check) => check.id === "component.web.config",
    )?.state,
    "missing",
  );
  const filled = setupChecks(config, {
    ...values,
    frontendBranch: "release/candidate",
  }).find((check) => check.id === "component.web.config");
  assert.equal(filled?.state, "configured");
  assert.equal(filled?.action, "cloudflare.pages");
  assert.throws(
    () =>
      validateConfig({
        ...base(),
        setup: {
          components: [
            {
              id: "web",
              title: "web",
              kind: "web",
              hosting: "pages",
              branchField: "appOrigin",
            },
          ],
        },
      }),
    /引导/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...base(),
        setup: {
          components: [
            {
              id: "web",
              title: "web",
              kind: "web",
              hosting: "pages",
              branchField: "supabasePublishableKey",
            },
          ],
        },
      }),
    /引导/,
  );
});

test("Pages component mappings cannot overwrite account or built-in runtime fields", () => {
  const config = {
    ...base(),
    variables: {
      ...base().variables,
      sshTarget: "SSH_TARGET",
      adminPages: "ADMIN_PAGES",
      adminBranch: "ADMIN_BRANCH",
    },
    extraFields: {
      adminPages: { label: "后台 Pages", kind: "text" as const, secret: false },
      adminBranch: { label: "后台分支", kind: "text" as const, secret: false },
    },
  };
  const component = {
    id: "web",
    title: "web",
    kind: "web",
    hosting: "pages",
    originField: "appOrigin",
  };
  for (const projectField of [
    "cloudflareAccountId",
    "appOrigin",
    "sshTarget",
  ]) {
    assert.throws(
      () =>
        validateConfig({
          ...config,
          setup: { components: [{ ...component, projectField }] },
        }),
      /引导/,
    );
  }
  assert.throws(
    () =>
      validateConfig({
        ...config,
        setup: {
          components: [
            {
              ...component,
              projectField: "pagesProject",
              branchField: "sshTarget",
            },
          ],
        },
      }),
    /引导/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        setup: {
          components: [
            {
              ...component,
              projectField: "adminPages",
              branchField: "adminPages",
            },
          ],
        },
      }),
    /引导/,
  );
  assert.doesNotThrow(() =>
    validateConfig({
      ...config,
      setup: {
        components: [
          {
            ...component,
            projectField: "adminPages",
            branchField: "adminBranch",
          },
        ],
      },
    }),
  );
});

test("partial Pages mappings only offer editing and never operate on unrelated default fields", () => {
  const partials = [
    { projectField: "pagesProject" },
    { originField: "appOrigin" },
    {},
  ];
  for (const mapping of partials) {
    const config = validateConfig({
      ...base(),
      setup: {
        components: [
          {
            id: "web",
            title: "web",
            kind: "web",
            hosting: "pages",
            ...mapping,
          },
        ],
      },
    });
    const check = setupChecks(config, {}).find(
      (item) => item.id === "component.web.config",
    );
    assert.notEqual(check?.action, "cloudflare.pages");
    assert.equal(
      check?.action,
      Object.keys(mapping).length ? "edit" : undefined,
    );
  }
});

test("declared separate components do not request an already described topology", () => {
  const checks = setupChecks(declared(), {});
  assert.ok(!checks.some((check) => check.id === "deployment.topology"));
  assert.ok(checks.some((check) => check.id === "component.api.deployment"));
  assert.ok(checks.some((check) => check.id === "application.verified"));
});
