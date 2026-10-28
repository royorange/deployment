import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceStore, type Device } from "../src/devices.ts";
import { runReleaseFlow } from "../src/release-flow.ts";
import type { ReleaseReceipt } from "../src/release-engine.ts";
import { values, type Context } from "../src/wizard.ts";

async function fixture(answers: string[] = []) {
  const store = await DeviceStore.open("/synthetic-release-devices", {
    memory: true,
  });
  const device: Device = {
    id: "test-host",
    label: "测试设备",
    host: "192.0.2.1",
    user: "deploy",
    port: 22,
  };
  await store.save(device);
  const prompts: string[] = [],
    logs: string[] = [],
    calls: string[] = [];
  let saves = 0;
  const ctx: Context = {
    root: "/synthetic-release",
    env: "staging",
    storageMode: "memory",
    config: {
      version: 1,
      project: "fixture",
      repository: "owner/fixture",
      deploymentTopology: "aws-tunnel",
      environments: ["staging"],
      variables: {},
      release: {
        adapter: "deploy/release.mts",
        ciWorkflow: "ci.yml",
        environments: ["staging"],
        components: [
          {
            id: "pages",
            label: "Pages",
            kind: "pages",
            requiresDevice: false,
            migrations: "none",
          },
          {
            id: "app",
            label: "应用",
            kind: "application",
            requiresDevice: true,
            migrations: "supabase-cli",
          },
        ],
      },
    },
    data: { credentials: { fixture: "synthetic-secret" }, profiles: {} },
    save: async () => {
      saves++;
    },
    runner: async () => {
      throw new Error("unexpected shell call");
    },
    ui: {
      select: async (message, choices) => {
        prompts.push(message);
        const answer = answers.shift()!;
        assert.ok(
          choices.some((choice) => choice.value === answer),
          `${message}: ${answer}`,
        );
        return answer;
      },
      input: async () => "",
      confirm: async () => true,
      check: async () => [],
      log: (message) => logs.push(message),
    },
  };
  values(ctx).cloudflareTunnelId = "11111111-2222-3333-4444-555555555555";
  const execute = async (
    _ctx: Context,
    component: string,
    selected?: Device,
  ): Promise<ReleaseReceipt> => {
    calls.push(component);
    if (component === "app") assert.deepEqual(selected, device);
    return {
      version: 1,
      project: "fixture",
      environment: "staging",
      component,
      commit: "a".repeat(40),
      ciRunId: 1,
      state: "health-checked",
      database: component === "app" ? "up-to-date" : "not-run",
      phase: "verify",
      checkedAt: "2026-10-26T00:00:00.000Z",
      ...(selected ? { deviceId: selected.id } : {}),
    };
  };
  return {
    ctx,
    store,
    device,
    prompts,
    logs,
    calls,
    execute,
    saves: () => saves,
  };
}

