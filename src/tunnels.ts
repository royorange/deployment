import { isDeepStrictEqual } from "node:util";
import { Api } from "./providers.ts";

export type Zone = {
  id: string;
  name: string;
  status: "active";
  account: { id: string };
};
export type Tunnel = {
  id: string;
  name: string;
  status: string;
  remote_config: true;
};
export type TunnelConfig = Record<string, unknown> & {
  ingress?: Array<Record<string, unknown>>;
};
export type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
};
type Envelope<T> = {
  success: boolean;
  result: T;
  result_info?: { total_pages?: number };
};
type Method = "GET" | "POST" | "PUT";

function hexId(value: string, label: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error(`${label} ID 格式无效。`);
  return value;
}
function uuid(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    throw new Error("Tunnel ID 格式无效。");
  return value;
}
export function tunnelHostname(value: string): string {
  if (
    value.length > 253 ||
    !value.includes(".") ||
    !/^[a-z0-9.-]+$/.test(value) ||
    value
      .split(".")
      .some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    !/[a-z]/.test(value.split(".").at(-1) ?? "") ||
    value.endsWith(".localhost")
  )
    throw new Error("公开域名格式无效；不支持 IP、localhost、通配符或 URL。");
  return value;
}
export function tunnelService(value: string): string {
  const match = /^http:\/\/([a-z0-9][a-z0-9-]{0,62}):([1-9][0-9]{0,4})$/.exec(
    value,
  );
  let normalizedHost: string | undefined;
  try {
    normalizedHost = match ? new URL(value).hostname : undefined;
  } catch {
    // Invalid ports and ambiguous numeric IP spellings are rejected below.
  }
  if (
    !match ||
    match[1] === "localhost" ||
    match[1]?.endsWith("-") ||
    Number(match[2]) > 65535 ||
    normalizedHost !== match[1]
  )
    throw new Error(
      "本地服务只支持 HTTP 容器服务名及有效端口，例如 http://app:3000。",
    );
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function config(value: unknown): TunnelConfig {
  if (
    !object(value) ||
    (value.ingress !== undefined &&
      (!Array.isArray(value.ingress) || !value.ingress.every(object)))
  )
    throw new Error("Tunnel 配置响应无效。");
  return structuredClone(value) as TunnelConfig;
}
export function mergeTunnelIngress(
  current: TunnelConfig,
  hostname: string,
  service = "http://app:3000",
): TunnelConfig {
  tunnelHostname(hostname);
  tunnelService(service);
  const next = config(current);
  const ingress = next.ingress ?? [];
  if (ingress.length) {
    const last = ingress.at(-1)!;
    if (
      last.service !== "http_status:404" ||
      last.hostname !== undefined ||
      last.path !== undefined
    )
      throw new Error("现有 Tunnel 缺少末尾 404 规则；请先人工核对配置。");
    if (ingress.slice(0, -1).some((rule) => rule.hostname === undefined))
      throw new Error("现有 Tunnel 包含提前匹配的规则，无法安全添加域名。");
  }
  const matches = ingress.filter((rule) => rule.hostname === hostname);
  if (
    matches.length > 1 ||
    matches.some((rule) => rule.path !== undefined) ||
    ingress.some(
      (rule) =>
        typeof rule.hostname === "string" &&
        rule.hostname.startsWith("*.") &&
        hostname.endsWith(rule.hostname.slice(1)),
    )
  )
    throw new Error("现有 Tunnel 域名规则存在冲突，请先人工核对。");
  if (matches.length) {
    next.ingress = ingress.map((rule) =>
      rule.hostname === hostname ? { ...rule, service } : rule,
    );
  } else {
    next.ingress = [
      ...ingress.slice(0, -1),
      { hostname, service },
      ingress.at(-1) ?? { service: "http_status:404" },
    ];
  }
  return next;
}

export class CloudflareTunnels {
  private api: Api;
  constructor(token: string, fetcher?: typeof fetch) {
    this.api = new Api("https://api.cloudflare.com/client/v4", token, fetcher);
  }
  private async result<T>(
    path: string,
    method: Method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await this.api.request<Envelope<T>>(path, method, body);
    if (response.success !== true)
      throw new Error("Cloudflare Tunnel 操作未成功；请检查权限和控制台状态。");
    return response.result;
  }
  private async pages(path: string): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.api.request<Envelope<unknown[]>>(
        `${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`,
      );
      if (response.success !== true || !Array.isArray(response.result))
        throw new Error("Cloudflare 列表响应无效。");
      values.push(...response.result);
      const total = response.result_info?.total_pages;
      if (total !== undefined && (!Number.isInteger(total) || total < 0))
        throw new Error("Cloudflare 分页响应无效。");
      if (total !== undefined ? page >= total : response.result.length < 50)
        return values;
    }
    throw new Error("Cloudflare 列表分页超过限制。");
  }
  private readZone(value: unknown, account: string, id?: string): Zone {
    if (
      !object(value) ||
      !object(value.account) ||
      value.account.id !== account ||
      typeof value.id !== "string" ||
      (id !== undefined && value.id !== id)
    )
      throw new Error("Zone 归属响应不合法。");
    hexId(value.id, "Zone");
    if (value.status !== "active") throw new Error("Zone 尚未激活。");
    if (typeof value.name !== "string") throw new Error("Zone 域名响应无效。");
    tunnelHostname(value.name);
    return {
      id: value.id,
      name: value.name,
      status: "active",
      account: { id: account },
    };
  }
  async zones(account: string): Promise<Zone[]> {
    const values = await this.pages(
      `/zones?account.id=${hexId(account, "Account")}`,
    );
    return values.map((value) => this.readZone(value, account));
  }
  async zone(account: string, id: string): Promise<Zone> {
    hexId(account, "Account");
    return this.readZone(
      await this.result(`/zones/${hexId(id, "Zone")}`),
      account,
      id,
    );
  }
  private readTunnel(value: unknown, account: string): Tunnel {
    if (
      !object(value) ||
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      typeof value.status !== "string" ||
      value.account_tag !== account ||
      value.remote_config !== true ||
      value.deleted_at != null
    )
      throw new Error("Tunnel 归属或远程配置响应不合法。");
    return {
      id: uuid(value.id),
      name: value.name,
      status: value.status,
      remote_config: true,
    };
  }
  async tunnels(account: string): Promise<Tunnel[]> {
    const values = await this.pages(
      `/accounts/${hexId(account, "Account")}/cfd_tunnel?is_deleted=false`,
    );
    return values
      .filter((value) => object(value) && value.remote_config === true)
      .map((value) => this.readTunnel(value, account));
  }
  async createTunnel(account: string, name: string): Promise<Tunnel> {
    hexId(account, "Account");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
      throw new Error("Tunnel 名称格式无效。");
    return this.readTunnel(
      await this.result(`/accounts/${account}/cfd_tunnel`, "POST", {
        name,
        config_src: "cloudflare",
      }),
      account,
    );
  }
  private tunnelPath(account: string, tunnel: string): string {
    return `/accounts/${hexId(account, "Account")}/cfd_tunnel/${uuid(tunnel)}`;
  }
  async configuration(account: string, tunnel: string): Promise<TunnelConfig> {
    const response = await this.result<unknown>(
      `${this.tunnelPath(account, tunnel)}/configurations`,
    );
    if (!object(response)) throw new Error("Tunnel 配置响应无效。");
    return config(response.config);
  }
  private async hostZone(
    account: string,
    zoneId: string,
    hostname: string,
  ): Promise<Zone> {
    tunnelHostname(hostname);
    const selected = await this.zone(account, zoneId);
    if (hostname !== selected.name && !hostname.endsWith(`.${selected.name}`))
      throw new Error("域名不属于所选 DNS 区域。");
    return selected;
  }
  async updateIngress(
    account: string,
    tunnel: string,
    zoneId: string,
    hostname: string,
    service: string,
    expectedConfig: TunnelConfig,
  ): Promise<void> {
    const path = this.tunnelPath(account, tunnel);
    const planned = mergeTunnelIngress(expectedConfig, hostname, service);
    await this.hostZone(account, zoneId, hostname);
    const current = await this.configuration(account, tunnel);
    if (!isDeepStrictEqual(current, expectedConfig))
      throw new Error("Tunnel 配置在预览后发生变化，请重新预览再确认。");
    await this.result(`${path}/configurations`, "PUT", { config: planned });
  }
  async dnsRecords(
    account: string,
    zoneId: string,
    hostname: string,
  ): Promise<DnsRecord[]> {
    await this.hostZone(account, zoneId, hostname);
    const values = await this.pages(
      `/zones/${zoneId}/dns_records?name=${hostname}`,
    );
    return values.map((value) => {
      if (
        !object(value) ||
        typeof value.id !== "string" ||
        value.name !== hostname ||
        typeof value.type !== "string" ||
        typeof value.content !== "string" ||
        typeof value.proxied !== "boolean"
      )
        throw new Error("DNS 记录响应无效。");
      return {
        id: hexId(value.id, "DNS"),
        name: hostname,
        type: value.type,
        content: value.content,
        proxied: value.proxied,
      };
    });
  }
  async ensureDns(
    account: string,
    zoneId: string,
    hostname: string,
    tunnel: string,
  ): Promise<"created" | "existing"> {
    uuid(tunnel);
    const records = await this.dnsRecords(account, zoneId, hostname);
    const content = `${tunnel}.cfargotunnel.com`;
    if (records.length) {
      if (
        records.length === 1 &&
        records[0]?.type === "CNAME" &&
        records[0].content === content &&
        records[0].proxied
      )
        return "existing";
      throw new Error("域名已有冲突 DNS 记录；未覆盖任何记录。");
    }
    await this.result(`/zones/${zoneId}/dns_records`, "POST", {
      type: "CNAME",
      name: hostname,
      content,
      proxied: true,
      ttl: 1,
    });
    return "created";
  }
  async token(account: string, tunnel: string): Promise<string> {
    const value = await this.result<unknown>(
      `${this.tunnelPath(account, tunnel)}/token`,
    );
    if (
      typeof value !== "string" ||
      value.length > 16384 ||
      !/^[A-Za-z0-9_+/=.-]+$/.test(value)
    )
      throw new Error("Tunnel 连接令牌响应无效。");
    return value;
  }
}
