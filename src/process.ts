import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
import type { Entry } from "./config.ts";
import { environment, repository } from "./config.ts";
import { noSymlinks, singleLine, variableName } from "./files.ts";

export type RunOptions = {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
  timeout?: number;
  captureStderr?: boolean;
};
export type Runner = (
  command: string,
  args: string[],
  options?: RunOptions,
) => Promise<string>;
export class CommandUnavailableError extends Error {
  constructor(command: string) {
    super(
      `无法启动 ${command}；请检查对应官方 CLI 已安装、执行权限和项目目录。`,
    );
    this.name = "CommandUnavailableError";
  }
}
export const run: Runner = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env:
        command === "gh"
          ? { ...(options.env ?? process.env), GH_HOST: "github.com" }
          : (options.env ?? process.env),
      shell: false,
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, options.timeout ?? 60_000);
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_000_000) {
        failed = true;
        child.kill();
      } else output.push(chunk);
    };
    child.stdout?.on("data", collect);
    // Child stderr can echo credentials; it is deliberately not forwarded or retained.
    if (options.captureStderr) child.stderr?.on("data", collect);
    else child.stderr?.resume();
    child.stdin?.on("error", () => {
      /* EPIPE is reported by the exit status. */
    });
    child.stdin?.end(options.input);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new CommandUnavailableError(command));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || failed)
        reject(
          new Error(
            `${command} 操作失败或超时（退出码 ${code ?? "unknown"}）；已隐藏可能含凭据的输出。`,
          ),
        );
      else resolvePromise(Buffer.concat(output).toString("utf8"));
    });
  });

export async function openBrowser(
  url: string,
  runner: Runner = run,
): Promise<boolean> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    ![
      "dash.cloudflare.com",
      "supabase.com",
      "github.com",
      "cli.github.com",
    ].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("拒绝打开非官方授权地址。");
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    await runner(command, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
export async function clipboard(
  value: string,
  runner: Runner = run,
): Promise<void> {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [
            [
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$input | Set-Clipboard",
              ],
            ],
          ]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
          ];
  for (const [command, args] of candidates) {
    try {
      await runner(command, args, { input: value, timeout: 5000 });
      return;
    } catch {
      /* Try the other local clipboard provider. */
    }
  }
  throw new Error(
    "未找到可用的本地剪贴板。远程终端请选择 .env 导出；Linux 桌面需 wl-copy 或 xclip。",
  );
}

export async function githubSync(
  repo: string,
  env: string,
  entries: Entry[],
  runner: Runner = run,
  verify?: () => Promise<unknown>,
): Promise<void> {
  if (!repository(repo) || !environment(env))
    throw new Error("GitHub 仓库或环境名称不合法。");
  const completed: string[] = [];
  for (const entry of entries) {
    variableName(entry.name);
    singleLine(entry.value);
  }
  for (const entry of entries) {
    try {
      await verify?.();
      await runner(
        "gh",
        [
          entry.secret ? "secret" : "variable",
          "set",
          entry.name,
          "--repo",
          repo,
          "--env",
          env,
        ],
        { input: entry.value },
      );
      completed.push(entry.name);
    } catch {
      throw new Error(
        `GitHub 同步中断，已完成：${completed.join(", ") || "无"}；失败：${entry.name}。可重新同步；没有删除既有值。`,
      );
    }
  }
}

export async function githubPages(
  path: string,
  key: "environments" | "variables" | "secrets",
  runner: Runner = run,
): Promise<Array<{ name: string; value?: string }>> {
  if (
    !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/environments(?:\/[A-Za-z0-9_-]+\/(?:variables|secrets))?$/.test(
      path,
    )
  )
    throw new Error("GitHub 列表路径不合法。");
  const items: Array<{ name: string; value?: string }> = [];
  for (let page = 1; page <= 20; page++) {
    let result: Record<string, Array<{ name: string; value?: string }>>;
    try {
      result = JSON.parse(
        await runner("gh", [
          "api",
          "--hostname",
          "github.com",
          `${path}?per_page=100&page=${page}`,
        ]),
      );
    } catch {
      throw new Error(
        "无法读取 GitHub Environment 列表；请检查 gh 登录、仓库权限及 GitHub 套餐支持。未写入任何配置。",
      );
    }
    const batch = result[key];
    if (
      !Array.isArray(batch) ||
      batch.some(
        (item) =>
          typeof item.name !== "string" ||
          (key === "variables" && typeof item.value !== "string"),
      )
    )
      throw new Error("GitHub 列表响应格式异常。");
    items.push(
      ...batch.map((item) =>
        key === "variables"
          ? { name: item.name, value: item.value }
          : { name: item.name },
      ),
    );
    if (batch.length < 100) return items;
  }
  throw new Error("GitHub 列表超过分页限制，未写入任何配置。");
}

export async function localExportPath(
  root: string,
  input: string,
  runner: Runner = run,
): Promise<string> {
  singleLine(input);
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (
    !rel ||
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    rel
      .split(/[\\/]/)
      .some((part) => part === ".git" || part === "node_modules")
  )
    throw new Error("导出路径必须在项目内且不在 .git/node_modules 中。");
  await noSymlinks(path);
  try {
    await runner("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  } catch {
    throw new Error("请在 Git 仓库内导出，以便确认敏感文件已被忽略。");
  }
  let tracked = false;
  try {
    await runner("git", ["ls-files", "--error-unmatch", "--", rel], {
      cwd: root,
    });
    tracked = true;
  } catch {
    /* Not tracked. */
  }
  if (tracked) throw new Error("拒绝把配置写入 Git 已跟踪文件。");
  try {
    await runner("git", ["check-ignore", "--quiet", "--", rel], { cwd: root });
  } catch {
    throw new Error(`请先把导出路径加入 .gitignore：${rel}`);
  }
  return path;
}
