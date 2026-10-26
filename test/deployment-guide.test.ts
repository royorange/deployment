import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import {
  performGuideStage,
  probeGuide,
} from "../src/deployment-guide-actions.ts";
import { DeviceStore } from "../src/devices.ts";
import { GuideProgressStore } from "../src/deployment-guide-store.ts";
import { guideBinding } from "../src/deployment-guide-model.ts";
import { guidedWizard } from "../src/guided-menu.ts";
import { values } from "../src/wizard.ts";
import { deploymentGuide } from "../src/deployment-guide.ts";
import type { Context } from "../src/wizard.ts";
import type { ReleaseFlowResult } from "../src/release-flow.ts";
const sha = "a".repeat(40);
async function fixture(answers: string[], auth = false) {
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
function published(
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
test("one guide resumes configured inputs and runs application before Pages, leaving business acceptance explicit", async () => {
  const f = await fixture(["skip", "run", "run", "finish"]);
  const calls: string[] = [];
  try {
    const result = await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        release: async (ctx, opts) => {
          const id = opts!.componentIds![0]!;
          calls.push(id);
          return published(ctx, id);
        },
      },
    );
    assert.equal(result, "exit");
    assert.deepEqual(calls, ["api", "web"]);
    assert.ok(f.messages.some((x) => x.includes("阶段")));
    assert.ok(f.messages.some((x) => x.includes("业务验收")));
    const files = await readdir(join(f.root, "guides"));
    const saved = await readFile(join(f.root, "guides", files[0]!), "utf8");
    assert.ok(!saved.includes("fixture-hidden"));
    assert.ok(!saved.includes("sb_publishable"));
    assert.ok(!saved.includes('"acceptance","outcome":"verified"'));
  } finally {
    await f.cleanup();
  }
});
test("failed application stays at the same phase and never starts Pages; database changes remain visible", async () => {
  const f = await fixture(["skip", "run", "exit"]);
  const calls: string[] = [];
  try {
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        release: async (ctx, opts) => {
          const id = opts!.componentIds![0]!;
          calls.push(id);
          const r = published(ctx, id, "applied");
          r.state = "failed";
          r.receipts[0]!.state = "failed";
          return r;
        },
      },
    );
    assert.deepEqual(calls, ["api"]);
    assert.ok(f.messages.some((x) => x.includes("数据库已变更")));
    assert.ok(
      f.messages.filter((x) => x.includes("CI、迁移与应用发布")).length >= 2,
    );
  } finally {
    await f.cleanup();
  }
});
test("an Auth action returning void or cancelled cannot unlock application publication", async () => {
  for (const result of [undefined, { status: "cancelled" }]) {
    const f = await fixture(["skip", "run", "exit"], true);
    let releases = 0;
    try {
      await deploymentGuide(
        f.ctx,
        { "supabase.auth": async () => result },
        {
          ...f.options,
          probe: async (_ctx, stage) =>
            stage === "auth"
              ? { status: "configured" }
              : { status: "verified" },
          release: async () => {
            releases++;
            throw new Error("must not publish");
          },
        },
      );
      assert.equal(releases, 0);
      assert.ok(
        f.messages.filter((x) => x.includes("核验 Supabase Auth 回调"))
          .length >= 2,
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("reopening restores navigation but does not automatically replay a previous publication", async () => {
  const f = await fixture(["skip", "run", "exit"]);
  let releases = 0;
  try {
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        release: async (ctx, opts) => {
          releases++;
          return published(ctx, opts!.componentIds![0]!);
        },
      },
    );
    const answers = ["exit"];
    f.ctx.ui.select = async (_m, choices) => {
      const value = answers.shift()!;
      assert.ok(choices.some((c) => c.value === value));
      return value;
    };
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        release: async () => {
          throw new Error("automatic replay");
        },
      },
    );
    assert.equal(releases, 1);
  } finally {
    await f.cleanup();
  }
});

test("expired Cloudflare probe returns to account repair and redacts action messages", async () => {
  const f = await fixture(["skip", "run", "exit"]);
  let repaired = 0;
  try {
    await deploymentGuide(
      f.ctx,
      {
        "cloudflare.account": async () => {
          repaired++;
          return {
            status: "cancelled",
            message: "fixture-hidden-cloudflare expired",
          };
        },
        "cloudflare.pages": async () => {
          throw new Error("wrong repair operation");
        },
      },
      {
        ...f.options,
        probe: async () => {
          throw new Error("fixture-hidden-cloudflare expired");
        },
      },
    );
    assert.equal(repaired, 1);
    assert.ok(!f.messages.join("\n").includes("fixture-hidden-cloudflare"));
  } finally {
    await f.cleanup();
  }
});
test("a missing explicit selected device never falls back to a historical different device", async () => {
  const f = await fixture(["exit"]);
  try {
    f.ctx.config.release!.components[0]!.requiresDevice = true;
    f.ctx.deviceDirectory = join(f.root, "devices");
    const devices = await DeviceStore.open(f.ctx.deviceDirectory);
    const old = {
      id: "old-host",
      label: "Old",
      host: "192.0.2.1",
      user: "ubuntu",
      port: 22,
    };
    await devices.save(old);
    const store = await GuideProgressStore.open(f.options.directory, {
      root: f.root,
      repository: f.ctx.config.repository,
      project: "fixture",
      environment: "staging",
    });
    const p = store.read(guideBinding(f.ctx.config, values(f.ctx), old, sha));
    p.deviceId = old.id;
    p.importDisposition = "skipped";
    await store.save(p);
    values(f.ctx)["@releaseDeviceId"] = "deleted-host";
    await deploymentGuide(f.ctx, {}, f.options);
    assert.ok(f.messages.some((m) => m.includes("选择部署设备")));
  } finally {
    await f.cleanup();
  }
});
test("homepage starts the unified guide and saving exit exits the tool directly", async () => {
  const f = await fixture(["guide", "exit"]);
  try {
    f.ctx.storageMode = "memory";
    await guidedWizard(f.ctx, {});
    assert.ok(f.messages.some((m) => m.includes("阶段 1/")));
    assert.equal(f.messages.filter((m) => m.includes("— 配置中心")).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("guide actions select a validated device, configure missing inputs atomically, and keep external acceptance manual", async () => {
  const f = await fixture([]);
  try {
    const devices = await DeviceStore.open(join(f.root, "devices"), {
      memory: true,
    });
    const store = await GuideProgressStore.open(
      f.options.directory,
      {
        root: f.root,
        repository: f.ctx.config.repository,
        project: "fixture",
        environment: "staging",
      },
      { memory: true },
    );
    const progress = store.read(
      guideBinding(f.ctx.config, values(f.ctx), undefined, sha),
    );
    const opts = { devices, progress, actions: {} };
    const device = {
      id: "host",
      label: "Host",
      host: "192.0.2.1",
      user: "ubuntu",
      port: 22,
    };
    const stage = {
      id: "device" as const,
      title: "Device",
      state: "missing" as const,
      missingFields: ["device"],
    };
    assert.equal(
      (
        await performGuideStage(f.ctx, stage, {
          ...opts,
          select: async () => undefined,
        })
      ).outcome && values(f.ctx)["@releaseDeviceId"],
      undefined,
    );
    assert.deepEqual(
      (
        await performGuideStage(f.ctx, stage, {
          ...opts,
          select: async () => device,
        })
      ).device,
      device,
    );
    assert.equal(values(f.ctx)["@releaseDeviceId"], "host");
    const previous = values(f.ctx).appOrigin;
    let count = 0;
    f.ctx.ui.input = async () =>
      ++count === 1 ? "https://new.example.test" : "invalid";
    await assert.rejects(
      performGuideStage(
        f.ctx,
        {
          id: "configuration",
          title: "Config",
          state: "missing",
          missingFields: ["appOrigin", "siteOrigin"],
        },
        opts,
      ),
    );
    assert.equal(values(f.ctx).appOrigin, previous);
    f.ctx.ui.input = async () => "https://new.example.test";
    await performGuideStage(
      f.ctx,
      {
        id: "configuration",
        title: "Config",
        state: "missing",
        missingFields: ["appOrigin"],
      },
      opts,
    );
    assert.equal(values(f.ctx).appOrigin, "https://new.example.test");
    assert.deepEqual(
      (
        await performGuideStage(
          f.ctx,
          {
            id: "acceptance",
            title: "Acceptance",
            state: "manual",
            missingFields: [],
          },
          opts,
        )
      ).outcome,
      { status: "manual" },
    );
    assert.deepEqual(
      (
        await performGuideStage(
          f.ctx,
          {
            id: "auth",
            title: "External auth",
            state: "manual",
            missingFields: [],
          },
          opts,
        )
      ).outcome,
      { status: "manual" },
    );
    await assert.rejects(
      performGuideStage(
        f.ctx,
        { id: "tunnel", title: "Tunnel", state: "missing", missingFields: [] },
        opts,
      ),
      /未提供/,
    );
  } finally {
    await f.cleanup();
  }
});
test("Auth automatic probe is read only and requires exact configured origin plus callback", async () => {
  const f = await fixture([], true);
  const calls: string[] = [];
  try {
    f.ctx.fetcher = async (_url, init) => {
      calls.push(init?.method ?? "GET");
      return new Response(
        JSON.stringify({
          site_url: values(f.ctx).appOrigin,
          uri_allow_list: `${values(f.ctx).appOrigin}/**`,
        }),
      );
    };
    assert.equal((await probeGuide(f.ctx, "auth")).status, "verified");
    values(f.ctx).appOrigin = "https://changed.example.test";
    f.ctx.fetcher = async () =>
      new Response(
        JSON.stringify({
          site_url: "https://old.example.test",
          uri_allow_list: "https://old.example.test/**",
        }),
      );
    assert.equal((await probeGuide(f.ctx, "auth")).status, "configured");
    values(f.ctx)["@supabaseSource"] = "cli";
    f.ctx.fetcher = async () => {
      throw new Error("unexpected request");
    };
    assert.equal((await probeGuide(f.ctx, "auth")).status, "configured");
    assert.equal((await probeGuide(f.ctx, "acceptance")).status, "configured");
    assert.deepEqual(calls, ["GET"]);
  } finally {
    await f.cleanup();
  }
});

test("Pages failure exposes direct deploy credential repair without unrelated project menus", async () => {
  const f = await fixture([
    "skip",
    "run",
    "run",
    "repair-cloudflare",
    "cloudflare.ci-token",
    "exit",
  ]);
  let repairs = 0;
  try {
    await deploymentGuide(
      f.ctx,
      {
        "cloudflare.ci-token": async () => {
          repairs++;
        },
      },
      {
        ...f.options,
        release: async (ctx, opts) => {
          const result = published(ctx, opts!.componentIds![0]!);
          if (opts!.componentIds![0] === "web") result.state = "failed";
          return result;
        },
      },
    );
    assert.equal(repairs, 1);
  } finally {
    await f.cleanup();
  }
});
