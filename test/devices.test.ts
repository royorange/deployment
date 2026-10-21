import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  realpath,
  readFile,
  stat,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceStore,
  validateDevice,
  sshArguments,
  sshCommand,
  checkDevice,
} from "../src/devices.ts";
const device = {
  id: "staging",
  label: "测试主机",
  host: "192.0.2.10",
  user: "deploy",
  port: 22,
};
test("device validation restricts hosts, usernames, fields and connection arguments", () => {
  for (const host of [
    "192.0.2.10",
    "2001:db8::1",
    "ssh.example.com",
    "local-alias",
  ])
    assert.equal(validateDevice({ ...device, host }).host, host);
  for (const host of [
    "-proxy",
    "x;whoami",
    "user@host",
    "https://host",
    "x\ny",
    "256.1.1.1",
    "a..b",
    "[::1]",
    "fe80::1%en0",
  ])
    assert.throws(() => validateDevice({ ...device, host }));
  for (const user of ["-x", "a b", "root:password", "x;true", "a@b"])
    assert.throws(() => validateDevice({ ...device, user }));
  for (const port of [0, 65536, 22.5, "22"])
    assert.throws(() => validateDevice({ ...device, port }));
  assert.throws(() => validateDevice({ ...device, password: "secret" }));
  assert.throws(() => validateDevice({ ...device, id: "../x" }));
  assert.deepEqual(sshArguments(device), [
    "-p",
    "22",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "RequestTTY=no",
    "-T",
    "deploy@192.0.2.10",
  ]);
  assert.ok(
    sshCommand({ ...device, host: "2001:db8::1" }).includes(
      "deploy@2001:db8::1",
    ),
  );
});
test("private device store survives restart and detects stale writers without overwriting", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "setup-devices-"));
  try {
    const a = await DeviceStore.open(join(dir, "devices"));
    const b = await DeviceStore.open(join(dir, "devices"));
    await a.save(device);
    await assert.rejects(b.save({ ...device, label: "stale" }), /其他进程/);
    const c = await DeviceStore.open(join(dir, "devices"));
    assert.deepEqual(c.list(), [device]);
    const clone = c.read(device.id)!;
    clone.label = "mutated";
    assert.equal(c.read(device.id)?.label, device.label);
    if (process.platform !== "win32") {
      assert.equal((await stat(c.path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(dir, "devices"))).mode & 0o777, 0o700);
    }
    await c.save({ ...device, port: 2222 });
    assert.equal(c.read(device.id)?.port, 2222);
    await c.remove(device.id);
    assert.deepEqual(c.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("memory mode never reads/writes disk, malformed and symlink stores are refused", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "setup-devices-"));
  try {
    await writeFile(join(dir, "devices.json"), "private-corrupt-value", {
      mode: 0o600,
    });
    const memory = await DeviceStore.open(dir, { memory: true });
    await memory.save(device);
    await memory.remove(device.id);
    assert.equal(
      await readFile(join(dir, "devices.json"), "utf8"),
      "private-corrupt-value",
    );
    await assert.rejects(
      DeviceStore.open(dir),
      (e) => e instanceof Error && !e.message.includes("private-corrupt-value"),
    );
    await rm(join(dir, "devices.json"));
    await symlink(join(dir, "elsewhere"), join(dir, "devices.json"));
    await assert.rejects(DeviceStore.open(dir), /符号链接/);
    await rm(join(dir, "devices.json"));
    await writeFile(
      join(dir, "devices.json"),
      JSON.stringify({ version: 1, devices: [{ ...device, token: "x" }] }),
      { mode: 0o600 },
    );
    await assert.rejects(DeviceStore.open(dir), /设备档案/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("SSH check only executes fixed read-only command and suppresses untrusted failures", async () => {
  let calls = 0;
  await checkDevice(device, async (command, args, options) => {
    calls++;
    assert.equal(command, "ssh");
    assert.deepEqual(args, [...sshArguments(device), "true"]);
    assert.equal(options?.timeout, 15000);
    return "";
  });
  assert.equal(calls, 1);
  await assert.rejects(
    checkDevice(device, async () => {
      throw new Error("password=private");
    }),
    (e) =>
      e instanceof Error &&
      e.message.includes("主机指纹") &&
      !e.message.includes("password"),
  );
});
test("device files reject unknown schemas, duplicates, excessive rows, and broad permissions", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "setup-devices-"));
  try {
    const path = join(dir, "devices.json");
    for (const payload of [
      { version: 2, devices: [] },
      { version: 1, devices: [], token: "private" },
      { version: 1, devices: [device, device] },
      {
        version: 1,
        devices: Array.from({ length: 129 }, (_, i) => ({
          ...device,
          id: `d${i}`,
        })),
      },
    ]) {
      await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
      await assert.rejects(DeviceStore.open(dir), /设备档案/);
    }
    await writeFile(path, JSON.stringify({ version: 1, devices: [] }));
    const store = await DeviceStore.open(dir);
    assert.equal(store.read("missing"), undefined);
    await store.remove("missing");
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises");
      await chmod(path, 0o644);
      await assert.rejects(DeviceStore.open(dir), /权限/);
      await chmod(path, 0o600);
      await chmod(dir, 0o755);
      await assert.rejects(DeviceStore.open(dir), /私有目录/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("store caps total profiles and preserves previous state on refusal", async () => {
  const store = await DeviceStore.open("/not-read", { memory: true });
  for (let i = 0; i < 128; i++)
    await store.save({ ...device, id: `device${i}` });
  await assert.rejects(store.save({ ...device, id: "overflow" }), /设备档案/);
  assert.equal(store.list().length, 128);
  await store.save({ ...device, id: "device0", label: "updated" });
  assert.equal(store.read("device0")?.label, "updated");
});
