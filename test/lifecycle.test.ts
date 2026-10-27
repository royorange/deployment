import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { validateConfig, projectKey } from "../src/config.ts";
import { lifecycleOutput } from "../src/lifecycle-protocol.ts";
import { createLifecycleController } from "../src/lifecycle-engine.ts";
import { lifecycleMenu } from "../src/lifecycle-menu.ts";
import { runRelease } from "../src/release-engine.ts";
import { DeviceStore } from "../src/devices.ts";
import {
  fixture,
  output,
  sha,
  old,
  token,
  device,
} from "./lifecycle-fixture.ts";
test("lifecycle schema is optional and restricts adapter and environments", () => {
  const input = {
    version: 1,
    project: "fixture",
    repository: "owner/fixture",
    environments: ["staging"],
    variables: {},
    release: {
      adapter: "deploy/release.mts",
      ciWorkflow: "ci.yml",
      environments: ["staging"],
      components: [
        {
          id: "app",
          label: "App",
          kind: "application",
          requiresDevice: true,
          migrations: "none",
        },
      ],
    },
  };
  assert.ok(validateConfig(input));
  for (const lifecycle of [
    { adapter: "../evil.mts", environments: ["staging"] },
    { adapter: "deploy/lifecycle.mts", environments: ["production"] },
    {
      adapter: "deploy/lifecycle.mts",
      environments: ["staging"],
      command: "sh",
    },
    { adapter: "deploy/lifecycle.mts", environments: [] },
  ])
    assert.throws(() =>
      validateConfig({ ...input, release: { ...input.release, lifecycle } }),
    );
});
test("lifecycle output rejects unknown fields, invalid revisions, excessive or control strings", () => {
  assert.deepEqual(lifecycleOutput(JSON.stringify(output())), output());
  for (const value of [
    { ...output(), command: "sh" },
    { ...output(), summary: ["unsafe\nline"] },
    { ...output(), snapshot: { ...output().snapshot, token: "bad" } },
    { ...output(), snapshot: { ...output().snapshot, extra: "secret" } },
    {
      ...output(),
      snapshot: {
        ...output().snapshot,
        revisions: [{ revision: "bad", compatible: true, reason: "invalid" }],
      },
    },
  ])
    assert.throws(() => lifecycleOutput(JSON.stringify(value)));
});
test("status trusts tracked controller but never requires CI, passes secrets or invokes apply", async () => {
  const f = await fixture();
  try {
    const c = await createLifecycleController(f.ctx, "app", device);
    assert.ok(c);
    const r = await c.inspect("status");
    assert.equal(r.snapshot?.current, old);
    assert.equal(f.calls.filter((x) => x.command === "gh").length, 0);
    const adapters = f.calls.filter((x) => x.command === process.execPath);
    assert.deepEqual(
      adapters.map((x) => x.args.at(-1)),
      ["inspect"],
    );
    assert.ok(!adapters[0]!.input!.includes("synthetic"));
    assert.ok(!("SUPABASE_ACCESS_TOKEN" in adapters[0]!.env!));
    assert.equal(JSON.parse(adapters[0]!.input!).commit, sha);
    assert.equal(f.confirmations.length, 1);
  } finally {
    await f.close();
  }
});
test("stop previews exact target and applies only confirmed token, then checks fresh state", async () => {
  const f = await fixture();
  try {
    const c = await createLifecycleController(f.ctx, "app", device);
    const runner = f.ctx.runner;
    let applied = false;
    f.ctx.runner = async (cmd, args, o) => {
      const result = await runner(cmd, args, o);
      if (cmd === process.execPath && args.at(-1) === "apply") applied = true;
      return cmd === process.execPath && applied
        ? JSON.stringify(output("stopped"))
        : result;
    };
    const r = await c.change("stop");
    assert.equal(r.state, "completed");
    const adapters = f.calls.filter((x) => x.command === process.execPath);
    assert.deepEqual(
      adapters.map((x) => x.args.at(-1)),
      ["inspect", "apply", "inspect"],
    );
    const request = JSON.parse(adapters[1]!.input!);
    assert.equal(request.expectedToken, token);
    assert.equal(request.operation, "stop");
    assert.ok(!("runtimeValues" in request));
    assert.equal(f.calls.filter((x) => x.command === "gh").length, 2);
    assert.ok(f.confirmations.some((m) => m.includes("不回滚数据库")));
  } finally {
    await f.close();
  }
});
test("cancelled change never applies and unknown CI never calls controller operation", async () => {
  const f = await fixture();
  try {
    const c = await createLifecycleController(f.ctx, "app", device);
    f.ctx.ui.confirm = async () => false;
    assert.equal((await c.change("stop")).state, "cancelled");
    assert.ok(!f.calls.some((x) => x.args.at(-1) === "apply"));
    const oldRunner = f.ctx.runner;
    f.ctx.runner = async (cmd, args, o) =>
      cmd === "gh" ? "{}" : oldRunner(cmd, args, o);
    await assert.rejects(c.change("resume"), /CI/);
  } finally {
    await f.close();
  }
});
test("changed source or CI between preview and apply blocks changes", async () => {
  for (const failure of ["source", "ci"]) {
    const f = await fixture();
    try {
      const c = await createLifecycleController(f.ctx, "app", device);
      const runner = f.ctx.runner;
      let ci = 0;
      f.ctx.ui.confirm = async () => {
        if (failure === "source")
          f.ctx.runner = async (cmd, args, o) =>
            cmd === "git" && args.includes("rev-parse")
              ? "d".repeat(40)
              : runner(cmd, args, o);
        return true;
      };
      if (failure === "ci")
        f.ctx.runner = async (cmd, args, o) =>
          cmd === "gh" && ++ci > 1 ? "{}" : runner(cmd, args, o);
      await assert.rejects(c.change("stop"));
      assert.ok(!f.calls.some((x) => x.args.at(-1) === "apply"));
    } finally {
      await f.close();
    }
  }
});
test("failed apply and unchanged post-check cannot report completed, and lock rejects concurrency", async () => {
  const f = await fixture();
  try {
    f.ctx.storageMode = "metadata";
    const c = await createLifecycleController(f.ctx, "app", device);
    const runner = f.ctx.runner;
    f.ctx.runner = async (cmd, args, o) =>
      cmd === process.execPath && args.at(-1) === "apply"
        ? JSON.stringify({
            ...output(),
            ready: false,
            missing: ["state changed"],
          })
        : runner(cmd, args, o);
    assert.equal((await c.change("stop")).state, "blocked");
    assert.equal(
      (await readdir(f.ctx.releaseDirectory!)).filter((n) =>
        n.endsWith(".lock"),
      ).length,
      0,
    );
    const receipts = (await readdir(f.ctx.releaseDirectory!)).filter((n) =>
      n.includes("lifecycle"),
    );
    assert.ok(receipts.length);
    assert.ok(
      !(
        await readFile(join(f.ctx.releaseDirectory!, receipts[0]!), "utf8")
      ).includes("synthetic-account-token"),
    );
    f.ctx.runner = runner;
    assert.equal((await c.change("stop")).state, "failed");
  } finally {
    await f.close();
  }
});
test("missing selected device never falls back or opens trusted adapter", async () => {
  const f = await fixture();
  try {
    f.ctx.storageMode = "metadata";
    const store = await DeviceStore.open(f.ctx.deviceDirectory!);
    await store.save({ ...device, id: "other" });
    await lifecycleMenu(f.ctx, { store });
    assert.equal(f.calls.length, 0);
    assert.ok(f.logs.some((m) => m.includes("不会改用其他")));
  } finally {
    await f.close();
  }
});

