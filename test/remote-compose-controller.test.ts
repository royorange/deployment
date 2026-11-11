import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { composeFixture } from "./remote-compose-fixture.ts";
import type { RemoteComposeInput } from "../src/remote-compose.ts";

const first = "a".repeat(40),
  second = "c".repeat(40);
function input(revision = first): RemoteComposeInput {
  const image = `ghcr.io/example/app@sha256:${revision[0]!.repeat(64)}`;
  return {
    device: {
      id: "fixture",
      label: "Fixture",
      host: "host.example",
      user: "deploy",
      port: 22,
    },
    project: "example",
    environment: "staging",
    remoteDirectory: "/opt/example/staging",
    revision,
    composeYaml: JSON.stringify({
      services: { app: { image: "${APP_IMAGE}" } },
    }),
    publicEnv: { APP_IMAGE: image },
    imageDigests: { app: image },
    privateFiles: {
      "runtime.env": {
        content: "TOKEN=synthetic-private\n",
        uid: 0,
        mode: "0600",
      },
    },
    expectedServices: ["app"],
    healthService: "app",
  };
}

test("controller first publish, repeat and next version verify actual container identity and preserve previous", async () => {
  const f = await composeFixture();
  try {
    assert.equal((await f.run(input(), "inspect")).state, "absent");
    assert.equal((await f.run(input())).state, "deployed");
    assert.equal((await f.run(input())).state, "deployed");
    assert.equal(
      (await f.calls()).some((args) => args.includes("up")),
      false,
    );
    assert.equal((await f.run(input(), "inspect")).state, "deployed");
    assert.deepEqual(await f.run(input(second)), {
      version: 1,
      state: "deployed",
      revision: second,
      previous: first,
    });
    const current = await f.state();
    assert.equal(current.current, second);
    assert.equal(current.pending, null);
  } finally {
    await f.close();
  }
});

test("failed candidate restores and rechecks previous; failed restoration remains recovery-required", async () => {
  const f = await composeFixture();
  try {
    await f.run(input());
    assert.deepEqual(
      await f.run(input(second), "deploy", { failCandidate: true }),
      { version: 1, state: "recovered", revision: first, previous: null },
    );
    assert.equal((await f.state()).current, first);
    const failed = await f.run(input(second), "deploy", {
      failCandidate: true,
      failRecovery: true,
    });
    assert.equal(failed.state, "recovery-required");
    assert.equal((await f.run(input(), "inspect")).state, "recovery-required");
    assert.equal((await f.run(input())).state, "blocked");
  } finally {
    await f.close();
  }
});

test("explicit recovery uses saved previous files and requires exact current and previous revisions", async () => {
  const f = await composeFixture();
  try {
    await f.run(input());
    await f.run(input(second));
    const recovery = {
      ...input(),
      expectedCurrentRevision: second,
      targetRevision: first,
    };
    for (const changed of [
      { expectedCurrentRevision: first },
      { targetRevision: "d".repeat(40) },
    ]) {
      assert.equal(
        (await f.run({ ...recovery, ...changed }, "recover")).state,
        "blocked",
      );
      assert.equal((await f.state()).current, second);
      assert.equal(
        (await f.calls()).some((args) => args.includes("up")),
        false,
      );
    }
    // Incoming configuration cannot replace the saved version's private files.
    const withChangedInput = {
      ...recovery,
      privateFiles: {
        "runtime.env": {
          content: "TOKEN=ignored\n",
          uid: 0 as const,
          mode: "0600" as const,
        },
      },
    };
    assert.deepEqual(await f.run(withChangedInput, "recover"), {
      version: 1,
      state: "deployed",
      revision: first,
      previous: second,
    });
    assert.equal(
      await readFile(join(f.base, "releases", first, "runtime.env"), "utf8"),
      "TOKEN=synthetic-private\n",
    );
    assert.equal((await f.state()).pending, null);
  } finally {
    await f.close();
  }
});

test("explicit recovery health failure remains recovery-required and never records successful rollback", async () => {
  const f = await composeFixture();
  try {
    await f.run(input());
    await f.run(input(second));
    const recovery = {
      ...input(),
      expectedCurrentRevision: second,
      targetRevision: first,
    };
    assert.equal(
      (await f.run(recovery, "recover", { failCandidate: true })).state,
      "recovery-required",
    );
    assert.equal((await f.state()).current, second);
    assert.equal((await f.state()).pending, first);
    assert.equal((await f.run(input(), "inspect")).state, "recovery-required");
  } finally {
    await f.close();
  }
});

