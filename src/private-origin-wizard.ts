import { projectKey } from "./config.ts";
import type { Context } from "./wizard.ts";
import {
  CloudflarePrivateOrigin,
  privateOriginPlan,
} from "./private-origin.ts";
import { CloudflareTunnels, mergeTunnelIngress } from "./tunnels.ts";
import { tunnelConfigurationMatches } from "./tunnel-readback.ts";
import type { GuideOperationResult } from "./deployment-wizard.ts";

function profile(ctx: Context) {
  return (ctx.data.profiles[projectKey(ctx.config.project, ctx.env)] ??= {});
}
function clients(ctx: Context) {
  const p = profile(ctx),
    token = ctx.data.credentials[p["@cloudflareTunnelManagement"] ?? ""];
  if (!token)
    throw new Error("请先配置此环境专用的 Tunnel / Access 管理凭据。");
  return {
    tunnel: new CloudflareTunnels(token, ctx.fetcher),
    access: new CloudflarePrivateOrigin(token, ctx.fetcher),
  };
}
async function plan(ctx: Context, tunnel: CloudflareTunnels) {
  const p = profile(ctx);
  const zone = await tunnel.zone(
    p.cloudflareAccountId ?? "",
    p.cloudflareZoneId ?? "",
  );
  return privateOriginPlan({
    project: ctx.config.project,
    environment: ctx.env,
    accountId: zone.account.id,
    zoneId: zone.id,
    zoneName: zone.name,
    publicOrigin: p.appOrigin ?? "",
    privateOrigin: p.privateOrigin ?? "",
    workerName: p.workerName ?? "",
  });
}
export async function verifyPrivateOrigin(
  ctx: Context,
): Promise<GuideOperationResult> {
  const p = profile(ctx),
    { tunnel, access } = clients(ctx),
    target = await plan(ctx, tunnel);
  if (
    !p.cloudflareTunnelId ||
    !p.cloudflareTunnelToken ||
    !p.accessServiceId ||
    !p.accessClientId ||
    !p.accessCredential
  )
    return { status: "configured", message: "私有源站身份或连接凭据不完整。" };
  const remote = (await tunnel.tunnels(target.accountId)).filter(
    (t) => t.name === target.name,
  );
  if (remote.length !== 1 || remote[0]!.id !== p.cloudflareTunnelId)
    throw new Error("Tunnel 身份不匹配。");
  const current = await tunnel.configuration(
    target.accountId,
    p.cloudflareTunnelId,
  );
  if (
    !tunnelConfigurationMatches(
      current,
      mergeTunnelIngress(
        current,
        target.hostname,
        target.service,
        target.originRequest,
      ),
    )
  )
    throw new Error("私有 API 路由或 Host Header 不匹配。");
  const records = await tunnel.dnsRecords(
    target.accountId,
    target.zoneId,
    target.hostname,
  );
  if (
    records.length !== 1 ||
    records[0]!.type !== "CNAME" ||
    records[0]!.content !== `${p.cloudflareTunnelId}.cfargotunnel.com` ||
    !records[0]!.proxied
  )
    throw new Error("私有 API DNS 不匹配。");
  const app = await access.inspectAccess(target);
  const { accessPolicyMatches } = await import("./private-origin.ts");
  if (!app || !accessPolicyMatches(app.policies, p.accessServiceId))
    throw new Error("Access Service Auth 策略未通过只读核验。");
  return {
    status: "verified",
    message: "私有入口资源配置已核验；连接器、拒绝绕过与应用健康仍需发布验证。",
  };
}
export async function configurePrivateOrigin(
  ctx: Context,
): Promise<GuideOperationResult> {
  if (ctx.config.deploymentTopology !== "worker-private-origin")
    throw new Error("私有源站配置要求明确的拓扑声明。");
  const p = profile(ctx),
    { tunnel, access } = clients(ctx),
    target = await plan(ctx, tunnel);
  const tunnels = (await tunnel.tunnels(target.accountId)).filter(
    (t) => t.name === target.name,
  );
  if (
    tunnels.length > 1 ||
    (p.cloudflareTunnelId && tunnels[0]?.id !== p.cloudflareTunnelId)
  )
    throw new Error("Tunnel 绑定存在冲突，未创建或覆盖。");
  const records = await tunnel.dnsRecords(
    target.accountId,
    target.zoneId,
    target.hostname,
  );
  if (
    records.length &&
    !(
      records.length === 1 &&
      records[0]!.type === "CNAME" &&
      records[0]!.proxied &&
      records[0]!.content === `${tunnels[0]?.id}.cfargotunnel.com`
    )
  )
    throw new Error("私有域名 DNS 存在冲突，未覆盖。");
  await access.inspectAccess(target);
  const binding = JSON.stringify(p);
  ctx.ui.log(
    `计划：${target.name} 独立 Tunnel；${target.hostname} → ${target.service}，Host=${target.publicHostname}；独立 Access Service Auth。公开入口 ${target.publicHostname} 仅在 Worker 发布时绑定。`,
  );
  if (
    !(await ctx.ui.confirm(
      `确认创建/复用以上资源，并授权 ${target.hostname} 的代理 CNAME 写入？不会修改无关资源；失败保留已创建身份供复核。`,
    ))
  )
    return { status: "cancelled" };
  if (JSON.stringify(profile(ctx)) !== binding)
    throw new Error("确认期间私有源站目标或凭据变化，请重新预览。");
  const selected =
    tunnels[0] ?? (await tunnel.createTunnel(target.accountId, target.name));
  p.cloudflareTunnelId = selected.id;
  p.cloudflareZoneName = target.zoneName;
  await ctx.save();
  if (!p.accessServiceId) {
    const token = await access.createServiceToken(target);
    p.accessServiceId = token.id;
    p.accessClientId = token.clientId;
    p.accessCredential = token.clientSecret;
    await ctx.save();
    if (ctx.storageMode !== "vault")
      ctx.ui.log(
        "Access 服务凭据仅在本次内存中；退出前请显式导出私密配置，否则不能恢复一次性秘密。",
      );
  }
  if (!p.accessClientId || !p.accessCredential)
    throw new Error(
      "已存在 Access 令牌但本地凭据缺失；恢复私密配置后继续，不自动轮换。",
    );
  p.accessApplicationId = await access.ensureAccess(target, p.accessServiceId);
  await ctx.save();
  const snapshot = await tunnel.configurationSnapshot(
    target.accountId,
    selected.id,
  );
  await tunnel.updateIngressFromSnapshot(
    target.accountId,
    selected.id,
    target.zoneId,
    target.hostname,
    target.service,
    snapshot,
    target.originRequest,
  );
  await tunnel.ensureDns(
    target.accountId,
    target.zoneId,
    target.hostname,
    selected.id,
  );
  p.cloudflareTunnelToken = await tunnel.token(target.accountId, selected.id);
  await ctx.save();
  return verifyPrivateOrigin(ctx);
}