test("lifecycle mutations and normal deployment share the same in-process lock", async () => {
  const f = await fixture();
  let releaseConfirm!: () => void;
  let confirmed!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseConfirm = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    confirmed = resolve;
  });
  try {
    const c = await createLifecycleController(f.ctx, "app", device);
    f.ctx.ui.confirm = async () => {
      confirmed();
      await gate;
      return false;
    };
    const first = c.change("stop");
    await reached;
    await assert.rejects(c.change("resume"), /已有发布或生命周期/);
    await assert.rejects(runRelease(f.ctx, "app", device), /已有发布正在进行/);
    releaseConfirm();
    assert.equal((await first).state, "cancelled");
  } finally {
    releaseConfirm();
    await f.close();
  }
});

test("rollback applies a compatible selected revision and never rewrites to controller HEAD", async () => {
  const f = await fixture();
  const target = "d".repeat(40);
  let applied = false;
  try {
    const runner = f.ctx.runner;
    f.ctx.runner = async (cmd, args, o) => {
      const base = await runner(cmd, args, o);
      if (cmd !== process.execPath) return base;
      if (args.at(-1) === "apply") applied = true;
      const out = output();
      out.snapshot.revisions.push({
        revision: target,
        compatible: true,
        reason: "same migration set",
      });
      if (applied) out.snapshot.current = target;
      return JSON.stringify(out);
    };
    const c = await createLifecycleController(f.ctx, "app", device);
    assert.equal((await c.change("rollback", target)).state, "completed");
    const request = JSON.parse(
      f.calls.find((x) => x.args.at(-1) === "apply")!.input!,
    );
    assert.equal(request.targetRevision, target);
    assert.equal(request.commit, sha);
    assert.notEqual(request.targetRevision, request.commit);
    await assert.rejects(c.change("rollback", "invalid"));
    await assert.rejects(c.change("resume", target));
  } finally {
    await f.close();
  }
});