test("direct component execution reuses a registered device without nested release menus", async () => {
  const f = await fixture();
  const result = await runReleaseFlow(
    f.ctx,
    { componentIds: ["app"], deviceId: f.device.id, store: f.store },
    { run: f.execute },
  );
  assert.equal(result.state, "health-checked");
  assert.equal(result.deviceId, f.device.id);
  assert.deepEqual(f.calls, ["app"]);
  assert.deepEqual(f.prompts, []);
  assert.equal(values(f.ctx)["@releaseDeviceId"], f.device.id);
  assert.equal(f.saves(), 1);
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
});
test("device selection cancellation returns cancellation without running an adapter or saving a target", async () => {
  const f = await fixture(["back"]);
  const result = await runReleaseFlow(
    f.ctx,
    { componentIds: ["app"], store: f.store },
    { run: f.execute },
  );
  assert.equal(result.state, "cancelled");
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.saves(), 0);
});
test("selected all components execute application before Pages and save the selected target", async () => {
  const f = await fixture(["all", "device:test-host"]);
  const result = await runReleaseFlow(
    f.ctx,
    { store: f.store },
    { run: f.execute },
  );
  assert.equal(result.state, "health-checked");
  assert.deepEqual(f.calls, ["app", "pages"]);
  assert.deepEqual(
    result.receipts.map((receipt) => receipt.component),
    ["app", "pages"],
  );
  assert.equal(values(f.ctx)["@releaseDeviceId"], "test-host");
});
test("failed or cancelled application never publishes Pages and preserves its public receipt", async () => {
  for (const state of ["failed", "cancelled"] as const) {
    const f = await fixture();
    const result = await runReleaseFlow(
      f.ctx,
      { componentIds: ["pages", "app"], deviceId: f.device.id, store: f.store },
      {
        run: async (ctx, component, device) => ({
          ...(await f.execute(ctx, component, device)),
          state,
        }),
      },
    );
    assert.equal(result.state, state);
    assert.deepEqual(f.calls, ["app"]);
    assert.equal(result.receipts[0]!.state, state);
  }
});
test("missing Tunnel or stale saved device blocks before running a release", async () => {
  for (const missing of ["tunnel", "device"]) {
    const f = await fixture();
    values(f.ctx)["@releaseDeviceId"] = "removed-host";
    if (missing === "tunnel") delete values(f.ctx).cloudflareTunnelId;
    const result = await runReleaseFlow(
      f.ctx,
      { componentIds: ["app"], store: f.store },
      { run: f.execute },
    );
    assert.equal(result.state, "blocked");
    assert.equal(
      result.reason,
      missing === "tunnel" ? "missing-tunnel" : "missing-device",
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.prompts, []);
  }
});
test("saved device is reused without another selector and a new choice can explicitly replace it", async () => {
  const f = await fixture(["device:test-host"]);
  values(f.ctx)["@releaseDeviceId"] = "removed-host";
  const replaced = await runReleaseFlow(
    f.ctx,
    { componentIds: ["app"], chooseDevice: true, store: f.store },
    { run: f.execute },
  );
  assert.equal(replaced.state, "health-checked");
  assert.equal(values(f.ctx)["@releaseDeviceId"], f.device.id);
  f.prompts.length = 0;
  const resumed = await runReleaseFlow(
    f.ctx,
    { componentIds: ["app"], store: f.store },
    { run: f.execute },
  );
  assert.equal(resumed.state, "health-checked");
  assert.deepEqual(f.prompts, []);
  assert.equal(f.saves(), 1);
});
test("empty, unknown or undeclared components never produce a successful release", async () => {
  for (const selection of [[], ["unknown"], ["pages", "pages"]]) {
    const f = await fixture();
    const result = await runReleaseFlow(
      f.ctx,
      { componentIds: selection },
      { run: f.execute },
    );
    assert.equal(result.state, selection.length ? "blocked" : "cancelled");
    assert.deepEqual(result.receipts, []);
    assert.deepEqual(f.calls, []);
  }
  const f = await fixture();
  delete f.ctx.config.release;
  const result = await runReleaseFlow(
    f.ctx,
    { componentIds: ["pages"] },
    { run: f.execute },
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "missing-release");
});
test("returning from component selection is cancellation, and Pages needs no SSH selection", async () => {
  const f = await fixture(["back"]);
  assert.equal(
    (await runReleaseFlow(f.ctx, {}, { run: f.execute })).state,
    "cancelled",
  );
  f.prompts.length = 0;
  const result = await runReleaseFlow(
    f.ctx,
    { componentIds: ["pages"] },
    { run: f.execute },
  );
  assert.equal(result.state, "health-checked");
  assert.deepEqual(f.prompts, []);
  assert.equal(f.saves(), 0);
  assert.equal(result.deviceId, undefined);
});
test("initial release gates fail safely and prompt interruptions retain immediate CLI exit semantics", async () => {
  for (const failure of ["gate", "AbortPromptError", "ExitPromptError"]) {
    const f = await fixture();
    const operation = runReleaseFlow(
      f.ctx,
      { componentIds: ["app", "pages"], deviceId: f.device.id, store: f.store },
      {
        run: async () => {
          const error = new Error("synthetic-secret");
          if (failure !== "gate") error.name = failure;
          throw error;
        },
      },
    );
    if (failure === "gate") {
      const result = await operation;
      assert.equal(result.state, "failed");
      assert.deepEqual(result.receipts, []);
      assert.ok(!JSON.stringify([result, f.logs]).includes("synthetic-secret"));
    } else await assert.rejects(operation, { name: failure });
    assert.deepEqual(f.calls, []);
  }
});
test("void or mismatched receipts never become success or pollute completed receipt history", async () => {
  for (const invalid of ["void", "project", "environment", "component"]) {
    const f = await fixture();
    const result = await runReleaseFlow(
      f.ctx,
      { componentIds: ["pages"] },
      {
        run: async () => {
          if (invalid === "void") return undefined as unknown as ReleaseReceipt;
          return {
            ...(await f.execute(f.ctx, "pages")),
            [invalid]: "different",
          };
        },
      },
    );
    assert.equal(result.state, "failed");
    assert.deepEqual(result.receipts, []);
  }
});

test("explicit project order supports a Pages-first composite topology", async () => {
  const f = await fixture(["all", "device:test-host"]);
  f.ctx.config.release!.order = ["pages", "app"];
  const result = await runReleaseFlow(
    f.ctx,
    { store: f.store },
    { run: f.execute },
  );
  assert.equal(result.state, "health-checked");
  assert.deepEqual(f.calls, ["pages", "app"]);
});
