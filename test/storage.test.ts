import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import {
  StateStore,
  legacyVaultProfileKey,
  vaultProfileKey,
} from "../src/state.ts";
import { openStorage } from "../src/storage.ts";
import { Vault } from "../src/vault.ts";
import type { UI } from "../src/wizard.ts";

const config = validateConfig({
  version: 1,
  project: "fixture",
  repository: "fixture/project",
  environments: ["staging", "production"],
  variables: {
    appOrigin: "APP_ORIGIN",
    cloudflareToken: "CF_TOKEN",
    supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
    databaseCredential: "DATABASE_CREDENTIAL",
  },
  extraFields: {
    databaseCredential: {
      label: "Synthetic credential",
      kind: "text",
      secret: true,
    },
  },
});
const root = "/workspace/fixture";
const passphrase = "synthetic test passphrase";
const profile = projectKey(config.project, "staging");

function prompts(answers: string[], confirm = false) {
  const calls: string[] = [];
  const ui: Pick<UI, "input" | "confirm" | "log"> = {
    input: async (message, options) => {
      calls.push(message);
      assert.equal(options?.secret, true);
      const answer = answers.shift();
      assert.notEqual(answer, undefined, "unexpected input prompt");
      return answer!;
    },
    confirm: async (message) => {
      calls.push(message);
      return confirm;
    },
    log: (message) => {
      calls.push(message);
    },
  };
  return { ui, calls };
}

async function temporary(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "setup-storage-")));
}

