import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReleaseCi, readReleaseCi } from "../src/release-ci.ts";
import type { Runner } from "../src/process.ts";

const sha = "a".repeat(40);
const repository = "example/application";
const workflow = "ci.yml";
const target = { repository, workflow, sha };
const base = {
  id: 101,
  workflow_id: 12,
  workflow_url:
    "https://api.github.com/repos/example/application/actions/workflows/12",
  path: ".github/workflows/ci.yml",
  head_sha: sha,
  head_branch: "staging",
  head_repository: { full_name: repository, fork: false },
  created_at: "2026-10-20T09:00:00Z",
  run_number: 1,
  run_attempt: 1,
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: "https://untrusted.example/credential",
  display_title: "private-server-message",
};

function runnerFor(runs: unknown[], totalCount = runs.length): Runner {
  return async (command, args) => {
    assert.equal(command, "gh");
    assert.deepEqual(args, [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100&page=1`,
    ]);
    return JSON.stringify({ total_count: totalCount, workflow_runs: runs });
  };
}

test("release CI uses a fixed read-only endpoint and projects public verified evidence", async () => {
  const evidence = await readReleaseCi({
    ...target,
    runner: runnerFor([base]),
  });
  assert.deepEqual(evidence, {
    state: "passed",
    sha,
    runId: 101,
    url: "https://github.com/example/application/actions/runs/101",
    branch: "staging",
  });
  assert.equal(
    (await assertReleaseCi({ ...target, runner: runnerFor([base]) })).state,
    "passed",
  );
  assert.ok(!JSON.stringify(evidence).includes("private-server-message"));
  assert.ok(!JSON.stringify(evidence).includes("untrusted.example"));
});

test("latest run wins over older success, irrespective of response order", async () => {
  const latest = {
    ...base,
    id: 102,
    run_number: 2,
    created_at: "2026-10-21T09:00:00Z",
    conclusion: "failure",
  };
  for (const runs of [
    [base, latest],
    [latest, base],
  ]) {
    const result = await readReleaseCi({ ...target, runner: runnerFor(runs) });
    assert.equal(result.state, "failed");
    assert.equal(result.runId, 102);
  }
  const tied = { ...latest, created_at: base.created_at };
  assert.equal(
    (await readReleaseCi({ ...target, runner: runnerFor([base, tied]) })).runId,
    102,
  );
});

test("rerun selects highest attempt and pending reruns never inherit previous success", async () => {
  const retry = {
    ...base,
    run_attempt: 2,
    status: "in_progress",
    conclusion: null,
  };
  for (const runs of [
    [base, retry],
    [retry, base],
  ])
    assert.equal(
      (await readReleaseCi({ ...target, runner: runnerFor(runs) })).state,
      "pending",
    );
  assert.equal(
    (
      await readReleaseCi({
        ...target,
        runner: runnerFor([
          base,
          { ...retry, status: "completed", conclusion: "failure" },
        ]),
      })
    ).state,
    "failed",
  );
});

test("only completed success passes and unsuccessful or unknown conclusions remain blocked", async () => {
  for (const status of [
    "queued",
    "in_progress",
    "waiting",
    "requested",
    "pending",
  ])
    assert.equal(
      (
        await readReleaseCi({
          ...target,
          runner: runnerFor([{ ...base, status, conclusion: null }]),
        })
      ).state,
      "pending",
    );
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "skipped",
    "neutral",
    "action_required",
    "stale",
    "startup_failure",
  ])
    assert.equal(
      (
        await readReleaseCi({
          ...target,
          runner: runnerFor([{ ...base, conclusion }]),
        })
      ).state,
      "failed",
    );
  for (const patch of [
    { status: "new-status" },
    { conclusion: null },
    { conclusion: "new-conclusion" },
  ])
    assert.equal(
      (
        await readReleaseCi({
          ...target,
          runner: runnerFor([{ ...base, ...patch }]),
        })
      ).state,
      "unknown",
    );
});

test("forks, mismatched repository or SHA, and unverifiable workflow identity are unknown", async () => {
  for (const patch of [
    { head_repository: undefined },
    { head_repository: null },
    { head_repository: { full_name: "attacker/application", fork: false } },
    { head_repository: { full_name: repository, fork: true } },
    { head_repository: { full_name: repository, fork: "false" } },
    { head_sha: "b".repeat(40) },
    { path: undefined },
    { path: ".github/workflows/other.yml" },
    { path: "ci.yml" },
    { workflow_id: "12" },
    { workflow_id: 0 },
    {
      workflow_url:
        "https://api.github.com/repos/attacker/application/actions/workflows/12",
    },
    {
      workflow_url:
        "https://api.github.com/repos/example/application/actions/workflows/13",
    },
  ]) {
    assert.equal(
      (
        await readReleaseCi({
          ...target,
          runner: runnerFor([{ ...base, ...patch }]),
        })
      ).state,
      "unknown",
      JSON.stringify(patch),
    );
  }
  assert.equal(
    (
      await readReleaseCi({
        ...target,
        runner: runnerFor([base, { ...base, id: 102, workflow_id: 13 }]),
      })
    ).state,
    "unknown",
  );
});

test("same-repository PRs and workflow refs may pass but privileged or unfamiliar events cannot", async () => {
  const sameRepo = {
    ...base,
    event: "pull_request",
    path: ".github/workflows/ci.yml@refs/heads/staging",
  };
  assert.equal(
    (await readReleaseCi({ ...target, runner: runnerFor([sameRepo]) })).state,
    "passed",
  );
  assert.equal(
    (
      await readReleaseCi({
        ...target,
        runner: runnerFor([
          { ...base, head_repository: { full_name: repository } },
        ]),
      })
    ).state,
    "passed",
  );
  for (const event of [
    "workflow_run",
    "pull_request_target",
    "repository_dispatch",
    "unknown-event",
    undefined,
  ])
    assert.equal(
      (
        await readReleaseCi({
          ...target,
          runner: runnerFor([{ ...base, event }]),
        })
      ).state,
      "unknown",
    );
});

test("empty results are missing while malformed, incomplete or excessive lists are unknown", async () => {
  assert.deepEqual(await readReleaseCi({ ...target, runner: runnerFor([]) }), {
    state: "missing",
    sha,
  });
  for (const runs of [
    [null],
    [{ ...base, id: "101" }],
    [{ ...base, created_at: "not-a-date" }],
    [{ ...base, run_number: -1 }],
    [{ ...base, run_attempt: 0 }],
  ])
    assert.equal(
      (await readReleaseCi({ ...target, runner: runnerFor(runs) })).state,
      "unknown",
    );
  for (const value of [
    "not-json",
    "null",
    "{}",
    JSON.stringify({ total_count: 1, workflow_runs: [] }),
  ])
    assert.equal(
      (await readReleaseCi({ ...target, runner: async () => value })).state,
      "unknown",
    );
  assert.equal(
    (await readReleaseCi({ ...target, runner: runnerFor([base], 101) })).state,
    "unknown",
  );
});

test("input validation occurs before runner calls and never reflects the invalid values", async () => {
  let calls = 0;
  const runner: Runner = async () => {
    calls++;
    return "";
  };
  for (const patch of [
    { repository: "https://github.com/example/application" },
    { repository: "../application" },
    { repository: "example/app?token=private-input" },
    { repository: "example/." },
    { workflow: "../ci.yml" },
    { workflow: ".github/workflows/ci.yml" },
    { workflow: "ci.yml?token=private-input" },
    { workflow: "ci" },
    { sha: "HEAD" },
    { sha: "a".repeat(39) },
    { sha: "a".repeat(40) + "\n" },
  ]) {
    await assert.rejects(
      readReleaseCi({ ...target, ...patch, runner }),
      (error: Error) => !error.message.includes("private-input"),
    );
  }
  assert.equal(calls, 0);
});

test("runner errors and assertion messages never expose remote output or credentials", async () => {
  const runner: Runner = async () => {
    throw new Error("credential-private-output");
  };
  assert.deepEqual(await readReleaseCi({ ...target, runner }), {
    state: "unknown",
    sha,
  });
  for (const runs of [
    [],
    [{ ...base, status: "queued" }],
    [{ ...base, conclusion: "failure" }],
    [null],
  ])
    await assert.rejects(
      assertReleaseCi({ ...target, runner: runnerFor(runs) }),
      /CI/,
    );
  await assert.rejects(
    assertReleaseCi({ ...target, runner }),
    (error: Error) => !error.message.includes("credential-private-output"),
  );
});
