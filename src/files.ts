import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function noSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("拒绝读写符号链接，请选择真实路径。");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

export async function readPrivate(path: string): Promise<string | undefined> {
  await noSymlinks(path);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 2_000_000)
      throw new Error("配置文件类型或大小不合法。");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      throw new Error("文件权限过宽；请先 chmod 600 后重试。");
    return await file.readFile("utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

// Compare under a cooperative lock; atomic rename prevents partial ciphertext/env files.
export async function writePrivate(
  path: string,
  contents: string,
  expected?: string | null,
): Promise<void> {
  if (Buffer.byteLength(contents, "utf8") > 2_000_000)
    throw new Error("配置文件大小超过 2 MB 限制；未修改原文件。");
  await noSymlinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error(
      "文件正被另一进程使用；若上次进程异常退出，请确认后移除对应 .lock 文件。",
    );
  }
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const previous = await readPrivate(path);
    if (expected !== undefined && (previous ?? null) !== expected)
      throw new Error("配置已被其他进程修改，请重新打开后重试。");
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export function variableName(name: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name))
    throw new Error("环境变量名不合法。");
}
export function singleLine(value: string): void {
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error("配置值不能包含换行或控制字符。");
  if (value.length > 16_000) throw new Error("配置值过长。");
}

// A deliberately narrow dotenv subset. No eval, command expansion, interpolation or multiline values.
export function parseEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(
      line.trim(),
    );
    if (!match) throw new Error("无法安全解析 .env；仅支持单行 KEY=value。");
    const name = match[1]!;
    if (Object.hasOwn(result, name))
      throw new Error(`.env 中有重复变量：${name}`);
    let value = match[2]!;
    if (value.startsWith("'") || value.startsWith('"')) {
      const quote = value[0]!;
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
        throw new Error("不支持的 .env 引号或多行格式。");
      value = value.slice(1, end);
      if (quote === '"' && value.includes("\\"))
        throw new Error("请使用不含转义的单行 .env 值。");
    } else value = value.replace(/\s+#.*$|#.*$/, "").trim();
    singleLine(value);
    result[name] = value;
  }
  return result;
}

export function mergeEnv(
  previous: string,
  values: Record<string, string>,
): string {
  parseEnv(previous);
  for (const [key, value] of Object.entries(values)) {
    variableName(key);
    singleLine(value);
    if (value.includes("'"))
      throw new Error(".env 导出不支持单引号值；请使用 GitHub 或 JSON 导出。");
  }
  const remaining = { ...values };
  const lines = previous
    .replace(/\n$/, "")
    .split(/\r?\n/)
    .map((line) => {
      const name = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(
        line.trim(),
      )?.[1];
      if (!name || !Object.hasOwn(remaining, name)) return line;
      const replacement = `${name}='${remaining[name]}'`;
      delete remaining[name];
      return replacement;
    });
  lines.push(
    ...Object.entries(remaining).map(([key, value]) => `${key}='${value}'`),
  );
  return `${lines.filter((line, index) => index !== 0 || line !== "").join("\n")}\n`;
}

export async function readJson(path: string): Promise<unknown> {
  await noSymlinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 200_000)
    throw new Error("项目配置文件类型或大小不合法。");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("项目配置不是有效 JSON。");
  }
}
