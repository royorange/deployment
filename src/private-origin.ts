import { isDeepStrictEqual } from "node:util";
import { Api } from "./providers.ts";
import { tunnelHostname, tunnelService } from "./tunnels.ts";

export type PrivateOriginInput = {
  project: string;
  environment: string;
  accountId: string;
  zoneId: string;
  zoneName: string;
  publicOrigin: string;
  privateOrigin: string;
  workerName: string;
};
export function privateOriginPlan(input: PrivateOriginInput) {
  for (const value of [input.project, input.environment, input.workerName])
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(value))
      throw new Error("私有源站标识无效。");
  for (const value of [input.accountId, input.zoneId])
    if (!/^[a-f0-9]{32}$/.test(value))
      throw new Error("Cloudflare 目标 ID 无效。");
  tunnelHostname(input.zoneName);
  const hostname = (origin: string) => {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error("私有源站必须使用精确 HTTPS Origin。");
    const host = tunnelHostname(url.hostname);
    if (!host.endsWith(`.${input.zoneName}`))
      throw new Error("入口必须是所选 Zone 的子域名。");
    return host;
  };
  const publicHostname = hostname(input.publicOrigin),
    privateHostname = hostname(input.privateOrigin);
  if (publicHostname === privateHostname)
    throw new Error("公开 Worker 与私有 API 入口必须分开。");
  const name = `${input.project}-${input.environment}`;
  if (name.length > 63) throw new Error("资源名称超过限制。");
  return {
    ...input,
    name,
    hostname: privateHostname,
    publicHostname,
    service: tunnelService(`http://${name}:3000`),
    originRequest: { httpHostHeader: publicHostname },
  };
}
export type PrivateOriginPlan = ReturnType<typeof privateOriginPlan>;
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new Error("Cloudflare 资源身份响应无效。");
  return value;
}
export function accessPolicyMatches(
  policies: unknown,
  tokenId: string,
): boolean {
  if (!Array.isArray(policies) || policies.length !== 1 || !object(policies[0]))
    return false;
  const p = policies[0];
  return (
    p.decision === "non_identity" &&
    isDeepStrictEqual(p.include, [{ service_token: { token_id: tokenId } }]) &&
    isDeepStrictEqual(p.exclude ?? [], []) &&
    isDeepStrictEqual(p.require ?? [], [])
  );
}
function coversHost(value: unknown, hostname: string): boolean {
  if (typeof value !== "string") return false;
  const host = value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]!;
  return (
    host === hostname ||
    host === "*" ||
    (host.startsWith("*.") && hostname.endsWith(host.slice(1)))
  );
}
/** Resource operations for explicitly reviewed Worker + Access + Tunnel plans. */
export class CloudflarePrivateOrigin {
  private api: Api;
  constructor(token: string, fetcher?: typeof fetch) {
    this.api = new Api("https://api.cloudflare.com/client/v4", token, fetcher);
  }
  private path(plan: PrivateOriginPlan) {
    privateOriginPlan(plan);
    return `/accounts/${plan.accountId}/access`;
  }
  private async result(
    path: string,
    method: "GET" | "POST" | "PUT" = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const data = await this.api.request<{ success: boolean; result: unknown }>(
      path,
      method,
      body,
    );
    if (data.success !== true)
      throw new Error("Cloudflare 私有源站操作未成功。");
    return data.result;
  }
  private async list(path: string): Promise<RecordValue[]> {
    const all: RecordValue[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.api.request<{
        success: boolean;
        result: unknown;
        result_info?: { total_pages?: number };
      }>(`${path}?per_page=50&page=${page}`);
      if (
        data.success !== true ||
        !Array.isArray(data.result) ||
        !data.result.every(object)
      )
        throw new Error("Cloudflare 列表响应无效。");
      all.push(...data.result);
      const total = data.result_info?.total_pages;
      if (total !== undefined && (!Number.isSafeInteger(total) || total < 0))
        throw new Error("Cloudflare 分页响应无效。");
      if (total !== undefined ? page >= total : data.result.length < 50)
        return all;
    }
    throw new Error("Cloudflare 列表超过分页限制。");
  }
  async inspectAccess(plan: PrivateOriginPlan) {
    const apps = await this.list(`${this.path(plan)}/apps`);
    const matches = apps.filter(
      (a) =>
        a.name === plan.name ||
        coversHost(a.domain, plan.hostname) ||
        (Array.isArray(a.destinations) &&
          a.destinations.some(
            (d) => object(d) && coversHost(d.uri, plan.hostname),
          )) ||
        (Array.isArray(a.self_hosted_domains) &&
          a.self_hosted_domains.some((d) => coversHost(d, plan.hostname))),
    );
    if (
      matches.length > 1 ||
      matches.some(
        (a) =>
          a.domain !== plan.hostname ||
          a.name !== plan.name ||
          a.type !== "self_hosted" ||
          (Array.isArray(a.destinations) && a.destinations.length > 0) ||
          (Array.isArray(a.self_hosted_domains) &&
            a.self_hosted_domains.some((d) => d !== plan.hostname)) ||
          (Array.isArray(a.overrides) && a.overrides.length > 0),
      )
    )
      throw new Error("Access 应用存在归属或域名冲突；未覆盖。");
    if (!matches.length) return undefined;
    const app = matches[0]!;
    const policies = await this.list(
      `${this.path(plan)}/apps/${identifier(app.id)}/policies`,
    );
    return {
      id: identifier(app.id),
      aud: typeof app.aud === "string" ? app.aud : undefined,
      policies,
    };
  }
  async createServiceToken(plan: PrivateOriginPlan) {
    const path = `${this.path(plan)}/service_tokens`;
    if ((await this.list(path)).some((token) => token.name === plan.name))
      throw new Error(
        "同名 Access 服务令牌已存在；请恢复已保存凭据，不自动重复创建或轮换。",
      );
    const token = await this.result(path, "POST", {
      name: plan.name,
      duration: "8760h",
    });
    if (
      !object(token) ||
      typeof token.client_id !== "string" ||
      typeof token.client_secret !== "string" ||
      !token.client_id ||
      !token.client_secret
    )
      throw new Error("Access 令牌创建响应无效；请核对远端，未自动重试。");
    return {
      id: identifier(token.id),
      clientId: token.client_id,
      clientSecret: token.client_secret,
    };
  }
  async ensureAccess(
    plan: PrivateOriginPlan,
    tokenId: string,
  ): Promise<string> {
    identifier(tokenId);
    const tokens = await this.list(`${this.path(plan)}/service_tokens`);
    if (
      !tokens.some(
        (t) => t.id === tokenId && t.name === plan.name && t.enabled !== false,
      )
    )
      throw new Error("Access 服务令牌未匹配当前项目环境。");
    let app = await this.inspectAccess(plan);
    if (!app) {
      const created = await this.result(`${this.path(plan)}/apps`, "POST", {
        name: plan.name,
        domain: plan.hostname,
        type: "self_hosted",
        app_launcher_visible: false,
        service_auth_401_redirect: true,
        http_only_cookie: true,
      });
      if (!object(created))
        throw new Error("Access 创建结果无效，请核对远端后重试。");
      app = {
        id: identifier(created.id),
        aud: typeof created.aud === "string" ? created.aud : undefined,
        policies: [],
      };
    }
    if (!app.policies.length) {
      await this.result(`${this.path(plan)}/apps/${app.id}/policies`, "POST", {
        name: plan.name,
        decision: "non_identity",
        include: [{ service_token: { token_id: tokenId } }],
        exclude: [],
        require: [],
        precedence: 1,
      });
    } else if (!accessPolicyMatches(app.policies, tokenId))
      throw new Error("Access 策略不匹配，拒绝覆盖现有授权。");
    const checked = await this.inspectAccess(plan);
    if (
      !checked ||
      checked.id !== app.id ||
      !accessPolicyMatches(checked.policies, tokenId)
    )
      throw new Error("Access 策略写后核验失败。");
    return app.id;
  }
  async bindWorkerDomain(plan: PrivateOriginPlan): Promise<void> {
    privateOriginPlan(plan);
    const path = `/accounts/${plan.accountId}/workers/domains`;
    const domains = await this.list(path);
    const existing = domains.filter((d) => d.hostname === plan.publicHostname);
    if (existing.length) {
      if (
        existing.length !== 1 ||
        existing[0]!.service !== plan.workerName ||
        existing[0]!.zone_id !== plan.zoneId ||
        existing[0]!.environment !== "production"
      )
        throw new Error("Worker 自定义域名已有冲突绑定，未覆盖。");
      return;
    }
    // This operation creates DNS; callers must obtain explicit authorization for this hostname.
    const result = await this.result(path, "PUT", {
      hostname: plan.publicHostname,
      service: plan.workerName,
      environment: "production",
      zone_id: plan.zoneId,
    });
    if (
      !object(result) ||
      result.hostname !== plan.publicHostname ||
      result.service !== plan.workerName ||
      result.zone_id !== plan.zoneId
    )
      throw new Error("Worker 域名写入结果不匹配，请只读复查。");
    const checked = (await this.list(path)).filter(
      (d) => d.hostname === plan.publicHostname,
    );
    if (
      checked.length !== 1 ||
      checked[0]!.service !== plan.workerName ||
      checked[0]!.zone_id !== plan.zoneId
    )
      throw new Error("Worker 域名写后核验失败。");
  }
}
