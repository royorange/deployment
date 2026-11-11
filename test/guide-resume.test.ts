import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentGuide } from "../src/deployment-guide.ts";
import { GuideProgressStore } from "../src/deployment-guide-store.ts";
import { guideBinding } from "../src/deployment-guide-model.ts";
import { values } from "../src/wizard.ts";
import { fixture, published, sha } from "./guide-fixture.ts";
test("reopened guide can retain freshly checked running app and publish only remaining Pages", async () => {
  const f = await fixture(["skip", "run", "exit"]);
  const old = "b".repeat(40);
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
    const answers = [
      "overview",
      "stage:application",
      "inspect",
      "keep-running",
      "run",
      "finish",
    ];
    f.ctx.ui.select = async (message, choices) => {
      f.messages.push(message);
      const answer = answers.shift();
      assert.ok(
        choices.some((c) => c.value === answer),
        `Unexpected ${answer}: ${message}`,
      );
      return answer!;
    };
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        inspect: async () => [
          {
            component: "api",
            state: "running",
            current: old,
            controllerCommit: sha,
            message: "fresh existing deployment",
          },
        ],
        release: async (ctx, opts) => {
          assert.deepEqual(opts!.componentIds, ["web"]);
          releases++;
          return published(ctx, "web");
        },
      },
    );
    assert.equal(releases, 2);
    assert.ok(f.messages.some((m) => m.includes(old) && m.includes(sha)));
    assert.ok(
      f.messages.some((m) => m.includes("保留") && m.includes("待发布")),
    );
    const store = await GuideProgressStore.open(f.options.directory, {
      root: f.root,
      project: "fixture",
      repository: "fixture/repo",
      environment: "staging",
    });
    const state = store.read(
      guideBinding(f.ctx.config, values(f.ctx), undefined, sha),
    );
    assert.ok(
      state.history.some((h) => h.component === "api" && h.commit === old),
    );
  } finally {
    await f.cleanup();
  }
});

test("partial component success is retained for same-session retry instead of redeploying the successful app", async () => {
  const f = await fixture(["skip", "run", "run", "run", "finish"]);
  f.ctx.config.release!.components.splice(1, 0, {
    id: "jobs",
    label: "Jobs",
    kind: "application",
    requiresDevice: false,
    migrations: "none",
  });
  const calls: string[][] = [];
  try {
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        release: async (ctx, opts) => {
          const ids = opts!.componentIds!;
          calls.push(ids);
          if (calls.length === 1) {
            const ok = published(ctx, "api");
            const failed = published(ctx, "jobs").receipts[0]!;
            failed.state = "failed";
            return { state: "failed", receipts: [...ok.receipts, failed] };
          }
          return published(ctx, ids[0]!);
        },
      },
    );
    assert.deepEqual(calls, [["api", "jobs"], ["jobs"], ["web"]]);
  } finally {
    await f.cleanup();
  }
});

test("interleaved component order returns to the explicit release flow without reordering or deploying", async () => {
  const f = await fixture([]);
  try {
    f.ctx.config.release!.components.push({
      id: "jobs",
      label: "Jobs",
      kind: "application",
      requiresDevice: false,
      migrations: "none",
    });
    f.ctx.config.release!.order = ["api", "web", "jobs"];
    assert.equal(await deploymentGuide(f.ctx, {}, f.options), "back");
    assert.ok(
      f.messages.some((m) => m.includes("交错") && m.includes("依次发布全部")),
    );
  } finally {
    await f.cleanup();
  }
});

test("target changes after inspection invalidate retention instead of adopting stale running evidence", async () => {
  const f = await fixture(["skip", "inspect", "keep-running", "exit"]);
  const original = f.ctx.ui.select;
  f.ctx.ui.select = async (message, choices) => {
    const choice = await original(message, choices);
    if (choice === "keep-running")
      values(f.ctx).appOrigin = "https://other.example.test";
    return choice;
  };
  try {
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        inspect: async () => [
          {
            component: "api",
            state: "running",
            current: "b".repeat(40),
            controllerCommit: sha,
            message: "healthy",
          },
        ],
        release: async () => {
          throw new Error("must not publish");
        },
      },
    );
    assert.ok(f.messages.some((m) => m.includes("运行证据已失效")));
    const store = await GuideProgressStore.open(f.options.directory, {
      root: f.root,
      project: "fixture",
      repository: "fixture/repo",
      environment: "staging",
    });
    assert.ok(
      !store
        .read(guideBinding(f.ctx.config, values(f.ctx), undefined, sha))
        .history.some((h) => h.component === "api" && h.outcome === "verified"),
    );
  } finally {
    await f.cleanup();
  }
});

test("a new failed release discards earlier inspection instead of offering stale retention", async () => {
  const f = await fixture(["skip", "inspect", "run", "exit"]);
  const original = f.ctx.ui.select;
  let failed = false;
  f.ctx.ui.select = async (message, choices) => {
    if (failed) assert.ok(!choices.some((c) => c.value === "keep-running"));
    return original(message, choices);
  };
  try {
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        inspect: async () => [
          {
            component: "api",
            state: "running",
            current: "b".repeat(40),
            controllerCommit: sha,
            message: "healthy",
          },
        ],
        release: async (ctx) => {
          failed = true;
          const result = published(ctx, "api");
          result.state = "failed";
          result.receipts[0]!.state = "failed";
          return result;
        },
      },
    );
  } finally {
    await f.cleanup();
  }
});

test("Pages-first grouped guide preserves prior Pages success while publishing the app", async () => {
  const f = await fixture(["skip", "run", "run", "finish"]);
  f.ctx.config.release!.order = ["web", "api"];
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
          return published(ctx, id);
        },
      },
    );
    assert.deepEqual(calls, ["web", "api"]);
  } finally {
    await f.cleanup();
  }
});

test("release completion for an old target cannot complete the changed target or advance to Pages", async () => {
  const f = await fixture(["skip", "run", "exit"]);
  const calls: string[] = [];
  try {
    await deploymentGuide(
      f.ctx,
      {},
      {
        ...f.options,
        release: async (ctx, opts) => {
          calls.push(opts!.componentIds![0]!);
          const result = published(ctx, "api");
          values(ctx).appOrigin = "https://changed.example.test";
          return result;
        },
      },
    );
    assert.deepEqual(calls, ["api"]);
    assert.ok(
      f.messages.some(
        (message) => message.includes("目标") && message.includes("未采纳"),
      ),
    );
    assert.ok(
      !f.messages.some((message) =>
        message.includes("当前组件发布与基础健康核验通过"),
      ),
    );
  } finally {
    await f.cleanup();
  }
});
