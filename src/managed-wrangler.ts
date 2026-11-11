import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noSymlinks } from "./files.ts";
import { CommandUnavailableError, run, type Runner } from "./process.ts";

/** Must match tools/wrangler/package-lock.json; the lock pins every transitive package. */
export const WRANGLER_VERSION = "4.149.0";
export const manualWranglerInstall = `npm install -g wrangler@${WRANGLER_VERSION}`;
const BUNDLED_LOCK = fileURLToPath(
  new URL("../tools/wrangler/", import.meta.url),
);
const MANIFESTS = ["package.json", "package-lock.json"] as const;
const SCRIPT = "node_modules/wrangler/bin/wrangler.js";
const PROJECT_WORKSPACES = ["", "apps/web", "apps/edge"];
const NPM_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
const INSTALL_TIMEOUT = 600_000;
const VERSION_TIMEOUT = 30_000;
const REGISTRY = "https://registry.npmjs.org/";

type UI = {
  confirm(message: string): Promise<boolean>;
  log(message: string): void;
};
export type WranglerCommand = {
  source: "project" | "managed" | "global";
  command: string;
  /** Arguments placed before the Wrangler arguments (the script path for Node launches). */
  prefix: string[];
  location?: string;
};

/** Private cache, never a project root. Native workerd/esbuild binaries make it per platform. */
export function wranglerCacheDirectory(base?: string): string {
  const target = `${process.platform}-${process.arch}`;
  if (base) return join(resolve(base), WRANGLER_VERSION, target);
  const xdg = process.env.XDG_CACHE_HOME;
  const root = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(
    root,
    "project-setup",
    "tools",
    "wrangler",
    WRANGLER_VERSION,
    target,
  );
}
export function managedWranglerScript(base?: string): string {
  return join(wranglerCacheDirectory(base), SCRIPT);
}
async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Target project → launcher project → setup cache → PATH. */
export async function resolveWrangler(
  root: string,
  launchRoot = process.cwd(),
  base?: string,
): Promise<WranglerCommand> {
  // Selecting another project must not hide the launcher's installed CLI.
  for (const directory of new Set([root, launchRoot]))
    for (const workspace of PROJECT_WORKSPACES) {
      const location = join(directory, workspace);
      const script = join(location, SCRIPT);
      if (await present(script))
        return {
          source: "project",
          command: process.execPath,
          prefix: [script],
          location,
        };
    }
  const managed = managedWranglerScript(base);
  if (await present(managed)) {
    await trustedCache(wranglerCacheDirectory(base), managed);
    return {
      source: "managed",
      command: process.execPath,
      prefix: [managed],
      location: wranglerCacheDirectory(base),
    };
  }
  return { source: "global", command: "wrangler", prefix: [] };
}
/** The cached script runs while an OAuth token is in use, so only a private cache is trusted. */
async function trustedCache(location: string, script: string): Promise<void> {
  await noSymlinks(script);
  for (const path of [dirname(location), location]) {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0))
    )
      throw new Error(
        `Wrangler 私有缓存所有者或权限不安全：${path}；请检查并移除后重试，未执行缓存内容。`,
      );
  }
}

