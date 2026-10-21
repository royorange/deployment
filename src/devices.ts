import { isIP } from "node:net";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { missing, noSymlinks, readPrivate, writePrivate } from "./files.ts";
import type { Runner } from "./process.ts";

export type Device = {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
};
const failure = () =>
  new Error(
    "设备档案格式不合法；仅允许名称、主机、用户名和端口，不保存密码或私钥。",
  );
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function hostName(value: string): boolean {
  if (value.includes("%")) return false;
  if (isIP(value)) return true;
  if (/^[\d.]+$/.test(value)) return false;
  return (
    value.length <= 253 &&
    value
      .split(".")
      .every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      )
  );
}
export function validateDevice(value: unknown): Device {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "host,id,label,port,user"
  )
    throw failure();
  const { id, label, host, user, port } = value;
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 100 ||
    /[\x00-\x1f\x7f]/.test(label) ||
    typeof host !== "string" ||
    host.length > 253 ||
    !hostName(host) ||
    typeof user !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(user) ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw failure();
  return { id, label, host, user, port };
}
function parse(contents: string): Device[] {
  if (Buffer.byteLength(contents) > 128_000) throw failure();
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw failure();
  }
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "devices,version" ||
    value.version !== 1 ||
    !Array.isArray(value.devices) ||
    value.devices.length > 128
  )
    throw failure();
  const devices = value.devices.map(validateDevice);
  if (new Set(devices.map((d) => d.id)).size !== devices.length)
    throw failure();
  return devices;
}
async function privateDirectory(path: string): Promise<void> {
  await noSymlinks(path);
  try {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new Error("设备目录须为真实私有目录，请先 chmod 700 后重试。");
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
/** Global connection profiles contain no credentials or project deployment paths. */
export class DeviceStore {
  readonly path: string;
  readonly memory: boolean;
  private previous: string | null = null;
  private devices: Device[] = [];
  readonly directory: string;
  private constructor(directory: string, memory: boolean) {
    this.directory = directory;
    this.path = join(directory, "devices.json");
    this.memory = memory;
  }
  static async open(
    directory: string,
    options: { memory?: boolean } = {},
  ): Promise<DeviceStore> {
    const store = new DeviceStore(resolve(directory), options.memory ?? false);
    if (!store.memory) {
      await privateDirectory(store.directory);
      store.previous = (await readPrivate(store.path)) ?? null;
      if (store.previous !== null) store.devices = parse(store.previous);
    }
    return store;
  }
  list(): Device[] {
    return this.devices.map((device) => ({ ...device }));
  }
  read(id: string): Device | undefined {
    const device = this.devices.find((d) => d.id === id);
    return device ? { ...device } : undefined;
  }
  async save(input: Device): Promise<void> {
    const device = validateDevice(input);
    const devices = this.devices.filter((d) => d.id !== device.id);
    devices.push(device);
    if (devices.length > 128) throw failure();
    await this.persist(devices);
  }
  async remove(id: string): Promise<void> {
    if (!this.read(id)) return;
    await this.persist(this.devices.filter((d) => d.id !== id));
  }
  private async persist(devices: Device[]): Promise<void> {
    const contents = `${JSON.stringify({ version: 1, devices }, null, 2)}\n`;
    if (!this.memory) {
      await privateDirectory(this.directory);
      await writePrivate(this.path, contents, this.previous);
      this.previous = contents;
    }
    this.devices = devices;
  }
}
/** IPv6 is passed as the single user@host argument accepted by OpenSSH. No shell. */
export function sshArguments(input: Device): string[] {
  const device = validateDevice(input);
  return [
    "-p",
    String(device.port),
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
    `${device.user}@${device.host}`,
  ];
}
export function sshCommand(device: Device): string {
  return ["ssh", ...sshArguments(device)].join(" ");
}
export async function checkDevice(
  device: Device,
  runner: Runner,
): Promise<void> {
  try {
    await runner("ssh", [...sshArguments(device), "true"], { timeout: 15_000 });
  } catch {
    throw new Error(
      "SSH 连通性检查失败；请检查地址、SSH agent 或本机配置。首次连接须先在本机正常运行 ssh，核对并确认可信的主机指纹，再回来重试；工具不会自动接受未知指纹或保存密码。",
    );
  }
}
