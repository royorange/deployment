import { access } from "node:fs/promises";
import { join } from "node:path";
import { run, type Runner, type RunOptions } from "./process.ts";
import type { Account, SupabaseProject } from "./providers.ts";

export type Identity = { id: string; email: string };
export function profileName(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(value))
    throw new Error(
      "登录 profile 名称不合法，仅支持小写字母、数字、连字符和下划线。",
    );
  return value;
}
export function machineJson<T>(output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(
      "官方 CLI 未返回预期的 JSON；请检查 CLI 版本，不会解析或打印原始凭据输出。",
    );
  }
}
export function supabaseEnvironment(
  token?: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("SUPABASE_")),
  );
  if (token) env.SUPABASE_ACCESS_TOKEN = token;
  return env;
}
function cloudflareEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("CLOUDFLARE_") &&
        !key.startsWith("CF_API_") &&
        key !== "WRANGLER_AUTH_PROFILE",
    ),
  );
}
export async function wranglerRun(
  root: string,
  args: string[],
  runner: Runner = run,
  options: RunOptions = {},
  launchRoot = process.cwd(),
): Promise<string> {
  const env = {
    ...cloudflareEnvironment(),
    WRANGLER_SEND_METRICS: "false",
    ...options.env,
  };
  // Selecting another project must not hide the launcher's installed CLI.
  const candidates = [...new Set([root, launchRoot])].flatMap((directory) => [
    join(directory, "node_modules/wrangler/bin/wrangler.js"),
    join(directory, "apps/web/node_modules/wrangler/bin/wrangler.js"),
  ]);
  for (const path of candidates) {
    try {
      await access(path);
    } catch {
      continue;
    }
    return runner(process.execPath, [path, ...args], {
      ...options,
      cwd: root,
      env,
    });
  }
  return runner("wrangler", args, { ...options, cwd: root, env });
}
export type WranglerSession = {
  type: "oauth" | "api_token";
  token: string;
  identity: string;
  accounts: Account[];
};
export async function wranglerSession(
  root: string,
  runner: Runner = run,
  profile = "default",
  expectedIdentity?: string,
  expectedAccount?: string,
): Promise<WranglerSession> {
  profileName(profile);
  const token = machineJson<{ type: string; token: string }>(
    await wranglerRun(
      root,
      ["auth", "token", "--json", "--profile", profile],
      runner,
    ),
  );
  if (
    !["oauth", "api_token"].includes(token.type) ||
    typeof token.token !== "string" ||
    !token.token ||
    /[\x00-\x20\x7f]/.test(token.token)
  )
    throw new Error(
      "官方 Wrangler 未提供可用的 OAuth/API Token；不支持 Global API Key。",
    );
  // Inspect the exact returned token, rather than re-reading a potentially switched default login.
  const info = machineJson<{
    loggedIn: boolean;
    email?: string;
    accounts: Account[];
  }>(
    await wranglerRun(root, ["whoami", "--json"], runner, {
      env: { CLOUDFLARE_API_TOKEN: token.token },
    }),
  );
  if (info.loggedIn !== true || !Array.isArray(info.accounts))
    throw new Error("Wrangler 尚未登录或无法验证登录状态。");
  const identity = typeof info.email === "string" ? info.email : "";
  if (expectedIdentity && identity !== expectedIdentity)
    throw new Error(
      `Wrangler 登录身份已变化（当前 ${identity || "邮箱不可读"}，原绑定 ${expectedIdentity}），请通过“连接账号”显式重新绑定；未执行资源操作。`,
    );
  if (
    expectedAccount &&
    !info.accounts.some((account) => account.id === expectedAccount)
  )
    throw new Error(
      "Wrangler 当前身份无权访问项目绑定的 Cloudflare 账号；未执行资源操作。",
    );
  return {
    type: token.type as WranglerSession["type"],
    token: token.token,
    identity,
    accounts: info.accounts,
  };
}

export class CliSupabase {
  readonly profile: string;
  private root: string;
  private runner: Runner;
  private expectedIdentity?: string;
  constructor(
    profile: string,
    root: string,
    runner: Runner = run,
    expectedIdentity?: string,
  ) {
    this.profile = profileName(profile);
    this.root = root;
    this.runner = runner;
    this.expectedIdentity = expectedIdentity;
  }
  async identity(): Promise<Identity> {
    const user = machineJson<Identity>(
      await this.runner(
        "supabase",
        ["whoami", "--profile", this.profile, "--output-format", "json"],
        { cwd: this.root, env: supabaseEnvironment() },
      ),
    );
    if (
      typeof user.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(user.id) ||
      typeof user.email !== "string"
    )
      throw new Error("Supabase CLI 身份响应不合法；需要 CLI >=2.120.0。");
    if (this.expectedIdentity && user.id !== this.expectedIdentity)
      throw new Error(
        `Supabase profile 的登录身份已变化（当前 ${user.email} / ${user.id}，原绑定 ${this.expectedIdentity}），请显式重新连接账号；未执行资源操作。`,
      );
    return user;
  }
  private async list<T>(args: string[]): Promise<T[]> {
    const identity = await this.identity();
    const items = machineJson<T[]>(
      await this.runner(
        "supabase",
        [...args, "--profile", this.profile, "--output", "json"],
        { cwd: this.root, env: supabaseEnvironment() },
      ),
    );
    if (!Array.isArray(items)) throw new Error("Supabase CLI 列表响应不合法。");
    const after = await this.identity();
    if (identity.id !== after.id)
      throw new Error("Supabase 登录身份在读取期间发生变化，已丢弃结果。");
    return items;
  }
  async projects(): Promise<SupabaseProject[]> {
    const projects = await this.list<SupabaseProject & { ref?: string }>([
      "projects",
      "list",
    ]);
    return projects.map((project) => ({
      ...project,
      id: project.ref || project.id,
    }));
  }
  async organizations(): Promise<Account[]> {
    return this.list<Account>(["orgs", "list"]);
  }
  async publishableKey(ref: string): Promise<string> {
    if (!/^[a-z]{20}$/.test(ref)) throw new Error("Project Ref 格式无效。");
    const keys = await this.list<{ type?: string; api_key?: string }>([
      "projects",
      "api-keys",
      "--project-ref",
      ref,
    ]);
    const key = keys.find(
      (key) =>
        key.type === "publishable" &&
        key.api_key?.startsWith("sb_publishable_"),
    )?.api_key;
    if (!key)
      throw new Error(
        "该项目未提供 Publishable Key；请在 API Keys 页面创建后重试。",
      );
    return key;
  }
}
