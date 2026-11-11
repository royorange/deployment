import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmod,
  mkdtemp,
  readFile,
  stat,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.ts";
import { mergeEnv, parseEnv, writePrivate } from "../src/files.ts";
import { projectKey, validateConfig, exportEntries } from "../src/config.ts";

test("vault encrypts secrets, authenticates, isolates projects and refuses stale writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "setup-test-"));
  try {
    const path = join(dir, "vault.json");
    const first = await Vault.open(path, "a long test passphrase");
    first.data.credentials["cloudflare/work"] = "fixture-sensitive-token";
    first.data.profiles[projectKey("fulcord", "staging")] = {
      appOrigin: "https://a.example",
    };
    first.data.profiles[projectKey("zoncord", "staging")] = {
      appOrigin: "https://b.example",
    };
    await first.save();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(
      !(await readFile(path, "utf8")).includes("fixture-sensitive-token"),
    );
    await assert.rejects(Vault.open(path, "wrong passphrase"), /解锁失败/);
    const second = await Vault.open(path, "a long test passphrase");
    assert.equal(
      second.data.profiles[projectKey("zoncord", "staging")]?.appOrigin,
      "https://b.example",
    );
    await first.save();
    await assert.rejects(second.save(), /已被其他进程修改/);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.tag = Buffer.alloc(16).toString("base64");
    await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
    await assert.rejects(
      Vault.open(path, "a long test passphrase"),
      /解锁失败/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("private writes reject symlinks and unsafe permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "setup-test-"));
  try {
    const target = join(dir, "target");
    await writeFile(target, "original", { mode: 0o600 });
    await symlink(target, join(dir, "link"));
    await assert.rejects(writePrivate(join(dir, "link"), "secret"), /符号链接/);
    assert.equal(await readFile(target, "utf8"), "original");
    await writeFile(join(dir, "public"), "original", { mode: 0o644 });
    await chmod(join(dir, "public"), 0o644);
    await assert.rejects(writePrivate(join(dir, "public"), "secret"), /权限/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized private writes cannot replace a file with contents that the next read would reject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "setup-test-"));
  try {
    const path = join(dir, "vault.json");
    await writePrivate(path, "original");
    await assert.rejects(writePrivate(path, "中".repeat(700_000)), /大小/);
    assert.equal(await readFile(path, "utf8"), "original");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env merge preserves unrelated data, quotes hash/dollar, rejects injection and duplicate keys", () => {
  const merged = mergeEnv('# keep\nOTHER="untouched"\nSUPABASE_URL=old\n', {
    SUPABASE_URL: "https://abc.supabase.co",
    API_KEY: "a#$`b",
  });
  assert.match(merged, /# keep/);
  assert.deepEqual(parseEnv(merged), {
    OTHER: "untouched",
    SUPABASE_URL: "https://abc.supabase.co",
    API_KEY: "a#$`b",
  });
  assert.throws(() => mergeEnv("", { KEY: "x\nINJECTED=1" }), /换行/);
  assert.throws(() => parseEnv("KEY=a\nKEY=b"), /重复/);
  assert.throws(() => mergeEnv("", { "BAD-NAME": "x" }), /变量名/);
});

test("manifest rejects unsafe mappings; admin credentials cannot become frontend variables", () => {
  const config = validateConfig({
    version: 1,
    project: "zoncord",
    repository: "royorange/zoncord",
    environments: ["staging", "production"],
    variables: { appOrigin: "APP_ORIGIN", supabaseUrl: "SUPABASE_URL" },
  });
  assert.deepEqual(
    exportEntries(config, {
      appOrigin: "https://app.example",
      supabaseUrl: "https://abc.supabase.co",
      supabaseToken: "admin",
    }),
    [
      {
        field: "appOrigin",
        name: "APP_ORIGIN",
        value: "https://app.example",
        secret: false,
      },
      {
        field: "supabaseUrl",
        name: "SUPABASE_URL",
        value: "https://abc.supabase.co",
        secret: false,
      },
    ],
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        variables: { supabaseToken: "NEXT_PUBLIC_TOKEN" },
      }),
    /字段/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        variables: { cloudflareToken: "NEXT_PUBLIC_TOKEN" },
      }),
    /公开前缀/,
  );
  assert.throws(
    () => validateConfig({ ...config, repository: "--repo=evil" }),
    /仓库/,
  );
  assert.notEqual(projectKey("ab", "c"), projectKey("a", "bc"));
});