test("first publish health failure removes only owned candidate and retains no false current", async () => {
  const f = await composeFixture();
  try {
    assert.equal(
      (await f.run(input(), "deploy", { failCandidate: true })).state,
      "recovered",
    );
    assert.equal((await f.state()).current, null);
    assert.equal((await f.run(input(), "inspect")).state, "absent");
  } finally {
    await f.close();
  }
});

test("controller rejects raw YAML and external composition before invoking Docker", async () => {
  for (const content of [
    JSON.stringify({
      services: { app: { image: "fixture", provider: { type: "/bin/sh" } } },
    }),
    JSON.stringify({
      services: { app: { image: "fixture" } },
      models: { runner: { model: "host" } },
    }),
    "services:\n  app:\n    image: fixture\n",
    JSON.stringify({
      include: ["/opt/foreign/compose.yml"],
      services: { app: { image: "fixture" } },
    }),
    JSON.stringify({
      services: {
        app: { extends: { file: "/opt/foreign/compose.yml", service: "app" } },
      },
    }),
    JSON.stringify({
      services: {
        app: { image: "fixture", label_file: "/opt/foreign/labels" },
      },
    }),
    '{"services":{},"services":{"app":{"image":"fixture"}}}',
  ]) {
    const f = await composeFixture();
    try {
      assert.equal(
        (await f.run({ ...input(), composeYaml: content })).state,
        "blocked",
      );
      assert.deepEqual(await f.calls(), []);
    } finally {
      await f.close();
    }
  }
});

test("interrupted candidate preparation never publishes a partial SHA directory and permits retry", async () => {
  const f = await composeFixture();
  try {
    await f.run(input());
    assert.equal(
      (await f.run(input(second), "deploy", { interruptCandidateWrite: true }))
        .state,
      "blocked",
    );
    assert.equal((await f.state()).current, first);
    assert.equal(
      (await readdir(join(f.base, "releases"))).includes(second),
      false,
    );
    assert.equal(
      (await f.calls()).some((args) =>
        ["up", "stop", "down"].some((action) => args.includes(action)),
      ),
      false,
    );
    assert.deepEqual(await f.run(input(second)), {
      version: 1,
      state: "deployed",
      revision: second,
      previous: first,
    });
  } finally {
    await f.close();
  }
});

test("changed same-SHA secrets, unsafe Compose, wrong image revision and remote lock fail before container mutation", async () => {
  const f = await composeFixture();
  try {
    await f.run(input());
    const changed = input();
    changed.privateFiles = {
      "runtime.env": {
        content: "TOKEN=changed-synthetic\n",
        uid: 0,
        mode: "0600",
      },
    };
    for (const [value, options] of [
      [changed, {}],
      [input(second), { unsafeCompose: true }],
      [input(second), { wrongRevision: true }],
      [input(second), { holdLock: true }],
    ] as const) {
      assert.equal((await f.run(value, "deploy", options)).state, "blocked");
      assert.equal(
        (await f.calls()).some((args) =>
          ["up", "stop", "down"].some((action) => args.includes(action)),
        ),
        false,
      );
      assert.equal((await f.state()).current, first);
    }
  } finally {
    await f.close();
  }
});

test("symlinked control files, modified runtime files and foreign resource labels are rejected", async () => {
  const f = await composeFixture();
  try {
    await f.run(input());
    const path = join(f.base, "releases", first, "runtime.env");
    await chmod(path, 0o644);
    assert.equal((await f.run(input(second))).state, "blocked");
    await chmod(path, 0o600);
    const fixturePath = join(f.root, "opt", "fixture.json");
    const containers = JSON.parse(await readFile(fixturePath, "utf8"));
    containers[0].Config.Labels["com.docker.compose.project.working_dir"] =
      "/opt/other/staging";
    await writeFile(fixturePath, JSON.stringify(containers));
    assert.equal((await f.run(input(second))).state, "blocked");
    await symlink(join(f.base, "state.json"), join(f.base, "releases", second));
    assert.equal((await f.run(input(second))).state, "blocked");
  } finally {
    await f.close();
  }
});
