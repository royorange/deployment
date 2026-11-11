import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { writePrivate } from "../src/files.ts";
import {
  legacyVaultProfileKey,
  StateStore,
  vaultProfileKey,
} from "../src/state.ts";

const config = validateConfig({
  version: 1,
  project: "fixture",
  repository: "fixture/project",
  environments: ["staging"],
  variables: { appOrigin: "APP_ORIGIN", cloudflareToken: "CF_TOKEN" },
});
const profile = projectKey(config.project, "staging");

function legacyPath(base: string, root: string): string {
  const scope = JSON.stringify([
    config.project,
    config.repository ?? resolve(root),
  ]);
  const hash = createHash("sha256").update(scope).digest("hex");
  return join(base, "project-setup", "state", `${hash}.json`);
}

async function legacy(base: string, root: string): Promise<string> {
  const path = legacyPath(base, root);
  const contents = JSON.stringify({
    version: 1,
    scope: JSON.stringify([config.project, config.repository ?? resolve(root)]),
    profiles: {
      [profile]: {
        appOrigin: "https://legacy.example.test",
        cloudflareToken: "fixture-sensitive-token",
        "@repository": config.repository,
      },
    },
  });
  await writePrivate(path, contents, null);
  return contents;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

test("same repository checkouts isolate public state and vault profiles", async () => {
  const base = await temporaryDirectory("setup-state-paths-");
  try {
    const first = await StateStore.open(base, "/workspace/first", config);
    await first.save({
      credentials: {},
      profiles: { [profile]: { appOrigin: "https://first.example.test" } },
    });
    const second = await StateStore.open(base, "/workspace/second", config);
    assert.notEqual(first.path, second.path);
    assert.deepEqual(second.data.profiles, {});
    assert.notEqual(
      vaultProfileKey("/workspace/first", config, "staging"),
      vaultProfileKey("/workspace/second", config, "staging"),
    );
    assert.equal(
      vaultProfileKey("/workspace/first/../first", config, "staging"),
      vaultProfileKey("/workspace/first", config, "staging"),
    );
    assert.equal(
      legacyVaultProfileKey("/workspace/first", config, "staging"),
      JSON.stringify([config.project, config.repository, "staging"]),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("confirmed legacy state is copied once with secret filtering and the original intact", async () => {
  const base = await temporaryDirectory("setup-state-legacy-");
  const root = "/workspace/first";
  try {
    const original = await legacy(base, root);
    let prompts = 0;
    const store = await StateStore.open(base, root, config, async (message) => {
      prompts++;
      assert.ok(message.includes(config.repository!));
      return true;
    });
    assert.equal(prompts, 1);
    assert.equal(
      store.data.profiles[profile]?.appOrigin,
      "https://legacy.example.test",
    );
    assert.equal(store.data.profiles[profile]?.cloudflareToken, undefined);
    assert.notEqual(store.path, legacyPath(base, root));
    assert.equal(await readFile(legacyPath(base, root), "utf8"), original);
    assert.ok(
      !(await readFile(store.path, "utf8")).includes("fixture-sensitive-token"),
    );
    const reopened = await StateStore.open(base, root, config, async () => {
      throw new Error("confirmed migration must not ask again");
    });
    assert.equal(
      reopened.data.profiles[profile]?.appOrigin,
      "https://legacy.example.test",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("declined or unattended legacy imports save an empty isolated state and do not ask repeatedly", async () => {
  for (const confirmLegacy of [undefined, async () => false]) {
    const base = await temporaryDirectory("setup-state-decline-");
    const root = "/workspace/first";
    try {
      const original = await legacy(base, root);
      const store = await StateStore.open(base, root, config, confirmLegacy);
      assert.deepEqual(store.data.profiles, {});
      assert.deepEqual(
        JSON.parse(await readFile(store.path, "utf8")).profiles,
        {},
      );
      await StateStore.open(base, root, config, async () => {
        throw new Error("declined migration must not ask again");
      });
      assert.equal(await readFile(legacyPath(base, root), "utf8"), original);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
});

test("legacy corruption or scope mismatch fails before asking or creating a new state", async () => {
  const invalid = [
    "not JSON",
    JSON.stringify({ version: 1, scope: "wrong", profiles: {} }),
    JSON.stringify({
      version: 1,
      scope: JSON.stringify([config.project, config.repository]),
      profiles: { [profile]: { appOrigin: "http://unsafe.example.test" } },
    }),
  ];
  for (const contents of invalid) {
    const base = await temporaryDirectory("setup-state-corrupt-");
    const root = "/workspace/first";
    try {
      await writePrivate(legacyPath(base, root), contents, null);
      let asked = false;
      await assert.rejects(
        StateStore.open(base, root, config, async () => {
          asked = true;
          return true;
        }),
      );
      assert.equal(asked, false);
      assert.equal(await readFile(legacyPath(base, root), "utf8"), contents);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
});
