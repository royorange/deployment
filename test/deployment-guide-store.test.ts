import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  realpath,
  readFile,
  stat,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuideProgressStore } from "../src/deployment-guide-store.ts";

const scope = {
  root: "/fixture",
  repository: "owner/repo",
  project: "fixture",
  environment: "staging",
};
const binding = "a".repeat(64);
async function temporary() {
  return mkdtemp(join(await realpath(tmpdir()), "setup-guide-"));
}
test("guide state survives restart with private permissions and history remains explicitly historical", async () => {
  const directory = await temporary();
  try {
    const store = await GuideProgressStore.open(
      join(directory, "progress"),
      scope,
    );
    await store.save({
      ...store.read(binding),
      cursor: "tunnel",
      deviceId: "target",
      importDisposition: "skipped",
      history: [
        {
          stage: "application",
          observedAt: "2026-10-26T00:00:00.000Z",
          outcome: "verified",
          commit: "a".repeat(40),
          database: "applied",
          phase: "verify",
        },
      ],
    });
    const reopened = await GuideProgressStore.open(
      join(directory, "progress"),
      scope,
    );
    assert.deepEqual(reopened.read(binding), store.read(binding));
    const changed = reopened.read("b".repeat(64));
    assert.deepEqual(changed.history, []);
    assert.equal(changed.cursor, undefined);
    assert.equal(changed.importDisposition, "skipped");
    assert.equal(changed.deviceId, "target");
    if (process.platform !== "win32") {
      assert.equal((await stat(store.path)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(directory, "progress"))).mode & 0o777,
        0o700,
      );
    }
    const clone = store.read(binding);
    clone.history.length = 0;
    assert.equal(store.read(binding).history.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("scope isolation, strict schemas, corrupt stores and CAS do not overwrite existing progress", async () => {
  const directory = await temporary();
  try {
    const a = await GuideProgressStore.open(directory, scope);
    const b = await GuideProgressStore.open(directory, scope);
    await a.save({ ...a.read(binding), cursor: "auth" });
    await assert.rejects(
      b.save({ ...b.read(binding), cursor: "pages" }),
      /其他进程/,
    );
    const original = await readFile(a.path, "utf8");
    for (const patch of [
      { secret: "sensitive" },
      { scope: { ...scope, root: "/other" } },
      {
        history: [
          {
            stage: "auth",
            observedAt: "2026-10-26T00:00:00.000Z",
            outcome: "verified",
            token: "sensitive",
          },
        ],
      },
      { cursor: "arbitrary" },
    ])
      await assert.rejects(a.save({ ...a.read(binding), ...patch } as never));
    assert.equal(await readFile(a.path, "utf8"), original);
    const isolated = await GuideProgressStore.open(directory, {
      ...scope,
      environment: "production",
    });
    assert.notEqual(isolated.path, a.path);
    assert.deepEqual(isolated.read(binding).history, []);
    await writeFile(a.path, "secret-corrupt-body", { mode: 0o600 });
    await assert.rejects(
      GuideProgressStore.open(directory, scope),
      (error) =>
        error instanceof Error &&
        !error.message.includes("secret-corrupt-body"),
    );
    await assert.rejects(a.save(a.read(binding)), /其他进程/);
    await rm(a.path);
    await symlink(join(directory, "missing"), a.path);
    await assert.rejects(GuideProgressStore.open(directory, scope), /符号链接/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("memory mode does not inspect or touch an existing corrupt private store", async () => {
  const directory = await temporary();
  try {
    const reference = await GuideProgressStore.open(directory, scope);
    await writeFile(reference.path, "invalid-existing-secret", { mode: 0o600 });
    const memory = await GuideProgressStore.open(directory, scope, {
      memory: true,
    });
    await memory.save({ ...memory.read(binding), cursor: "application" });
    assert.equal(memory.read(binding).cursor, "application");
    assert.equal(
      await readFile(reference.path, "utf8"),
      "invalid-existing-secret",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("bounded public summaries reject malformed identities, phases, timestamps and injected output", async () => {
  const directory = await temporary();
  try {
    for (const patch of [
      { root: "relative" },
      { root: "/fixture/../other" },
      { repository: "owner/repo/token" },
      { project: "x\nsecret" },
      { environment: "../production" },
    ])
      await assert.rejects(
        GuideProgressStore.open(directory, { ...scope, ...patch }),
      );
    const store = await GuideProgressStore.open(directory, scope);
    assert.throws(() => store.read("not-a-public-digest"));
    const history = {
      stage: "application" as const,
      observedAt: "2026-10-26T00:00:00.000Z",
      outcome: "cancelled" as const,
    };
    for (const patch of [
      { observedAt: "today" },
      { outcome: "success" },
      { phase: "token-value" },
      { component: "x\nsecret" },
      { commit: "short" },
      { database: "complete" },
      { commandOutput: "sensitive" },
    ])
      await assert.rejects(
        store.save({
          ...store.read(binding),
          history: [{ ...history, ...patch }],
        } as never),
      );
    await assert.rejects(
      store.save({
        ...store.read(binding),
        history: Array.from({ length: 65 }, () => history),
      }),
    );
    await store.save({
      ...store.read(binding),
      cursor: "application",
      history: [history],
    });
    assert.equal(
      (await GuideProgressStore.open(directory, scope)).read(binding).history[0]
        ?.outcome,
      "cancelled",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
