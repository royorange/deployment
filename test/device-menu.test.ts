import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceStore } from "../src/devices.ts";
import { deviceMenu, selectDevice } from "../src/device-menu.ts";
import type { UI } from "../src/wizard.ts";
const device = {
  id: "aws",
  label: "AWS staging",
  host: "192.0.2.1",
  user: "deploy",
  port: 22,
};
function ui(
  answers: string[],
  inputs: string[] = [],
  confirms: boolean[] = [],
) {
  const logs: string[] = [];
  const prompts: string[] = [];
  return {
    logs,
    prompts,
    ui: {
      select: async (message, choices) => {
        prompts.push(message);
        const value = answers.shift()!;
        assert.ok(
          choices.some((c) => c.value === value),
          `${message}: ${value}`,
        );
        return value;
      },
      input: async () => inputs.shift()!,
      confirm: async () => confirms.shift() ?? false,
      check: async () => [],
      log: (s) => logs.push(s),
    } satisfies UI,
  };
}
test("device menu previews before save and memory sessions never promise persistence", async () => {
  const store = await DeviceStore.open("/path-not-read", { memory: true });
  const f = ui(
    ["add", "back"],
    ["aws", "AWS staging", "192.0.2.1", "deploy", "22"],
    [true],
  );
  await deviceMenu({
    ui: f.ui,
    store,
    runner: async () => {
      throw new Error("unexpected");
    },
  });
  assert.deepEqual(store.list(), [device]);
  assert.ok(f.logs.some((s) => s.includes("不持久化")));
  assert.ok(f.logs.some((s) => s.includes("192.0.2.1")));
});
test("declined edits and deletes preserve profile; failed SSH advises manual host verification", async () => {
  const store = await DeviceStore.open("/not-read", { memory: true });
  await store.save(device);
  const f = ui(
    ["device:aws", "edit", "delete", "check", "command", "back", "back"],
    ["changed", "192.0.2.2", "newuser", "2222"],
    [false, false],
  );
  await deviceMenu({
    ui: f.ui,
    store,
    runner: async () => {
      throw new Error("secret private raw");
    },
  });
  assert.deepEqual(store.read("aws"), device);
  assert.ok(f.logs.some((s) => s.includes("主机指纹")));
  assert.ok(!f.logs.join("").includes("secret private raw"));
});
test("selector returns a validated copy and supports profile management then return", async () => {
  const store = await DeviceStore.open("/not-read", { memory: true });
  await store.save(device);
  const f = ui(["manage", "back", "device:aws"]);
  assert.deepEqual(
    await selectDevice({ ui: f.ui, store, runner: async () => "" }),
    device,
  );
  const b = ui(["back"]);
  assert.equal(
    await selectDevice({ ui: b.ui, store, runner: async () => "" }),
    undefined,
  );
});
test("confirmed edits and deletes complete, invalid connection is never saved", async () => {
  const store = await DeviceStore.open("/not-read", { memory: true });
  await store.save(device);
  const f = ui(
    ["device:aws", "edit", "delete", "add", "back"],
    [
      "changed",
      "2001:db8::1",
      "newuser",
      "2222",
      "invalid",
      "bad",
      "-bad",
      "root",
      "22",
    ],
    [true, true],
  );
  await deviceMenu({ ui: f.ui, store, runner: async () => "" });
  assert.deepEqual(store.list(), []);
  assert.ok(f.logs.some((s) => s.includes("操作未完成")));
});
test("successful SSH check is explicitly limited and duplicate additions cannot overwrite", async () => {
  const store = await DeviceStore.open("/not-read", { memory: true });
  await store.save(device);
  const f = ui(["add", "device:aws", "check", "back", "back"], ["aws"]);
  let calls = 0;
  await deviceMenu({
    ui: f.ui,
    store,
    runner: async () => {
      calls++;
      return "";
    },
  });
  assert.equal(calls, 1);
  assert.ok(f.logs.some((s) => s.includes("尚未验证 Docker")));
  assert.ok(f.logs.some((s) => s.includes("已存在")));
});

test("Ctrl+C in device editing escapes the menu without saving or pretending failure", async () => {
  const store = await DeviceStore.open("/not-read", { memory: true });
  const f = ui(["add"]);
  f.ui.input = async () => {
    const error = new Error("cancelled");
    error.name = "ExitPromptError";
    throw error;
  };
  await assert.rejects(
    deviceMenu({ ui: f.ui, store, runner: async () => "" }),
    { name: "ExitPromptError" },
  );
  assert.equal(store.list().length, 0);
});
