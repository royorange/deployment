import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectKey } from "../src/config.ts";
import { DeviceStore, type Device } from "../src/devices.ts";
import {
  bindEnvironmentDevice,
  boundEnvironmentDevice,
  environmentsSharingDevice,
  switchEnvironmentDevice,
} from "../src/environment-device.ts";
import type { Context } from "../src/wizard.ts";

const shared: Device = {
  id: "shared-host",
  label: "Shared host",
  host: "shared.example.test",
  user: "ubuntu",
  port: 22,
};
const dedicated: Device = {
  id: "prod-host",
  label: "Production host",
  host: "prod.example.test",
  user: "ubuntu",
  port: 22,
};

async function fixture(
  env: string,
  bindings: Record<string, string> = {},
): Promise<{
  ctx: Context;
  store: DeviceStore;
  logs: string[];
  confirms: string[];
  saves: () => number;
  answer: (value: boolean) => void;
  close: () => Promise<void>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "env-device-")));
  const store = await DeviceStore.open(join(root, "devices"), { memory: true });
  await store.save(shared);
  await store.save(dedicated);
  const logs: string[] = [],
    confirms: string[] = [];
  let saves = 0,
    reply = true;
  const profiles: Context["data"]["profiles"] = {};
  for (const [environment, deviceId] of Object.entries(bindings))
    profiles[projectKey("fixture", environment)] = {
      "@releaseDeviceId": deviceId,
    };
  const ctx: Context = {
    root,
    env,
    storageMode: "memory",
    config: {
      version: 1,
      project: "fixture",
      environments: ["staging", "production"],
      variables: {},
    },
    data: { credentials: {}, profiles },
    save: async () => {
      saves++;
    },
    runner: async () => "",
    ui: {
      select: async () => "back",
      input: async () => "",
      check: async () => [],
      confirm: async (message) => {
        confirms.push(message);
        return reply;
      },
      log: (message) => logs.push(message),
    },
  };
  return {
    ctx,
    store,
    logs,
    confirms,
    saves: () => saves,
    answer: (value) => {
      reply = value;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
const binding = (ctx: Context, env = ctx.env) =>
  ctx.data.profiles[projectKey("fixture", env)]?.["@releaseDeviceId"];

test("lists only other environments of the same project bound to a device", async () => {
  const f = await fixture("production", {
    staging: "shared-host",
    production: "shared-host",
  });
  try {
    assert.deepEqual(environmentsSharingDevice(f.ctx, "shared-host"), [
      "staging",
    ]);
    assert.deepEqual(environmentsSharingDevice(f.ctx, "prod-host"), []);
  } finally {
    await f.close();
  }
});

test("first binding of an unshared device saves without an extra confirmation", async () => {
  const f = await fixture("production", { staging: "shared-host" });
  try {
    assert.equal(await bindEnvironmentDevice(f.ctx, dedicated, f.store), true);
    assert.equal(binding(f.ctx), "prod-host");
    assert.equal(binding(f.ctx, "staging"), "shared-host");
    assert.equal(f.confirms.length, 0);
    assert.equal(f.saves(), 1);
  } finally {
    await f.close();
  }
});

test("binding production to a host used by staging requires a warned confirmation", async () => {
  const f = await fixture("production", { staging: "shared-host" });
  f.answer(false);
  try {
    assert.equal(await bindEnvironmentDevice(f.ctx, shared, f.store), false);
    assert.equal(binding(f.ctx), undefined);
    assert.equal(f.saves(), 0);
    assert.match(f.confirms[0]!, /fixture\/staging/);
    assert.match(f.confirms[0]!, /production/);
  } finally {
    await f.close();
  }
});

test("switching an existing binding warns about the old host and Tunnel replicas", async () => {
  const f = await fixture("production", { production: "shared-host" });
  try {
    assert.equal(await bindEnvironmentDevice(f.ctx, dedicated, f.store), true);
    assert.equal(binding(f.ctx), "prod-host");
    assert.equal(f.confirms.length, 1);
    assert.match(f.confirms[0]!, /Shared host/);
    assert.match(f.confirms[0]!, /Tunnel/);
    assert.match(f.confirms[0]!, /不会被停止/);
  } finally {
    await f.close();
  }
});

test("declining a switch keeps the existing binding", async () => {
  const f = await fixture("staging", { staging: "shared-host" });
  f.answer(false);
  try {
    assert.equal(await bindEnvironmentDevice(f.ctx, dedicated, f.store), false);
    assert.equal(binding(f.ctx), "shared-host");
    assert.equal(f.saves(), 0);
    assert.ok(f.logs.some((l) => l.includes("保留原部署设备")));
  } finally {
    await f.close();
  }
});

test("switch reports the current device and keeps an unchanged selection", async () => {
  const f = await fixture("staging", { staging: "shared-host" });
  try {
    const result = await switchEnvironmentDevice(f.ctx, {
      store: f.store,
      select: async () => shared,
    });
    assert.equal(result?.id, "shared-host");
    assert.equal(f.confirms.length, 0);
    assert.equal(f.saves(), 0);
    assert.ok(f.logs.some((l) => l.includes("Shared host")));
    assert.ok(f.logs.some((l) => l.includes("未更改")));
  } finally {
    await f.close();
  }
});

test("switch binds a newly selected device and resolves it from the store", async () => {
  const f = await fixture("production", { production: "shared-host" });
  try {
    const result = await switchEnvironmentDevice(f.ctx, {
      store: f.store,
      select: async () => dedicated,
    });
    assert.equal(result?.id, "prod-host");
    assert.equal(boundEnvironmentDevice(f.ctx, f.store)?.id, "prod-host");
  } finally {
    await f.close();
  }
});

test("a missing saved device is reported instead of silently replaced", async () => {
  const f = await fixture("staging", { staging: "removed-host" });
  try {
    assert.equal(boundEnvironmentDevice(f.ctx, f.store), undefined);
    const result = await switchEnvironmentDevice(f.ctx, {
      store: f.store,
      select: async () => undefined,
    });
    assert.equal(result, undefined);
    assert.equal(binding(f.ctx), "removed-host");
    assert.ok(f.logs.some((l) => l.includes("removed-host")));
  } finally {
    await f.close();
  }
});
