import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandExecutionError } from "../src/process.ts";
import { readReleaseCi } from "../src/release-ci.ts";
const target = {
  repository: "test/app",
  workflow: "ci.yml",
  sha: "a".repeat(40),
};
test("transient read failure can recover to a normal authoritative live result", async () => {
  let count = 0;
  const result = await readReleaseCi({
    ...target,
    sleep: async () => {},
    runner: async () => {
      if (!count++)
        throw new CommandExecutionError("gh", 1, { httpStatus: 503 });
      return (
        "HTTP/2 200\nContent-Type: application/json\n\n" +
        JSON.stringify({ total_count: 0, workflow_runs: [] })
      );
    },
  });
  assert.equal(count, 2);
  assert.deepEqual(result, { state: "missing", sha: target.sha });
});
test("CI retries only typed temporary failures at most three calls", async () => {
  for (const metadata of [
    { httpStatus: 429, retryAfterSeconds: 1 },
    { httpStatus: 403, rateLimited: true, retryAfterSeconds: 1 },
    { httpStatus: 503 },
    { timedOut: true },
  ]) {
    const waits: number[] = [];
    let calls = 0;
    const r = await readReleaseCi({
      ...target,
      runner: async () => {
        calls++;
        throw new CommandExecutionError("gh", 1, metadata);
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.equal(r.state, "unknown");
    assert.ok(
      ["rate-limited", "service-unavailable", "timeout"].includes(r.reason!),
    );
  }
});
test("CI preserves rate wait hints without sleeping for long server delays", async () => {
  let calls = 0;
  const r = await readReleaseCi({
    ...target,
    runner: async () => {
      calls++;
      throw new CommandExecutionError("gh", 1, {
        httpStatus: 429,
        retryAfterSeconds: 60,
      });
    },
    sleep: async () => assert.fail("long retry should return"),
  });
  assert.equal(calls, 1);
  assert.equal(r.retryAfterSeconds, 60);
  assert.equal(r.reason, "rate-limited");
});

test("rate limits without a usable wait hint stop for at least one minute", async () => {
  let calls = 0;
  const result = await readReleaseCi({
    ...target,
    runner: async () => {
      calls++;
      throw new CommandExecutionError("gh", 1, { httpStatus: 429 });
    },
    sleep: async () => assert.fail("must not retry early"),
  });
  assert.equal(calls, 1);
  assert.equal(result.retryAfterSeconds, 60);
});
test("CI authorization, malformed and unclassified errors do not become temporary failures", async () => {
  for (const [error, reason] of [
    [new CommandExecutionError("gh", 1, { httpStatus: 401 }), "unauthorized"],
    [new CommandExecutionError("gh", 1, { httpStatus: 403 }), "forbidden"],
    [new CommandExecutionError("gh", 1, { httpStatus: 404 }), "not-found"],
    [new Error("token 429 503 timeout"), "unavailable"],
  ] as const) {
    let calls = 0;
    const r = await readReleaseCi({
      ...target,
      runner: async () => {
        calls++;
        throw error;
      },
      sleep: async () => assert.fail("no retry"),
    });
    assert.equal(calls, 1);
    assert.equal(r.reason, reason);
    assert.ok(!JSON.stringify(r).includes("token"));
  }
  assert.equal(
    (await readReleaseCi({ ...target, runner: async () => "bad-json" })).reason,
    "malformed",
  );
});
