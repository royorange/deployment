import assert from "node:assert/strict";
import { test } from "node:test";
import { createReleaseCiGate } from "../src/release-ci-policy.ts";
import { CommandExecutionError } from "../src/process.ts";
import type { Runner } from "../src/process.ts";

const sha = "a".repeat(40);
const record = {
  id: 11,
  workflow_id: 9,
  path: ".github/workflows/ci.yml",
  head_sha: sha,
  head_repository: { full_name: "test/app", fork: false },
  run_number: 1,
  run_attempt: 1,
  created_at: "2026-10-28T00:00:00Z",
  event: "push",
  status: "completed",
  conclusion: "success",
};
const payload = (patch = {}) =>
  JSON.stringify({ total_count: 1, workflow_runs: [{ ...record, ...patch }] });
const target = {
  repository: "test/app",
  workflow: "ci.yml",
  sha,
  environment: "staging",
  sleep: async () => {},
};
const temporary = () =>
  new CommandExecutionError("gh", 1, {
    httpStatus: 429,
    rateLimited: true,
    retryAfterSeconds: 1,
  });

test("strict default never reuses success after GitHub becomes unavailable", async () => {
  let n = 0,
    confirmations = 0;
  const gate = await createReleaseCiGate({
    ...target,
    runner: async () => {
      if (!n++) return payload();
      throw temporary();
    },
    confirm: async () => {
      confirmations++;
      return true;
    },
  });
  await assert.rejects(gate.recheck(), /CI/);
  assert.equal(confirmations, 0);
  assert.equal(gate.snapshot().degraded, false);
});

test("explicit staging policy can reuse a recently verified run after bounded transient retries", async () => {
  let n = 0,
    now = 100_000,
    confirmations = 0;
  const gate = await createReleaseCiGate({
    ...target,
    transientFallback: { maxAgeSeconds: 300 },
    now: () => now,
    runner: async () => {
      if (!n++) return payload();
      throw temporary();
    },
    confirm: async (message) => {
      confirmations++;
      assert.match(message, /11/);
      return true;
    },
  });
  now += 60_000;
  assert.equal((await gate.recheck()).runId, 11);
  assert.equal(n, 4);
  assert.equal(confirmations, 1);
  assert.equal(gate.snapshot().degraded, true);
  assert.equal(gate.snapshot().reason, "rate-limited");
  now += 241_000;
  await assert.rejects(gate.recheck(), /CI/);
  assert.equal(confirmations, 1);
});

test("no initial live success, production, invalid ages and declined confirmation cannot degrade", async () => {
  await assert.rejects(
    createReleaseCiGate({
      ...target,
      transientFallback: { maxAgeSeconds: 300 },
      runner: async () => {
        throw temporary();
      },
      confirm: async () => true,
    }),
    /CI/,
  );
  for (const maxAgeSeconds of [0, -1, 301, 1.5, NaN])
    await assert.rejects(
      createReleaseCiGate({
        ...target,
        transientFallback: { maxAgeSeconds },
        runner: async () => payload(),
      }),
      /策略/,
    );
  await assert.rejects(
    createReleaseCiGate({
      ...target,
      environment: "production",
      transientFallback: { maxAgeSeconds: 300 },
      runner: async () => payload(),
    }),
    /生产/,
  );
  for (const environment of ["prod", "live", "PRODUCTION"])
    await assert.rejects(
      createReleaseCiGate({
        ...target,
        environment,
        transientFallback: { maxAgeSeconds: 300 },
        runner: async () => payload(),
      }),
      /生产/,
    );
  let n = 0;
  const gate = await createReleaseCiGate({
    ...target,
    transientFallback: { maxAgeSeconds: 300 },
    runner: async () => {
      if (!n++) return payload();
      throw temporary();
    },
    confirm: async () => false,
  });
  await assert.rejects(gate.recheck(), /CI/);
});

test("terminal evidence invalidates the gate and can never be replaced with old success", async () => {
  const bad: Array<() => string> = [
    () => payload({ conclusion: "failure" }),
    () => payload({ status: "queued", conclusion: null }),
    () => JSON.stringify({ total_count: 0, workflow_runs: [] }),
    () => "bad-json",
    () => {
      throw new CommandExecutionError("gh", 1, { httpStatus: 401 });
    },
    () => {
      throw new CommandExecutionError("gh", 1, { httpStatus: 403 });
    },
    () => {
      throw new Error("private-token 429");
    },
  ];
  for (const response of bad) {
    let n = 0,
      prompts = 0;
    const runner: Runner = async () => {
      if (!n++) return payload();
      if (n === 2) return response();
      throw temporary();
    };
    const gate = await createReleaseCiGate({
      ...target,
      runner,
      transientFallback: { maxAgeSeconds: 300 },
      confirm: async () => {
        prompts++;
        return true;
      },
    });
    await assert.rejects(gate.recheck(), /CI/);
    await assert.rejects(gate.recheck(), /CI/);
    assert.equal(prompts, 0);
  }
});

test("a changed run ID or attempt requires a fresh reviewed plan even when successful", async () => {
  for (const patch of [{ id: 12 }, { run_attempt: 2 }]) {
    let n = 0;
    const gate = await createReleaseCiGate({
      ...target,
      runner: async () => (!n++ ? payload() : payload(patch)),
    });
    await assert.rejects(gate.recheck(), /变化/);
  }
});

test("mutation of input options or returned evidence cannot retarget or corrupt a gate", async () => {
  const options = {
    ...target,
    runner: (async (_cmd, args) => {
      assert.ok(args.at(-1)?.includes(`head_sha=${sha}`));
      return payload();
    }) as Runner,
  };
  const gate = await createReleaseCiGate(options);
  options.sha = "b".repeat(40);
  gate.initial.runId = 999;
  assert.equal((await gate.recheck()).runId, 11);
  assert.equal((await gate.recheck()).sha, sha);
});

test("expiry during a confirmation and backward clock movement refuse stale evidence", async () => {
  for (const jump of [301_000, -1]) {
    let now = 1000,
      calls = 0;
    const gate = await createReleaseCiGate({
      ...target,
      transientFallback: { maxAgeSeconds: 300 },
      now: () => now,
      runner: async () => {
        if (!calls++) return payload();
        throw temporary();
      },
      confirm: async () => {
        now += jump;
        return true;
      },
    });
    await assert.rejects(gate.recheck(), /CI/);
  }
});
