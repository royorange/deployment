import assert from "node:assert/strict";
import { test } from "node:test";
import { githubReadMetadata, githubReadBody } from "../src/github-read.ts";
import { CommandExecutionError, run } from "../src/process.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { readReleaseCi } from "../src/release-ci.ts";
import { createReleaseCiGate } from "../src/release-ci-policy.ts";

const args = [
  "api",
  "--hostname",
  "github.com",
  "--method",
  "GET",
  "--include",
  "repos/test/app/actions/workflows/ci.yml/runs?head_sha=" +
    "a".repeat(40) +
    "&per_page=100&page=1",
];
test("GitHub error metadata is bounded, allowlisted and never retains header or response text", () => {
  const raw =
    'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nRetry-After: 20\r\nAuthorization: secret-value\r\nSet-Cookie: credential\r\n\r\n{"message":"private"}';
  assert.deepEqual(githubReadMetadata("gh", args, raw), {
    httpStatus: 403,
    rateLimited: true,
    retryAfterSeconds: 20,
  });
  assert.equal(githubReadMetadata("node", args, raw), undefined);
  assert.equal(
    githubReadMetadata(
      "gh",
      args.map((a) => (a === "GET" ? "POST" : a)),
      raw,
    ),
    undefined,
  );
  assert.equal(
    githubReadMetadata(
      "gh",
      args.map((a) => (a === "github.com" ? "evil.test" : a)),
      raw,
    ),
    undefined,
  );
  assert.equal(
    githubReadMetadata("gh", args, "private output\n" + raw),
    undefined,
  );
  assert.equal(
    githubReadMetadata(
      "gh",
      args,
      "HTTP/2 429\nRetry-After: 1\nRetry-After: 20\n\nsecret",
    )?.retryAfterSeconds,
    undefined,
  );
  assert.equal(
    githubReadMetadata("gh", args, "HTTP/2 403\n\nrate limit exceeded")
      ?.rateLimited,
    undefined,
  );
});
test("successful include output strips only a valid bounded HTTP header block", () => {
  assert.equal(
    githubReadBody(
      'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"ok":true}',
    ),
    '{"ok":true}',
  );
  assert.equal(githubReadBody('{"ok":true}'), '{"ok":true}');
  assert.throws(() => githubReadBody("HTTP/2 500\n\nprivate-body"), /GitHub/);
  assert.throws(
    () => githubReadBody("HTTP/2 200\n" + "a".repeat(20_000)),
    /GitHub/,
  );
});
test("runner timeout and exit errors expose safe typed facts only", async () => {
  await assert.rejects(
    run(process.execPath, [
      "-e",
      "console.log('PRIVATE');console.error('PASSWORD');process.exit(2)",
    ]),
    (e) => {
      assert.ok(e instanceof CommandExecutionError);
      assert.equal(e.exitCode, 2);
      assert.ok(!JSON.stringify(e).includes("PRIVATE"));
      assert.ok(!e.message.includes("PASSWORD"));
      return true;
    },
  );
  await assert.rejects(
    run(process.execPath, ["-e", "setTimeout(()=>{},2000)"], { timeout: 10 }),
    (e) => {
      assert.ok(e instanceof CommandExecutionError);
      assert.equal(e.timedOut, true);
      return true;
    },
  );
});

test("real spawned gh failures expose HTTP facts without stdout, stderr or private headers", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "setup-gh-failure-"));
  try {
    await writeFile(
      join(directory, "gh"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify("HTTP/2.0 429 Too Many Requests\nRetry-After: 60\nSet-Cookie: PRIVATE_COOKIE\n\nPRIVATE_BODY")});process.stderr.write("PRIVATE_TOKEN");process.exit(1);\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      run("gh", args, {
        env: { PATH: directory + delimiter + (process.env.PATH ?? "") },
      }),
      (e) => {
        assert.ok(e instanceof CommandExecutionError);
        assert.equal(e.httpStatus, 429);
        assert.equal(e.retryAfterSeconds, 60);
        assert.equal(e.rateLimited, true);
        assert.ok(!JSON.stringify(e).includes("PRIVATE"));
        assert.ok(!e.message.includes("PRIVATE"));
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate reset dates and Retry-After dates produce bounded wait hints", () => {
  const now = Date.parse("2026-10-28T00:00:00Z");
  for (const header of [
    "Retry-After: Wed, 28 Oct 2026 00:00:30 GMT",
    `X-RateLimit-Reset: ${now / 1000 + 30}`,
  ])
    assert.equal(
      githubReadMetadata(
        "gh",
        args,
        `HTTP/2 403\nX-RateLimit-Remaining: 0\n${header}\n\nprivate`,
        now,
      )?.retryAfterSeconds,
      30,
    );
  assert.equal(
    githubReadMetadata(
      "gh",
      args,
      "HTTP/2 429\nRetry-After: 99999999\n\nprivate",
      now,
    )?.retryAfterSeconds,
    86400,
  );
  assert.equal(
    githubReadMetadata(
      "gh",
      args,
      "HTTP/2 403\nX-RateLimit-Remaining: 0\nX-RateLimit-Remaining: 9\n\nprivate",
      now,
    )?.rateLimited,
    undefined,
  );
});

