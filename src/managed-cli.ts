import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { missing, noSymlinks } from "./files.ts";
import { run, type Runner } from "./process.ts";
import { supabaseRelease, type SupabaseRelease } from "./supabase-release.ts";

const MAX_ARCHIVE = 100_000_000;
const MAX_BINARY = 250_000_000;
type UI = {
  confirm(message: string): Promise<boolean>;
  log(message: string): void;
};
type Options = {
  /** Cache root, never a project root. Useful for isolated tests. */
  base?: string;
  runner?: Runner;
  platform?: string;
  arch?: string;
};
export type SupabaseCliInspection = {
  kind: "existing" | "cached" | "install" | "unsupported";
  command?: string;
  version?: string;
  release?: SupabaseRelease;
};
export function compatibleSupabaseVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return (
    !!match &&
    (Number(match[1]) > 2 ||
      (Number(match[1]) === 2 && Number(match[2]) >= 120))
  );
}
function cacheRoot(base?: string): string {
  if (base) return resolve(base);
  const xdg = process.env.XDG_CACHE_HOME;
  const root = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(root, "project-setup", "tools", "supabase");
}
function directory(base: string | undefined, release: SupabaseRelease): string {
  return join(cacheRoot(base), release.version, release.target);
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Extracts only the expected executable; never writes archive paths or invokes tar. */
function executables(
  archive: Buffer,
  release: SupabaseRelease,
): ReadonlyMap<string, Buffer> {
  if (sha256(archive) !== release.sha256)
    throw new Error("Supabase CLI 压缩包 SHA256 校验失败；未执行下载内容。");
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_BINARY });
  } catch {
    throw new Error("Supabase CLI 压缩包无法解压或超过大小限制。");
  }
  const binaries = new Map<string, Buffer>();
  const names = [
    release.binary,
    release.binary.replace("supabase", "supabase-go"),
  ];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0")[0]!;
    const name = text(0, 100),
      prefix = text(345, 155),
      type = text(156, 1);
    const rawSize = text(124, 12).trim(),
      rawChecksum = text(148, 8).trim();
    const size = /^[0-7]+$/.test(rawSize) ? Number.parseInt(rawSize, 8) : NaN;
    const expected = Number.parseInt(rawChecksum, 8);
    const actual = [...header].reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length ||
      expected !== actual ||
      !["", "0", "5"].includes(type) ||
      prefix ||
      !/^[A-Za-z0-9_.-]+$/.test(name) ||
      name === "." ||
      name === ".."
    )
      throw new Error("Supabase CLI 压缩包包含不安全或损坏的条目。");
    if (names.includes(name)) {
      if (binaries.has(name) || type === "5" || size === 0)
        throw new Error("Supabase CLI 压缩包可执行文件不合法。");
      binaries.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (binaries.size !== names.length)
    throw new Error("Supabase CLI 压缩包缺少可执行文件。");
  return binaries;
}
async function readFileSafely(
  path: string,
  maximum: number,
): Promise<Buffer | undefined> {
  await noSymlinks(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maximum ||
      info.nlink !== 1 ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new Error("Supabase CLI 缓存文件类型、所有者或权限不安全。");
    return await handle.readFile();
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function verifiedCache(
  base: string | undefined,
  release: SupabaseRelease,
  location = directory(base, release),
): Promise<string | undefined> {
  const binaryPath = join(location, release.binary);
  for (const path of [
    cacheRoot(base),
    join(cacheRoot(base), release.version),
    location,
  ]) {
    await noSymlinks(path);
    try {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      )
        throw new Error("Supabase CLI 缓存目录所有者或权限不安全。");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const archive = await readFileSafely(
    join(location, "archive.tar.gz"),
    MAX_ARCHIVE,
  );
  const names = [
    release.binary,
    release.binary.replace("supabase", "supabase-go"),
  ];
  const binaries = await Promise.all(
    names.map((name) => readFileSafely(join(location, name), MAX_BINARY)),
  );
  if (!archive && binaries.every((binary) => !binary)) return undefined;
  const expected = archive ? executables(archive, release) : undefined;
  for (let index = 0; index < names.length; index++) {
    const binary = binaries[index],
      expectedBinary = expected?.get(names[index]!);
    if (!binary || !expectedBinary || sha256(expectedBinary) !== sha256(binary))
      throw new Error(
        `Supabase CLI 缓存完整性校验失败：${location}；请检查并移除该缓存后重试。`,
      );
    if (
      process.platform !== "win32" &&
      ((await lstat(join(location, names[index]!))).mode & 0o100) === 0
    )
      throw new Error(
        "Supabase CLI 缓存缺少可执行权限；请检查并移除该缓存后重试。",
      );
  }
  return binaryPath;
}
export async function inspectSupabaseCli(
  options: Options = {},
): Promise<SupabaseCliInspection> {
  try {
    const version = (
      await (options.runner ?? run)("supabase", ["--version"], {
        timeout: 5000,
      })
    ).trim();
    if (compatibleSupabaseVersion(version))
      return { kind: "existing", command: "supabase", version };
  } catch {
    /* Missing or unusable global CLI can be replaced privately. */
  }
  const release = supabaseRelease(options.platform, options.arch);
  if (!release) return { kind: "unsupported" };
  const lockPath = `${directory(options.base, release)}.install.lock`;
  await noSymlinks(lockPath);
  try {
    await lstat(lockPath);
    throw new Error(
      `Supabase CLI 安装中；请稍后重试。若进程异常退出，请确认后手动处理锁：${lockPath}`,
    );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const cached = await verifiedCache(options.base, release);
  return cached
    ? { kind: "cached", command: cached, version: release.version, release }
    : { kind: "install", release };
}
async function privateDirectory(path: string): Promise<void> {
  await noSymlinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await noSymlinks(path);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    (process.platform !== "win32" && info.uid !== process.getuid?.())
  )
    throw new Error("Supabase CLI 缓存目录所有者或类型不安全。");
  await chmod(path, 0o700);
}
async function download(url: string, fetcher: typeof fetch): Promise<Buffer> {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error("http");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_ARCHIVE)
      throw new Error("size");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_ARCHIVE) throw new Error("size");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  } catch {
    throw new Error(
      `Supabase CLI 下载失败：${url}；检查网络后可重试，未执行下载内容。`,
    );
  }
}
async function atomicFile(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  await noSymlinks(path);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await noSymlinks(path);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** Internal installer: release metadata must come from the bundled release table. */
export async function installSupabaseRelease(options: {
  base?: string;
  release: SupabaseRelease;
  fetcher?: typeof fetch;
}): Promise<string> {
  const { release } = options;
  // Never accept executable URLs, install scripts, arbitrary paths or latest tags.
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    !/^(darwin|linux|windows)-(amd64|arm64)$/.test(release.target) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !["supabase", "supabase.exe"].includes(release.binary) ||
    release.url !==
      `https://github.com/supabase/cli/releases/download/v${release.version}/supabase_${release.version}_${release.target.replace("-", "_")}.tar.gz`
  )
    throw new Error("Supabase CLI 固定官方发布信息不合法。");
  const location = directory(options.base, release);
  await privateDirectory(cacheRoot(options.base));
  await privateDirectory(join(cacheRoot(options.base), release.version));
  const lockPath = `${location}.install.lock`;
  await noSymlinks(lockPath);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error(
      `Supabase CLI 正由另一进程安装；请稍后重试。异常退出后请检查锁：${lockPath}`,
    );
  }
  let staging: string | undefined;
  try {
    await lock.writeFile(`pid=${process.pid}\n`);
    const cached = await verifiedCache(options.base, release);
    if (cached) return cached;
    const archive = await download(release.url, options.fetcher ?? fetch);
    const binaries = executables(archive, release);
    staging = await mkdtemp(`${location}.staging-`);
    await privateDirectory(staging);
    await atomicFile(join(staging, "archive.tar.gz"), archive, 0o600);
    for (const [name, binary] of binaries)
      await atomicFile(join(staging, name), binary, 0o700);
    await verifiedCache(options.base, release, staging);
    await noSymlinks(location);
    // A single same-filesystem rename publishes all verified files together.
    await rename(staging, location);
    staging = undefined;
    return join(location, release.binary);
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
export async function ensureSupabaseCli(
  options: Options & { ui: UI; fetcher?: typeof fetch },
): Promise<string | undefined> {
  const state = await inspectSupabaseCli(options);
  if (state.command) return state.command;
  if (!state.release) {
    options.ui.log(
      "当前平台没有经过校验的 Supabase CLI 安装包，请按官方说明安装：https://supabase.com/docs/guides/local-development/cli/getting-started",
    );
    return undefined;
  }
  const release = state.release;
  options.ui.log(
    `需要 Supabase CLI >= 2.120.0。可下载官方固定版本 ${release.version}（${release.target}），SHA256 校验后安装至 ${directory(options.base, release)}。\n来源：${release.url}`,
  );
  if (
    !(await options.ui.confirm(
      "下载并安装工具私有的 Supabase CLI？不修改系统 PATH。",
    ))
  )
    return undefined;
  return installSupabaseRelease({
    base: options.base,
    release,
    fetcher: options.fetcher,
  });
}
