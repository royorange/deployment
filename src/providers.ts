type Fetcher = typeof fetch;
type Method = "GET" | "POST" | "PATCH";
export class ApiError extends Error {
  status: number;
  constructor(status: number) {
    super(
      `服务请求失败（HTTP ${status}）。${status === 402 ? "请检查组织额度和账单。" : status === 401 ? "令牌无效、过期或已撤销；请重新获取对应服务的令牌并连接账号。" : status === 403 ? "令牌权限、资源范围或账号角色不足；请按操作补充最小权限并检查组织/项目范围，无需全权限。" : status === 429 ? "请求过多，请稍后重试。" : "未自动重试写入；请检查服务状态。"}`,
    );
    this.status = status;
  }
}
export class Api {
  private base: string;
  private token: string;
  private fetcher: Fetcher;
  constructor(base: string, token: string, fetcher: Fetcher = fetch) {
    if (
      ![
        "https://api.cloudflare.com/client/v4",
        "https://api.supabase.com/v1",
      ].includes(base)
    )
      throw new Error("不支持的服务地址。");
    if (!token.trim() || /[\x00-\x20\x7f]/.test(token))
      throw new Error("令牌格式无效。");
    this.base = base;
    this.token = token;
    this.fetcher = fetcher;
  }
  async request<T>(
    path: string,
    method: Method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (
      !/^\/[a-zA-Z0-9][a-zA-Z0-9_/?=&.%+-]*$/.test(path) ||
      path.includes("..") ||
      /%2f|%5c/i.test(path)
    )
      throw new Error("API 路径不合法。");
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(
        "无法连接服务：请检查网络、代理或重定向；请求未自动重试。",
      );
    }
    if (!response.ok) throw new ApiError(response.status);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("服务响应过大。");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("服务返回了无效 JSON。");
    }
  }
}
type CFResult<T> = {
  success: boolean;
  result: T;
  result_info?: { total_pages?: number };
};
export type Account = { id: string; name: string };
export type PagesProject = {
  name: string;
  production_branch: string;
  subdomain: string;
  source?: unknown;
};
function accountId(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("Account ID 格式无效。");
  return value;
}
function resourceName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(value))
    throw new Error("资源名称格式无效。");
  return value;
}
function projectRef(value: string): string {
  if (!/^[a-z]{20}$/.test(value))
    throw new Error("Supabase Project Ref 格式无效。");
  return value;
}

export class Cloudflare {
  private api: Api;
  constructor(token: string, fetcher?: Fetcher) {
    this.api = new Api("https://api.cloudflare.com/client/v4", token, fetcher);
  }
  private async result<T>(
    path: string,
    method: Method = "GET",
    body?: unknown,
  ): Promise<T> {
    const data = await this.api.request<CFResult<T>>(path, method, body);
    if (data.success !== true)
      throw new Error("Cloudflare 操作未成功；请检查权限和控制台状态。");
    return data.result;
  }
  async accounts(): Promise<Account[]> {
    const accounts: Account[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.api.request<CFResult<Account[]>>(
        `/accounts?per_page=50&page=${page}`,
      );
      if (!data.success || !Array.isArray(data.result))
        throw new Error("Cloudflare 账号列表不可用；可手动输入 Account ID。");
      accounts.push(...data.result);
      if (page >= (data.result_info?.total_pages ?? 1)) return accounts;
    }
    throw new Error("账号分页超过限制，请手动指定 Account ID。");
  }
  async pagesProject(
    account: string,
    name: string,
  ): Promise<PagesProject | null> {
    try {
      return await this.result(
        `/accounts/${accountId(account)}/pages/projects/${resourceName(name)}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  async createPages(account: string, name: string): Promise<PagesProject> {
    return this.result(
      `/accounts/${accountId(account)}/pages/projects`,
      "POST",
      { name: resourceName(name), production_branch: "main" },
    );
  }
  async workerSubdomain(account: string): Promise<string | undefined> {
    const result = await this.result<{ subdomain?: string }>(
      `/accounts/${accountId(account)}/workers/subdomain`,
    );
    if (
      result.subdomain &&
      !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(result.subdomain)
    )
      throw new Error("Workers 子域名响应异常。");
    return result.subdomain;
  }
}

export type SupabaseProject = {
  id: string;
  name: string;
  region: string;
  organization_id: string;
  status: string;
};
export class Supabase {
  private api: Api;
  constructor(token: string, fetcher?: Fetcher) {
    this.api = new Api("https://api.supabase.com/v1", token, fetcher);
  }
  async projects(): Promise<SupabaseProject[]> {
    return this.api.request("/projects");
  }
  async organizations(): Promise<Account[]> {
    return this.api.request("/organizations");
  }
  async project(ref: string): Promise<SupabaseProject> {
    const project = await this.api.request<SupabaseProject>(
      `/projects/${projectRef(ref)}`,
    );
    if (
      project.id !== ref ||
      typeof project.organization_id !== "string" ||
      !project.organization_id
    )
      throw new Error("Supabase 项目范围响应不合法。");
    return project;
  }
  async identity(): Promise<{ id: string; email: string }> {
    const profile = await this.api.request<{
      gotrue_id: string;
      primary_email: string;
    }>("/profile");
    if (
      !/^[a-f0-9-]{36}$/.test(profile.gotrue_id) ||
      typeof profile.primary_email !== "string"
    )
      throw new Error("Supabase 账号身份响应不合法。");
    return { id: profile.gotrue_id, email: profile.primary_email };
  }
  async publishableKey(ref: string): Promise<string> {
    const keys = await this.api.request<
      Array<{ type?: string; name: string; api_key?: string }>
    >(`/projects/${projectRef(ref)}/api-keys?reveal=true`);
    const key = keys.find(
      (key) =>
        key.type === "publishable" &&
        key.api_key?.startsWith("sb_publishable_"),
    )?.api_key;
    if (!key)
      throw new Error(
        "项目尚无 Publishable Key。请在项目 Settings → API Keys 创建后重试。",
      );
    return key;
  }
  async authOrigins(
    ref: string,
  ): Promise<{ site_url: string; uri_allow_list: string }> {
    return this.api.request(`/projects/${projectRef(ref)}/config/auth`);
  }
  async setAuthOrigins(
    ref: string,
    site: string,
    allowList: string,
  ): Promise<void> {
    await this.api.request(
      `/projects/${projectRef(ref)}/config/auth`,
      "PATCH",
      { site_url: site, uri_allow_list: allowList },
    );
  }
}

export async function supabaseHealth(
  ref: string,
  key: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))
    throw new Error("需要 Publishable Key 验证 Auth 网关。");
  let response: Response;
  try {
    response = await fetcher(
      `https://${projectRef(ref)}.supabase.co/auth/v1/health`,
      {
        headers: { apikey: key },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error("无法连接项目 Auth 网关，请检查网络或服务状态。");
  }
  if (!response.ok) throw new ApiError(response.status);
  await response.body?.cancel();
}