test("secondary rate limits require a unique numeric Retry-After rather than any 403 text", () => {
  assert.deepEqual(
    githubReadMetadata(
      "gh",
      args,
      "HTTP/2 403\nX-RateLimit-Remaining: 500\nRetry-After: 90\n\nprivate",
    ),
    { httpStatus: 403, rateLimited: true, retryAfterSeconds: 90 },
  );
  for (const header of [
    "Retry-After: invalid",
    "Retry-After: 90\nRetry-After: 90",
    "Retry-After: -1",
    "Retry-After: 1.5",
  ])
    assert.equal(
      githubReadMetadata(
        "gh",
        args,
        `HTTP/2 403\nX-RateLimit-Remaining: 500\n${header}\n\nrate limit exceeded`,
      )?.rateLimited,
      undefined,
    );
});

test("received terminal or unverified response cannot turn into a degradable timeout", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "setup-gh-timeout-"));
  const target = {
    repository: "test/app",
    workflow: "ci.yml",
    sha: "a".repeat(40),
  };
  const successful = JSON.stringify({
    total_count: 1,
    workflow_runs: [
      {
        id: 1,
        workflow_id: 1,
        run_number: 1,
        run_attempt: 1,
        path: ".github/workflows/ci.yml",
        head_sha: target.sha,
        head_repository: { full_name: target.repository, fork: false },
        created_at: "2026-10-28T00:00:00Z",
        event: "push",
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  try {
    for (const [response, reason] of [
      ["HTTP/2 401\nContent-Type: application/json\n\nPRIVATE", "unauthorized"],
      ["HTTP/2 403\nContent-Type: application/json\n\nPRIVATE", "forbidden"],
      ["HTTP/2 404\nContent-Type: application/json\n\nPRIVATE", "not-found"],
      ["HTTP/2 401\nContent-Type:", "malformed"],
      ["PRIVATE malformed response", "malformed"],
      ["HTTP/2 200\nContent-Type: application/json\n\n{", "malformed"],
      ["HTTP/2 429\nRetry-After: 1\n\n" + "x".repeat(2_100_000), "malformed"],
    ] as const) {
      const responseFile = join(directory, "response.txt");
      await writeFile(responseFile, response);
      await writeFile(
        join(directory, "gh"),
        `#!/bin/sh\n/bin/cat '${responseFile.replaceAll("'", "'\\''")}'\nexec /bin/sleep 5\n`,
        { mode: 0o700 },
      );
      let error: CommandExecutionError | undefined;
      try {
        await run("gh", args, {
          env: { PATH: directory + delimiter + (process.env.PATH ?? "") },
          timeout: 1500,
        });
      } catch (value) {
        assert.ok(value instanceof CommandExecutionError);
        error = value;
      }
      assert.ok(error);
      assert.ok(!JSON.stringify(error).includes("PRIVATE"));
      const evidence = await readReleaseCi({
        ...target,
        runner: async () => {
          throw error;
        },
        sleep: async () => assert.fail("terminal response must not retry"),
      });
      assert.equal(evidence.reason, reason);
      let reads = 0,
        prompts = 0;
      const gate = await createReleaseCiGate({
        ...target,
        environment: "staging",
        transientFallback: { maxAgeSeconds: 300 },
        runner: async () => {
          if (!reads++) return successful;
          throw error;
        },
        sleep: async () => assert.fail("no early retry"),
        confirm: async () => {
          prompts++;
          return true;
        },
      });
      await assert.rejects(gate.recheck(), /CI/);
      assert.equal(prompts, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