test("incompatible rollback, busy snapshots and missing tokens cannot reach apply", async () => {
  for (const failure of ["incompatible", "busy", "snapshot"]) {
    const f = await fixture();
    try {
      const runner = f.ctx.runner;
      f.ctx.runner = async (cmd, args, o) => {
        const base = await runner(cmd, args, o);
        if (cmd !== process.execPath) return base;
        const out = output();
        if (failure === "snapshot")
          return JSON.stringify({
            ready: true,
            summary: [],
            missing: [],
            effects: [],
          });
        if (failure === "busy") out.snapshot.state = "busy";
        return JSON.stringify(out);
      };
      const c = await createLifecycleController(f.ctx, "app", device);
      assert.equal(
        (await c.change("rollback", "d".repeat(40))).state,
        "blocked",
      );
      assert.ok(!f.calls.some((x) => x.args.at(-1) === "apply"));
    } finally {
      await f.close();
    }
  }
});

test("prompt interruptions propagate without applying and release the lifecycle lock", async () => {
  const f = await fixture();
  try {
    const c = await createLifecycleController(f.ctx, "app", device);
    const interrupted = new Error("synthetic interrupt");
    interrupted.name = "AbortPromptError";
    f.ctx.ui.confirm = async () => {
      throw interrupted;
    };
    await assert.rejects(c.change("stop"), (error) => error === interrupted);
    f.ctx.ui.confirm = async () => false;
    assert.equal((await c.change("stop")).state, "cancelled");
    assert.ok(!f.calls.some((x) => x.args.at(-1) === "apply"));
  } finally {
    await f.close();
  }
});

test("changing environment or selected public target while confirming requires a fresh lifecycle plan", async () => {
  for (const change of ["environment", "target"]) {
    const f = await fixture();
    try {
      const c = await createLifecycleController(f.ctx, "app", device);
      f.ctx.ui.confirm = async () => {
        if (change === "environment") f.ctx.env = "production";
        else
          f.ctx.data.profiles[projectKey("fixture", "staging")]!.appOrigin =
            "https://other.example.test";
        return true;
      };
      await assert.rejects(c.change("stop"), /目标|环境/);
      assert.ok(!f.calls.some((x) => x.args.at(-1) === "apply"));
    } finally {
      await f.close();
    }
  }
});

test("lifecycle state must be a primitive string and cannot coerce a busy state through an array", () => {
  for (const state of [["busy"], ["running"], null, 0, {}, true])
    assert.throws(() =>
      lifecycleOutput(
        JSON.stringify({
          ...output(),
          snapshot: { ...output().snapshot, state },
        }),
      ),
    );
});
