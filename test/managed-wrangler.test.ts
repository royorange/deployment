import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WRANGLER_VERSION,
  ensureWrangler,
  installManagedWrangler,
  managedWranglerScript,
  manualWranglerInstall,
  resolveWrangler,
  wranglerCacheDirectory,
} from "../src/managed-wrangler.ts";
import { CommandUnavailableError, type Runner } from "../src/process.ts";

const bundled = fileURLToPath(new URL("../tools/wrangler/", import.meta.url));

async function sandbox(t: TestContext) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "setup-wrangler-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "project");
  await mkdir(root);
  return { temp, root, base: join(temp, "cache") };
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function touch(path: string, contents = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
/** Simulates `npm ci` writing the locked wrangler package into the staging directory. */
function fakeInstaller(options: { version?: string; fail?: boolean } = {}) {
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  const runner: Runner = async (command, args, settings) => {
    calls.push({ command, args, cwd: settings?.cwd });
    if (command === "npm") {
      if (options.fail) throw new Error("npm network failure");
      const cwd = settings!.cwd!;
      assert.deepEqual(
        JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8")),
        JSON.parse(await readFile(join(bundled, "package-lock.json"), "utf8")),
      );
      await touch(join(cwd, "node_modules/wrangler/bin/wrangler.js"));
      return "added 36 packages";
    }
    if (command === process.execPath) {
      await access(args[0]!);
      return ` ⛅️ wrangler ${options.version ?? WRANGLER_VERSION}`;
    }
    throw new CommandUnavailableError(command);
  };
  return { runner, calls };
}

test("bundled lockfile pins the managed Wrangler version with registry integrity for every package", async () => {
  const manifest = JSON.parse(
    await readFile(join(bundled, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(join(bundled, "package-lock.json"), "utf8"),
  );
  assert.deepEqual(manifest.dependencies, { wrangler: WRANGLER_VERSION });
  assert.equal(
    lock.packages["node_modules/wrangler"].version,
    WRANGLER_VERSION,
  );
  const entries = Object.entries(lock.packages).filter(([key]) => key !== "");
  assert.ok(entries.length > 1);
  for (const [key, entry] of entries as [
    string,
    { integrity?: string; resolved?: string },
  ][]) {
    assert.match(entry.integrity ?? "", /^sha512-/, key);
    assert.match(
      entry.resolved ?? "",
      /^https:\/\/registry\.npmjs\.org\//,
      key,
    );
  }
});

test("project dependencies win over the managed cache, which wins over the global command", async (t) => {
  const { root, base } = await sandbox(t);
  assert.deepEqual(await resolveWrangler(root, root, base), {
    source: "global",
    command: "wrangler",
    prefix: [],
  });
  await touch(managedWranglerScript(base));
  assert.deepEqual(await resolveWrangler(root, root, base), {
    source: "managed",
    command: process.execPath,
    prefix: [managedWranglerScript(base)],
    location: wranglerCacheDirectory(base),
  });
  const project = join(root, "apps/edge/node_modules/wrangler/bin/wrangler.js");
  await touch(project);
  assert.deepEqual(await resolveWrangler(root, root, base), {
    source: "project",
    command: process.execPath,
    prefix: [project],
    location: join(root, "apps/edge"),
  });
});

test("an available Wrangler is used without prompting or installing", async (t) => {
  const { root, base } = await sandbox(t);
  await touch(join(root, "node_modules/wrangler/bin/wrangler.js"));
  const { runner, calls } = fakeInstaller();
  const ui = {
    log: () => {},
    confirm: async () => assert.fail("unexpected prompt"),
  };
  assert.equal(await ensureWrangler({ root, base, runner, ui }), true);
  assert.ok(calls.every((call) => call.command !== "npm"));
});

test("declining the install explains the manual command and never runs npm", async (t) => {
  const { root, base } = await sandbox(t);
  const { runner, calls } = fakeInstaller();
  const logs: string[] = [];
  const prompts: string[] = [];
  const ui = {
    log: (message: string) => logs.push(message),
    confirm: async (message: string) => {
      prompts.push(message);
      return false;
    },
  };
  assert.equal(await ensureWrangler({ root, base, runner, ui }), false);
  assert.ok(calls.every((call) => call.command !== "npm"));
  const text = logs.join("\n");
  assert.match(
    text,
    new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(text, new RegExp(WRANGLER_VERSION.replaceAll(".", "\\.")));
  assert.ok(text.includes(manualWranglerInstall));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /不修改系统 PATH/);
  assert.equal(await exists(wranglerCacheDirectory(base)), false);
});

test("confirmed install runs locked npm ci without scripts and publishes a verified cache", async (t) => {
  const { root, base } = await sandbox(t);
  const { runner, calls } = fakeInstaller();
  const ui = { log: () => {}, confirm: async () => true };
  assert.equal(await ensureWrangler({ root, base, runner, ui }), true);
  const npm = calls.find((call) => call.command === "npm")!;
  assert.deepEqual(npm.args, [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  assert.notEqual(npm.cwd, wranglerCacheDirectory(base));
  assert.ok(npm.cwd!.startsWith(`${wranglerCacheDirectory(base)}.staging-`));
  assert.equal(await exists(npm.cwd!), false);
  assert.equal((await resolveWrangler(root, root, base)).source, "managed");
  const leftovers = await readdir(dirname(wranglerCacheDirectory(base)));
  assert.deepEqual(leftovers, [basename(wranglerCacheDirectory(base))]);
});

test("install failures leave no partial cache and point to the manual command", async (t) => {
  const { root, base } = await sandbox(t);
  const { runner } = fakeInstaller({ fail: true });
  const logs: string[] = [];
  const ui = {
    log: (message: string) => logs.push(message),
    confirm: async () => true,
  };
  assert.equal(await ensureWrangler({ root, base, runner, ui }), false);
  assert.ok(logs.join("\n").includes(manualWranglerInstall));
  assert.deepEqual(await readdir(dirname(wranglerCacheDirectory(base))), []);
});

test("an installed package reporting another version is rejected before publication", async (t) => {
  const { base } = await sandbox(t);
  const { runner } = fakeInstaller({ version: "4.0.0" });
  await assert.rejects(
    installManagedWrangler({ base, runner }),
    /版本校验失败/,
  );
  assert.deepEqual(await readdir(dirname(wranglerCacheDirectory(base))), []);
});

test("a tampered bundled lockfile is refused before npm runs", async (t) => {
  const { temp, base } = await sandbox(t);
  const lockDirectory = join(temp, "tampered");
  const lock = JSON.parse(
    await readFile(join(bundled, "package-lock.json"), "utf8"),
  );
  delete lock.packages["node_modules/wrangler"].integrity;
  await touch(
    join(lockDirectory, "package.json"),
    await readFile(join(bundled, "package.json"), "utf8"),
  );
  await touch(join(lockDirectory, "package-lock.json"), JSON.stringify(lock));
  const { runner, calls } = fakeInstaller();
  await assert.rejects(
    installManagedWrangler({ base, runner, lockDirectory }),
    /锁文件/,
  );
  assert.equal(calls.length, 0);
});

test("a concurrent install lock is reported instead of being removed", async (t) => {
  const { base } = await sandbox(t);
  const lockPath = `${wranglerCacheDirectory(base)}.install.lock`;
  await touch(lockPath, "pid=1\n");
  const { runner, calls } = fakeInstaller();
  await assert.rejects(installManagedWrangler({ base, runner }), /另一进程/);
  assert.equal(calls.length, 0);
  assert.equal(await exists(lockPath), true);
});

test("an existing cache that no longer runs is reported for manual cleanup, not overwritten", async (t) => {
  const { base } = await sandbox(t);
  await touch(join(wranglerCacheDirectory(base), "package.json"), "{}");
  const { runner, calls } = fakeInstaller();
  await assert.rejects(installManagedWrangler({ base, runner }), /移除该缓存/);
  assert.ok(calls.every((call) => call.command !== "npm"));
});

test("the cache is separated by platform and architecture", async (t) => {
  const { base } = await sandbox(t);
  assert.equal(
    wranglerCacheDirectory(base),
    join(base, WRANGLER_VERSION, `${process.platform}-${process.arch}`),
  );
});

test("a lock left by an exited installer is reclaimed together with its staging directory", async (t) => {
  const { root, base } = await sandbox(t);
  const location = wranglerCacheDirectory(base);
  await touch(`${location}.install.lock`, "pid=99999999\n");
  await touch(join(`${location}.staging-abc123`, "node_modules/partial.js"));
  const { runner } = fakeInstaller();
  await installManagedWrangler({ base, runner });
  assert.equal((await resolveWrangler(root, root, base)).source, "managed");
  assert.deepEqual(await readdir(dirname(location)), [basename(location)]);
});

test("a lock held by a running installer is kept", async (t) => {
  const { base } = await sandbox(t);
  const lockPath = `${wranglerCacheDirectory(base)}.install.lock`;
  await touch(lockPath, `pid=${process.pid}\n`);
  const { runner } = fakeInstaller();
  await assert.rejects(installManagedWrangler({ base, runner }), /另一进程/);
  assert.equal(await exists(lockPath), true);
});

test("a managed cache writable by others or replaced by a symlink is refused before running", async (t) => {
  const { temp, root, base } = await sandbox(t);
  const location = wranglerCacheDirectory(base);
  await touch(join(location, "node_modules/wrangler/bin/wrangler.js"));
  await chmod(location, 0o777);
  await assert.rejects(resolveWrangler(root, root, base), /不安全/);
  await rm(location, { recursive: true });
  const elsewhere = join(temp, "elsewhere");
  await touch(join(elsewhere, "node_modules/wrangler/bin/wrangler.js"));
  await symlink(elsewhere, location);
  await assert.rejects(resolveWrangler(root, root, base), /符号链接/);
});

test("a broken project Wrangler asks to repair dependencies instead of installing a copy it would shadow", async (t) => {
  const { root, base } = await sandbox(t);
  await touch(join(root, "node_modules/wrangler/bin/wrangler.js"));
  const logs: string[] = [];
  const ui = {
    log: (message: string) => logs.push(message),
    confirm: async () => assert.fail("unexpected install prompt"),
  };
  const broken: Runner = async () => {
    throw new Error("wrangler crashed");
  };
  assert.equal(await ensureWrangler({ root, base, runner: broken, ui }), false);
  assert.match(logs.join("\n"), /项目依赖中的 Wrangler 无法运行/);
  assert.ok(logs.join("\n").includes(root));
});

test("a missing npm is reported as such", async (t) => {
  const { base } = await sandbox(t);
  const runner: Runner = async (command) => {
    throw new CommandUnavailableError(command);
  };
  await assert.rejects(installManagedWrangler({ base, runner }), /未找到 npm/);
});