test("vault storage restores all manually supplied service credentials and secret fields", async () => {
  const base = await temporary();
  try {
    const { ui, calls } = prompts([passphrase, passphrase]);
    const first = await openStorage({ base, root, config, mode: "vault", ui });
    assert.equal(first.mode, "vault");
    const credentials = {
      "cloudflare/manual": "fixture-cloudflare-token",
      "supabase/manual": "fixture-supabase-token",
      "github/manual": "fixture-github-token",
    };
    first.data.credentials = credentials;
    first.data.profiles[profile] = {
      appOrigin: "https://staging.example.test",
      cloudflareToken: "fixture-deployment-token",
      supabasePublishableKey: "sb_publishable_fixture",
      databaseCredential: "fixture-database-credential",
      "@repository": config.repository!,
    };
    first.data.profiles[projectKey(config.project, "production")] = {
      appOrigin: "https://production.example.test",
      databaseCredential: "fixture-production-credential",
    };
    await first.save();
    const expected = structuredClone(first.data);
    first.close();
    const path = join(base, "project-setup", "vault.json");
    const ciphertext = await readFile(path, "utf8");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const state = await StateStore.open(base, root, config);
    const publicState = await readFile(state.path, "utf8");
    for (const secret of [
      ...Object.values(credentials),
      "fixture-deployment-token",
      "sb_publishable_fixture",
      "fixture-database-credential",
      "fixture-production-credential",
      passphrase,
    ]) {
      assert.ok(!ciphertext.includes(secret));
      assert.ok(!publicState.includes(secret));
      assert.ok(!calls.join("\n").includes(secret));
    }
    assert.deepEqual(state.data.credentials, {});
    assert.equal(
      state.data.profiles[profile]?.appOrigin,
      "https://staging.example.test",
    );
    const reopenedPrompts = prompts([passphrase]);
    const reopened = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: reopenedPrompts.ui,
    });
    assert.deepEqual(reopened.data, expected);
    assert.deepEqual(
      reopened.vaultReferences?.[vaultProfileKey(root, config, "staging")],
      expected.profiles[profile],
    );
    assert.equal(
      reopenedPrompts.calls.filter((call) => call.includes("再次输入")).length,
      0,
    );
    reopened.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("new vault is not written before save and mismatched or short passphrases do not create it", async () => {
  for (const answers of [
    [passphrase, "different passphrase"],
    ["short", "short"],
  ]) {
    const base = await temporary();
    try {
      await assert.rejects(
        openStorage({
          base,
          root,
          config,
          mode: "vault",
          ui: prompts(answers).ui,
        }),
        /口令/,
      );
      await assert.rejects(stat(join(base, "project-setup", "vault.json")), {
        code: "ENOENT",
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
  const base = await temporary();
  try {
    const storage = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase, passphrase]).ui,
    });
    await assert.rejects(stat(join(base, "project-setup", "vault.json")), {
      code: "ENOENT",
    });
    storage.close();
    await assert.rejects(storage.save(), /关闭/);
    await assert.rejects(stat(join(base, "project-setup", "vault.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("wrong passphrase or cancelled input preserves existing ciphertext without falling back", async () => {
  const base = await temporary();
  try {
    const first = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase, passphrase]).ui,
    });
    first.data.credentials = { "supabase/manual": "fixture-original-token" };
    await first.save();
    first.close();
    const path = join(base, "project-setup", "vault.json");
    const original = await readFile(path, "utf8");
    await assert.rejects(
      openStorage({
        base,
        root,
        config,
        mode: "vault",
        ui: prompts(["incorrect passphrase"]).ui,
      }),
      /解锁失败/,
    );
    const cancelled = prompts([]).ui;
    cancelled.input = async () => {
      throw new Error("cancelled prompt");
    };
    await assert.rejects(
      openStorage({ base, root, config, mode: "vault", ui: cancelled }),
      /cancelled prompt/,
    );
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("memory mode does not read or write existing state and vault", async () => {
  const base = await temporary();
  try {
    const saved = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase, passphrase]).ui,
    });
    saved.data.profiles[profile] = {
      appOrigin: "https://existing.example.test",
    };
    saved.data.credentials = { "supabase/manual": "fixture-existing-token" };
    await saved.save();
    saved.close();
    const path = join(base, "project-setup", "vault.json");
    const original = await readFile(path, "utf8");
    const memory = await openStorage({
      base,
      root,
      config,
      mode: "memory",
      ui: prompts([]).ui,
    });
    assert.deepEqual(memory.data, { credentials: {}, profiles: {} });
    assert.equal(memory.vaultReferences, undefined);
    memory.data.profiles[profile] = {
      appOrigin: "https://temporary.example.test",
    };
    await memory.save();
    memory.close();
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(
      (await StateStore.open(base, root, config)).data.profiles[profile]
        ?.appOrigin,
      "https://existing.example.test",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("metadata mode persists only public values without opening the vault", async () => {
  const base = await temporary();
  try {
    const metadata = await openStorage({
      base,
      root,
      config,
      mode: "metadata",
      ui: prompts([]).ui,
    });
    metadata.data.credentials = { "github/manual": "fixture-unsaved-token" };
    metadata.data.profiles[profile] = {
      appOrigin: "https://public.example.test",
      databaseCredential: "fixture-unsaved-secret",
    };
    await metadata.save();
    metadata.close();
    const reopened = await openStorage({
      base,
      root,
      config,
      mode: "metadata",
      ui: prompts([]).ui,
    });
    assert.deepEqual(reopened.data, {
      credentials: {},
      profiles: { [profile]: { appOrigin: "https://public.example.test" } },
    });
    assert.equal(reopened.vaultReferences, undefined);
    reopened.close();
    await assert.rejects(stat(join(base, "project-setup", "vault.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("vault profiles retain path, repository and environment isolation while preserving other projects", async () => {
  const base = await temporary();
  try {
    const first = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase, passphrase]).ui,
    });
    first.data.profiles[profile] = {
      databaseCredential: "fixture-first-secret",
    };
    await first.save();
    first.close();
    for (const scope of [
      { root: "/workspace/other", config },
      { root, config: { ...config, repository: "fixture/other" } },
    ]) {
      const other = await openStorage({
        base,
        ...scope,
        mode: "vault",
        ui: prompts([passphrase]).ui,
      });
      assert.equal(other.data.profiles[profile], undefined);
      other.data.profiles[profile] = {
        databaseCredential: "fixture-other-secret",
      };
      await other.save();
      other.close();
    }
    const restored = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase]).ui,
    });
    assert.equal(
      restored.data.profiles[profile]?.databaseCredential,
      "fixture-first-secret",
    );
    assert.equal(
      restored.data.profiles[projectKey(config.project, "production")],
      undefined,
    );
    restored.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("legacy vault profiles require confirmation and preserve the original records", async () => {
  for (const confirmed of [false, true]) {
    const base = await temporary();
    try {
      const path = join(base, "project-setup", "vault.json");
      const legacy = await Vault.open(path, passphrase);
      const legacyKey = legacyVaultProfileKey(root, config, "staging");
      legacy.data.profiles[legacyKey] = {
        databaseCredential: "fixture-legacy-secret",
        "@repository": config.repository!,
      };
      await legacy.save();
      legacy.close();
      const { ui, calls } = prompts([passphrase], confirmed);
      const storage = await openStorage({
        base,
        root,
        config,
        mode: "vault",
        ui,
      });
      assert.equal(
        storage.data.profiles[profile]?.databaseCredential,
        confirmed ? "fixture-legacy-secret" : undefined,
      );
      assert.ok(calls.some((call) => call.includes("确认复制导入")));
      await storage.save();
      storage.close();
      const restored = await Vault.open(path, passphrase);
      assert.equal(
        restored.data.profiles[legacyKey]?.databaseCredential,
        "fixture-legacy-secret",
      );
      restored.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
});

test("repository mismatch prevents legacy import and public values override older encrypted metadata", async () => {
  const base = await temporary();
  try {
    const path = join(base, "project-setup", "vault.json");
    const vault = await Vault.open(path, passphrase);
    vault.data.profiles[legacyVaultProfileKey(root, config, "production")] = {
      "@repository": "wrong/repository",
      databaseCredential: "fixture-wrong-secret",
    };
    vault.data.profiles[vaultProfileKey(root, config, "staging")] = {
      appOrigin: "https://older.example.test",
      databaseCredential: "fixture-kept-secret",
    };
    await vault.save();
    vault.close();
    const state = await StateStore.open(base, root, config);
    await state.save({
      credentials: {},
      profiles: { [profile]: { appOrigin: "https://newer.example.test" } },
    });
    const { ui, calls } = prompts([passphrase], true);
    const storage = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui,
    });
    assert.equal(
      storage.data.profiles[profile]?.appOrigin,
      "https://newer.example.test",
    );
    assert.equal(
      storage.data.profiles[profile]?.databaseCredential,
      "fixture-kept-secret",
    );
    assert.equal(
      storage.data.profiles[projectKey(config.project, "production")],
      undefined,
    );
    assert.ok(!calls.some((call) => call.includes("确认复制导入")));
    storage.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("concurrent storage saves reject stale writes without losing the latest credentials", async () => {
  const base = await temporary();
  try {
    const first = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase, passphrase]).ui,
    });
    await first.save();
    const second = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase]).ui,
    });
    first.data.credentials["supabase/manual"] = "fixture-latest-token";
    await first.save();
    second.data.credentials["supabase/manual"] = "fixture-stale-token";
    await assert.rejects(second.save(), /已被其他进程修改/);
    first.close();
    second.close();
    const restored = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase]).ui,
    });
    assert.equal(
      restored.data.credentials["supabase/manual"],
      "fixture-latest-token",
    );
    restored.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("saving reads replaced credential and profile references after a connection rollback", async () => {
  const base = await temporary();
  try {
    const storage = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase, passphrase]).ui,
    });
    storage.data.credentials["supabase/manual"] = "fixture-original-token";
    storage.data.profiles[profile] = {
      databaseCredential: "fixture-original-secret",
    };
    await storage.save();
    const before = structuredClone(storage.data);
    storage.data.credentials["supabase/manual"] = "fixture-rejected-token";
    storage.data.profiles[profile]!.databaseCredential =
      "fixture-rejected-secret";
    storage.data.credentials = before.credentials;
    storage.data.profiles = before.profiles;
    await storage.save();
    storage.close();
    const reopened = await openStorage({
      base,
      root,
      config,
      mode: "vault",
      ui: prompts([passphrase]).ui,
    });
    assert.deepEqual(reopened.data, before);
    reopened.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