/** Reads the manifests once; the verified text is what gets installed. */
async function verifiedLock(
  lockDirectory: string,
): Promise<Record<(typeof MANIFESTS)[number], string>> {
  const invalid = new Error("Wrangler 固定版本锁文件不合法；未运行 npm。");
  let texts, manifest, lock;
  try {
    const [manifestText, lockText] = await Promise.all(
      MANIFESTS.map((name) => readFile(join(lockDirectory, name), "utf8")),
    );
    texts = { "package.json": manifestText!, "package-lock.json": lockText! };
    manifest = JSON.parse(manifestText!);
    lock = JSON.parse(lockText!);
  } catch {
    throw invalid;
  }
  const packages = lock?.packages;
  const entries =
    packages && typeof packages === "object" ? Object.entries(packages) : [];
  const pinned =
    manifest?.dependencies?.wrangler === WRANGLER_VERSION &&
    Object.keys(manifest.dependencies).length === 1 &&
    packages?.["node_modules/wrangler"]?.version === WRANGLER_VERSION;
  const verified = entries.every(([key, value]) => {
    if (key === "") return true;
    const entry = value as { integrity?: unknown; resolved?: unknown };
    return (
      typeof entry.integrity === "string" &&
      entry.integrity.startsWith("sha512-") &&
      typeof entry.resolved === "string" &&
      entry.resolved.startsWith(REGISTRY)
    );
  });
  if (!pinned || !verified || entries.length < 2) throw invalid;
  return texts;
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
    throw new Error("Wrangler 缓存目录所有者或类型不安全。");
  await chmod(path, 0o700);
}
async function runsPinnedVersion(
  runner: Runner,
  location: string,
): Promise<boolean> {
  try {
    const output = await runner(
      process.execPath,
      [join(location, SCRIPT), "--version"],
      {
        cwd: location,
        timeout: VERSION_TIMEOUT,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    return new RegExp(`\\b${WRANGLER_VERSION.replaceAll(".", "\\.")}\\b`).test(
      output,
    );
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Reclaims a lock only when its recorded installer has exited (e.g. after Ctrl-C). */
async function acquireLock(lockPath: string) {
  await noSymlinks(lockPath);
  const busy = new Error(
    `Wrangler 正由另一进程安装；请稍后重试。若确认没有安装在运行，可删除锁：${lockPath}`,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const recorded = /^pid=(\d+)\n?$/.exec(
      await readFile(lockPath, "utf8").catch(() => ""),
    );
    const pid = recorded ? Number(recorded[1]) : NaN;
    if (attempt > 0 || !Number.isSafeInteger(pid) || pid <= 0 || alive(pid))
      throw busy;
    await rm(lockPath, { force: true });
  }
  throw busy;
}
/** Runs while holding the lock, so any staging directory belongs to an exited installer. */
async function removeAbandonedStaging(location: string): Promise<void> {
  const prefix = `${basename(location)}.staging-`;
  for (const name of await readdir(dirname(location)))
    if (name.startsWith(prefix))
      await rm(join(dirname(location), name), { recursive: true, force: true });
}

/** Installs the bundled lockfile with `npm ci`; integrity is enforced by npm per package. */
export async function installManagedWrangler(options: {
  base?: string;
  runner?: Runner;
  lockDirectory?: string;
}): Promise<string> {
  const runner = options.runner ?? run;
  const lockDirectory = options.lockDirectory ?? BUNDLED_LOCK;
  const manifests = await verifiedLock(lockDirectory);
  const location = wranglerCacheDirectory(options.base);
  await privateDirectory(dirname(location));
  const lockPath = `${location}.install.lock`;
  const lock = await acquireLock(lockPath);
  let staging: string | undefined;
  try {
    await lock.writeFile(`pid=${process.pid}\n`);
    await removeAbandonedStaging(location);
    await noSymlinks(location);
    if (await present(location)) {
      if (await runsPinnedVersion(runner, location))
        return join(location, SCRIPT);
      throw new Error(
        `Wrangler 缓存校验失败：${location}；请检查并移除该缓存后重试。`,
      );
    }
    staging = await mkdtemp(`${location}.staging-`);
    await chmod(staging, 0o700);
    for (const name of MANIFESTS)
      await writeFile(join(staging, name), manifests[name], { mode: 0o600 });
    try {
      await runner("npm", NPM_ARGS, {
        cwd: staging,
        timeout: INSTALL_TIMEOUT,
        env: { ...process.env, npm_config_update_notifier: "false" },
      });
    } catch (error) {
      if (error instanceof CommandUnavailableError)
        throw new Error("未找到 npm；请安装 Node.js 附带的 npm 后重试。", {
          cause: error,
        });
      // npm output can echo registry URLs or auth config; only the message is shown.
      throw new Error(
        "npm ci 失败（检查网络、代理或 npm registry 配置）；未启用安装结果。",
        { cause: error },
      );
    }
    if (!(await runsPinnedVersion(runner, staging)))
      throw new Error(
        `Wrangler 安装后版本校验失败（应为 ${WRANGLER_VERSION}）；未启用安装结果。`,
      );
    await noSymlinks(location);
    await rename(staging, location);
    staging = undefined;
    return join(location, SCRIPT);
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

async function runs(resolved: WranglerCommand, root: string, runner: Runner) {
  try {
    await runner(resolved.command, [...resolved.prefix, "--version"], {
      cwd: root,
      timeout: VERSION_TIMEOUT,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    return true;
  } catch {
    return false;
  }
}

/** Finds a working Wrangler or, after confirmation, installs the pinned version privately. */
export async function ensureWrangler(options: {
  root: string;
  launchRoot?: string;
  base?: string;
  runner?: Runner;
  ui: UI;
  lockDirectory?: string;
}): Promise<boolean> {
  const runner = options.runner ?? run;
  const launchRoot = options.launchRoot ?? process.cwd();
  const resolved = await resolveWrangler(
    options.root,
    launchRoot,
    options.base,
  );
  if (await runs(resolved, options.root, runner)) return true;
  if (resolved.source === "project") {
    // Project dependencies take precedence, so a private copy would never be used.
    options.ui.log(
      `项目依赖中的 Wrangler 无法运行：${resolved.location}。请在该项目重新安装依赖（例如 pnpm install）后重试；未安装私有副本。`,
    );
    return false;
  }
  const location = wranglerCacheDirectory(options.base);
  const checked = [...new Set([options.root, launchRoot])].join("、");
  options.ui.log(
    [
      `未找到可用的 Wrangler（已检查 ${checked} 的项目依赖、setup 私有缓存和系统 PATH）。Cloudflare 官方登录需要它。`,
      `可安装固定版本 ${WRANGLER_VERSION} 到 ${location}：按随工具发布的锁文件执行 npm ci，逐包校验 sha512，不运行依赖安装脚本，约 200 MB。`,
      `也可以自行安装：${manualWranglerInstall}`,
    ].join("\n"),
  );
  if (
    !(await options.ui.confirm(
      "现在安装 setup 私有的 Wrangler？不修改系统 PATH 或 shell 配置。",
    ))
  )
    return false;
  try {
    await installManagedWrangler({
      base: options.base,
      runner,
      lockDirectory: options.lockDirectory,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    options.ui.log(
      `Wrangler 安装未完成：${reason}\n可检查网络或 npm 配置后重试，或手动执行：${manualWranglerInstall}`,
    );
    return false;
  }
  options.ui.log(`Wrangler ${WRANGLER_VERSION} 已安装到 ${location}。`);
  return true;
}
