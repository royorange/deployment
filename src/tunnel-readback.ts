import { isDeepStrictEqual } from "node:util";
import { ApiError } from "./providers.ts";
import type { TunnelConfig } from "./tunnels.ts";

function omitEmptyOriginRequest(value: Record<string, unknown>): void {
  if (isDeepStrictEqual(value.originRequest, {})) delete value.originRequest;
}

function normalized(configuration: TunnelConfig): TunnelConfig {
  const next = structuredClone(configuration);
  omitEmptyOriginRequest(next);
  for (const rule of next.ingress ?? []) omitEmptyOriginRequest(rule);
  if (isDeepStrictEqual(next["warp-routing"], { enabled: false }))
    delete next["warp-routing"];
  return next;
}

/** Ignore only empty optional settings and explicitly disabled private routing. */
export function tunnelConfigurationMatches(
  actual: TunnelConfig,
  expected: TunnelConfig,
): boolean {
  return isDeepStrictEqual(normalized(actual), normalized(expected));
}

export type TunnelReadStage = "Zone 归属" | "Tunnel 身份" | "路由配置" | "DNS";

/** Provider bodies and exception messages may contain secrets; expose static context only. */
export function tunnelReadFailure(
  stage: TunnelReadStage,
  error: unknown,
): string {
  if (error instanceof ApiError) {
    const advice =
      error.status === 401
        ? "专用 Tunnel 管理 Token 可能已失效，请重新配置。"
        : error.status === 403
          ? stage === "DNS" || stage === "Zone 归属"
            ? "请检查专用 Token 的目标 Zone Read、DNS Edit 权限与资源范围。"
            : "请检查专用 Token 的目标账号 Cloudflare Tunnel Edit 权限与资源范围。"
          : error.status === 429
            ? "请求受限，请稍后重新核验。"
            : "请核对资源状态后重新核验。";
    return `${stage}读取未通过（HTTP ${error.status}）；${advice}`;
  }
  return `${stage}未通过核验；响应无法安全识别、配置不一致或规则存在冲突，请在 Cloudflare 控制台核对后重新检查。`;
}
