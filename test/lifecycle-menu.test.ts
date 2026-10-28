import assert from "node:assert/strict";
import { test } from "node:test";
import { lifecycleMenu } from "../src/lifecycle-menu.ts";
import { DeviceStore } from "../src/devices.ts";
import { fixture, device, old, output } from "./lifecycle-fixture.ts";
import { projectKey } from "../src/config.ts";

test("one lifecycle screen refreshes resources, stops, resumes and rolls back a selected compatible revision", async () => {
  const f = await fixture();
  const target = "d".repeat(40);
  const store = await DeviceStore.open(f.ctx.deviceDirectory!, {
    memory: true,
  });
  await store.save(device);
  const answers = ["refresh", "stop", "resume", "rollback", target, "back"];
  let state = "running",
    current = old;
  try {
    const runner = f.ctx.runner;
    f.ctx.runner = async (cmd, args, o) => {
      const response = await runner(cmd, args, o);
      if (cmd !== process.execPath) return response;
      const req = JSON.parse(o!.input!);
      if (args.at(-1) === "apply") {
        state = req.operation === "stop" ? "stopped" : "running";
        if (req.operation === "rollback") current = target;
      }
      const out = output(state);
      out.snapshot.current = current;
      out.snapshot.revisions.push({
        revision: target,
        compatible: true,
        reason: "same schema synthetic-account-token",
      });
      return JSON.stringify(out);
    };
    f.ctx.ui.select = async (message, choices) => {
      assert.ok(
        !choices.some((c) => c.name.includes("synthetic-account-token")),
      );
      const answer = answers.shift();
      assert.ok(
        choices.some((c) => c.value === answer),
        `${answer}: ${message}`,
      );
      return answer!;
    };
    await lifecycleMenu(f.ctx, { store });
    assert.equal(answers.length, 0);
    assert.equal(f.calls.filter((c) => c.args.at(-1) === "apply").length, 3);
    assert.equal(
      f.logs.filter((l) => l.includes("生命周期操作及最新状态核验通过")).length,
      3,
    );
  } finally {
    await f.close();
  }
});
test("readonly failure is redacted, can be refreshed, and cancellation never applies", async () => {
  const f = await fixture();
  const store = await DeviceStore.open(f.ctx.deviceDirectory!, {
    memory: true,
  });
  await store.save(device);
  let calls = 0;
  const answers = ["refresh", "stop", "back"];
  try {
    const runner = f.ctx.runner;
    f.ctx.runner = async (cmd, args, o) => {
      if (cmd === process.execPath && ++calls === 1)
        throw new Error("synthetic-account-token failed");
      return runner(cmd, args, o);
    };
    let confirms = 0;
    f.ctx.ui.confirm = async () => ++confirms === 1;
    f.ctx.ui.select = async (message, choices) => {
      const answer = answers.shift();
      assert.ok(
        choices.some((c) => c.value === answer),
        `${answer}: ${message}`,
      );
      return answer!;
    };
    await lifecycleMenu(f.ctx, { store });
    assert.ok(!f.logs.join(" ").includes("synthetic-account-token"));
    assert.ok(f.logs.some((l) => l.includes("已取消操作")));
    assert.ok(!f.calls.some((c) => c.args.at(-1) === "apply"));
  } finally {
    await f.close();
  }
});
test("cancelled controller trust or component choice exits without running the adapter", async () => {
  const f = await fixture();
  const store = await DeviceStore.open(f.ctx.deviceDirectory!, {
    memory: true,
  });
  await store.save(device);
  try {
    f.ctx.ui.confirm = async () => false;
    await lifecycleMenu(f.ctx, { store });
    assert.ok(!f.calls.some((c) => c.command === process.execPath));
    f.ctx.config.release!.components.push({
      ...f.ctx.config.release!.components[0]!,
      id: "other",
    });
    f.ctx.ui.select = async () => "back";
    await lifecycleMenu(f.ctx, { store });
    assert.ok(!f.calls.some((c) => c.command === process.execPath));
  } finally {
    await f.close();
  }
});
test("explicit device selection is saved once and unsupported environments do not offer lifecycle execution", async () => {
  const f = await fixture();
  const store = await DeviceStore.open(f.ctx.deviceDirectory!, {
    memory: true,
  });
  await store.save(device);
  try {
    delete f.ctx.data.profiles[projectKey("fixture", "staging")]![
      "@releaseDeviceId"
    ];
    const answers = ["device:host", "back"];
    f.ctx.ui.select = async (message, choices) => {
      const answer = answers.shift();
      assert.ok(
        choices.some((c) => c.value === answer),
        `${answer}: ${message}`,
      );
      return answer!;
    };
    await lifecycleMenu(f.ctx, { store });
    assert.equal(
      f.ctx.data.profiles[projectKey("fixture", "staging")]![
        "@releaseDeviceId"
      ],
      device.id,
    );
    f.ctx.env = "production";
    await assert.rejects(lifecycleMenu(f.ctx, { store }), /未声明/);
  } finally {
    await f.close();
  }
});
