import { isDeepStrictEqual } from "node:util";
import { allFields, projectKey, validateField } from "./config.ts";
import {
  checkSshHost,
  deploymentPlan,
  type HostPreflight,
} from "./deployment-plan.ts";
import { readPrivate, singleLine, writePrivate } from "./files.ts";
import { localExportPath } from "./process.ts";
import {
  CloudflareTunnels,
  mergeTunnelIngress,
  tunnelHostname,
  tunnelService,
  type Zone,
} from "./tunnels.ts";
import type { Values } from "./vault.ts";
import type { Context } from "./wizard.ts";

export type GuideOperationResult = {
  status: "verified" | "configured" | "cancelled" | "manual";
  message?: string;
};

function current(ctx: Context): Values {
  return (ctx.data.profiles[projectKey(ctx.config.project, ctx.env)] ??= {
    ...ctx.config.defaults?.[ctx.env],
  });
}
function requireWholeAppTunnel(ctx: Context): void {
  if (ctx.config.deploymentTopology !== "aws-tunnel")
    throw new Error(
      "此操作仅支持映射明确声明 deploymentTopology=aws-tunnel 的整应用同源部署；Worker + 私有 API/Access 拓扑不能自动套用，未修改入口。",
    );
}

async function chooseZone(
  ctx: Context,
  client: CloudflareTunnels,
  account: string,
): Promise<Zone> {
  let zones: Zone[] = [];
  try {
    zones = await client.zones(account);
  } catch {
    ctx.ui.log(
      "无法完整读取可用 Zone 列表；可手动输入已有活动 Zone ID 进行归属核验。未创建资源。",
    );
  }
  const selected = zones.length
    ? await ctx.ui.select("选择 Tunnel 使用的活动 DNS Zone", [
        ...zones.map((zone) => ({ name: zone.name, value: zone.id })),
        { name: "手动输入已有 Zone ID", value: "manual" },
      ])
    : "manual";
  if (selected !== "manual") {
    const zone = zones.find((item) => item.id === selected);
    if (!zone) throw new Error("未选择有效的 DNS Zone。");
    return zone;
  }
  const id = validateField(
    ctx.config,
    "cloudflareZoneId",
    (
      await ctx.ui.input("Cloudflare Zone ID", {
        value: current(ctx).cloudflareZoneId,
      })
    ).trim(),
  );
  try {
    return await client.zone(account, id);
  } catch {
    throw new Error(
      "无法核验此 Zone 的活动状态与账号归属；请检查 ID 与读取权限。",
    );
  }
}

function defaultOrigin(ctx: Context, zone: Zone): string {
  try {
    const saved = current(ctx).appOrigin;
    if (saved) {
      const hostname = new URL(saved).hostname;
      if (hostname === zone.name || hostname.endsWith(`.${zone.name}`))
        return saved;
    }
  } catch {
    /* Use an environment-specific suggestion instead of an invalid origin. */
  }
  return `https://${ctx.env === "production" ? "app" : `app-${ctx.env}`}.${zone.name}`;
}

function dnsConflict(
  records: Awaited<ReturnType<CloudflareTunnels["dnsRecords"]>>,
  tunnelId?: string,
): boolean {
  return (
    records.length > 0 &&
    !(
      tunnelId &&
      records.length === 1 &&
      records[0]?.type === "CNAME" &&
      records[0].content === `${tunnelId}.cfargotunnel.com` &&
      records[0].proxied
    )
  );
}

/** Fresh read-only resource evidence; connector and application health are separate. */
export async function verifyGuideTunnelConfiguration(
  ctx: Context,
  client: CloudflareTunnels,
): Promise<GuideOperationResult> {
  const values = { ...current(ctx) };
  const incomplete = {
    status: "configured" as const,
    message:
      "Tunnel 的专用管理凭据、项目绑定或连接 Token 尚未齐全；未读取其他凭据或修改资源。",
  };
  if (
    ctx.config.deploymentTopology !== "aws-tunnel" ||
    !values.cloudflareAccountId ||
    !values.cloudflareZoneId ||
    !values.cloudflareTunnelId ||
    !values.appOrigin ||
    !values.cloudflareTunnelToken ||
    values.cloudflareTunnelToken.length > 16384 ||
    !/^[A-Za-z0-9_+/=.-]+$/.test(values.cloudflareTunnelToken)
  )
    return incomplete;
  try {
    const account = validateField(
      ctx.config,
      "cloudflareAccountId",
      values.cloudflareAccountId,
    );
    const zoneId = validateField(
      ctx.config,
      "cloudflareZoneId",
      values.cloudflareZoneId,
    );
    const tunnelId = validateField(
      ctx.config,
      "cloudflareTunnelId",
      values.cloudflareTunnelId,
    );
    const origin = validateField(ctx.config, "appOrigin", values.appOrigin);
    const hostname = tunnelHostname(new URL(origin).hostname);
    const name = `${ctx.config.project}-${ctx.env}`;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return incomplete;
    const service = tunnelService(`http://${name}:3000`);
    const zone = await client.zone(account, zoneId);
    if (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`))
      return incomplete;
    const tunnels = await client.tunnels(account);
    const matches = tunnels.filter((item) => item.name === name);
    if (matches.length !== 1 || matches[0]!.id !== tunnelId) return incomplete;
    const configuration = await client.configuration(account, tunnelId);
    if (
      !isDeepStrictEqual(
        configuration,
        mergeTunnelIngress(configuration, hostname, service),
      )
    )
      return incomplete;
    const dns = await client.dnsRecords(account, zoneId, hostname);
    if (dns.length !== 1 || dnsConflict(dns, tunnelId)) return incomplete;
    return { status: "verified" };
  } catch {
    return {
      status: "configured",
      message:
        "Tunnel 专用绑定、路由或代理 CNAME 未通过本次只读核验；请重新配置或检查读取权限。未修改资源，连接器与公网健康仍待发布验证。",
    };
  }
}

export async function configureTunnel(
  ctx: Context,
  client: CloudflareTunnels,
): Promise<GuideOperationResult> {
  requireWholeAppTunnel(ctx);
  const values = current(ctx);
  const account = values.cloudflareAccountId;
  if (!account || !/^[a-f0-9]{32}$/.test(account))
    throw new Error("请先连接并明确绑定 Cloudflare 账号，再配置 Tunnel。");
  const name = `${ctx.config.project}-${ctx.env}`;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    throw new Error("项目与环境组合的 Tunnel 名称不合法或超过 63 字符。");
  const service = tunnelService(`http://${name}:3000`);
  const zone = await chooseZone(ctx, client, account);
  const appOrigin = validateField(
    ctx.config,
    "appOrigin",
    (
      await ctx.ui.input("应用 HTTPS Origin（需属于所选 Zone）", {
        value: defaultOrigin(ctx, zone),
      })
    ).trim(),
  );
  const hostname = tunnelHostname(new URL(appOrigin).hostname);
  if (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`))
    throw new Error("应用域名不属于所选 Zone；未修改任何路由。");
  ctx.ui.log(
    `目标账号：${account}\n独立 Tunnel：${name}\n应用路由：${hostname} → ${service}\n应用容器须先在项目私有网络声明 ${name} 别名并监听 3000 端口；仅处理此项目与环境，保留其他域名与配置。`,
  );
  let tunnels;
  try {
    tunnels = await client.tunnels(account);
  } catch {
    throw new Error("无法读取 Tunnel 列表；请检查读取权限。未自动新建资源。");
  }
  const matches = tunnels.filter((item) => item.name === name);
  if (matches.length > 1)
    throw new Error(
      "此项目与环境存在重复同名 Tunnel；请先人工核对，未选择其他项目的 Tunnel。",
    );
  let selected = matches[0];
  let created = false;
  if (!selected) {
    if (!(await ctx.ui.confirm(`确认在上述账号新建独立 Tunnel ${name}？`)))
      return { status: "cancelled" };
    try {
      const records = await client.dnsRecords(account, zone.id, hostname);
      if (dnsConflict(records)) throw new Error("dns-conflict");
    } catch {
      throw new Error(
        "无法安全新建 Tunnel：域名存在冲突 DNS 记录，或 DNS 读取未通过；请先核对。未创建资源。",
      );
    }
    try {
      selected = await client.createTunnel(account, name);
    } catch {
      throw new Error(
        "Tunnel 创建未确认成功；请在控制台核对后重试，避免重复创建。",
      );
    }
    created = true;
  }
  // Persist identity immediately: a later API failure must not orphan a newly created resource.
  if (values.cloudflareTunnelId !== selected.id)
    delete values.cloudflareTunnelToken;
  values.cloudflareZoneId = zone.id;
  values.cloudflareTunnelId = selected.id;
  values.appOrigin = appOrigin;
  values.deploymentRuntime = "aws-tunnel";
  ctx.ui.log(`已选择 Tunnel ID：${selected.id}；后续失败不会自动删除此资源。`);
  await ctx.save();
  let configuration;
  try {
    configuration = await client.configuration(account, selected.id);
    mergeTunnelIngress(configuration, hostname, service);
  } catch {
    throw new Error(
      created
        ? "新建 Tunnel ID 已记录；暂时无法读取安全初始配置，请到 Cloudflare 控制台完成配置初始化后重新运行。未假定 404 为空配置。"
        : "无法安全读取或合并现有 Tunnel 配置；请到控制台核对，未覆盖原配置。",
    );
  }
  let records;
  try {
    records = await client.dnsRecords(account, zone.id, hostname);
  } catch {
    throw new Error("无法核验 DNS 记录；未修改 Tunnel 路由或 DNS。");
  }
  if (dnsConflict(records, selected.id))
    throw new Error("域名已有冲突 DNS 记录；未修改 Tunnel 路由或覆盖 DNS。");
  ctx.ui.log(
    `将更新 ${name} 的单条应用域名规则并确保代理 CNAME 指向此 Tunnel；无关 ingress 与配置保留。现有配置不输出，避免泄露敏感内容。`,
  );
  const replacesLegacyApp = configuration.ingress?.some(
    (rule) => rule.hostname === hostname && rule.service === "http://app:3000",
  );
  if (
    !(await ctx.ui.confirm(
      replacesLegacyApp
        ? `将此域名的旧 http://app:3000 路由改为 ${service}？请先部署并验证 ${name} 网络别名可用，避免现有应用中断；确认后才应用路由与 DNS 配置。`
        : `确认应用上述 Tunnel 路由与 DNS 配置（${service}）？请先确认应用容器已声明 ${name} 网络别名。`,
    ))
  )
    return { status: "cancelled" };
  try {
    await client.updateIngress(
      account,
      selected.id,
      zone.id,
      hostname,
      service,
      configuration,
    );
    await client.ensureDns(account, zone.id, hostname, selected.id);
  } catch {
    throw new Error(
      "Tunnel 路由或 DNS 配置未全部完成；已记录目标 ID，请重新检查。先前成功的写入不会自动回滚，未删除资源。",
    );
  }
  ctx.ui.log(
    "Tunnel 路由与 DNS 配置请求已完成；连接器、应用及公网健康仍待部署验证。",
  );
  const vault = ctx.storageMode === "vault";
  if (!vault)
    ctx.ui.log(
      "当前未启用加密保险库，连接 Token 只在本次内存使用，退出后不保存。",
    );
  if (
    !(await ctx.ui.confirm(
      vault
        ? "读取此 Tunnel 的连接 Token 并保存到已解锁加密保险库？"
        : "临时读取此 Tunnel 的连接 Token，仅用于本次会话？",
    ))
  )
    return { status: "cancelled" };
  let token;
  try {
    token = await client.token(account, selected.id);
  } catch {
    throw new Error(
      "无法读取 Tunnel 连接 Token；路由与 DNS 配置保留，可检查权限后重试。",
    );
  }
  values.cloudflareTunnelToken = token;
  await ctx.save();
  ctx.ui.log(
    vault
      ? "Tunnel 连接 Token 已保存到加密保险库，值不显示。"
      : "Tunnel 连接 Token 已载入本次内存，值不显示。",
  );
  try {
    const latest = await client.configuration(account, selected.id);
    const expected = mergeTunnelIngress(configuration, hostname, service);
    const dns = await client.dnsRecords(account, zone.id, hostname);
    if (
      !isDeepStrictEqual(latest, expected) ||
      dns.length !== 1 ||
      dnsConflict(dns, selected.id) ||
      !values.cloudflareTunnelToken?.trim()
    )
      throw new Error("verification-mismatch");
  } catch {
    const message =
      "已记录 Tunnel 配置与连接 Token，但远端路由或代理 CNAME 尚未核验一致；请重新检查，不能视为部署就绪。连接器、应用及公网健康仍待部署验证。";
    ctx.ui.log(message);
    return { status: "configured", message };
  }
  ctx.ui.log(
    "已只读核验 Tunnel 路由与代理 CNAME，连接 Token 已载入；连接器、应用及公网健康仍待部署验证。",
  );
  return { status: "verified" };
}

export async function showDeploymentPlan(ctx: Context): Promise<void> {
  const plan = deploymentPlan(ctx.config.project, ctx.env, current(ctx));
  ctx.ui.log(
    plan.ready
      ? "本地部署配置已完整；这不代表远端部署已完成。"
      : "本地部署配置未就绪；请补齐 missing 项。",
  );
  for (const check of plan.checks)
    ctx.ui.log(`[${check.status}] ${check.id}：${check.message}`);
  ctx.ui.log(`公开部署计划：\n${JSON.stringify(plan.publicValues, null, 2)}`);
}

export async function configureDeployment(ctx: Context): Promise<void> {
  requireWholeAppTunnel(ctx);
  const values = current(ctx);
  const next = {
    ...values,
    deploymentRuntime: "aws-tunnel",
    deploymentTarget: ctx.env,
    syntheticFilesEnabled: values.syntheticFilesEnabled ?? "false",
    cleanupEnabled: values.cleanupEnabled ?? "false",
  };
  const defaults: Values = {
    remoteDirectory: `/opt/${ctx.config.project}/${ctx.env}`,
  };
  for (const field of [
    "sshTarget",
    "remoteDirectory",
    "deploymentImage",
    "tunnelImage",
    "appOrigin",
    "syntheticFilesEnabled",
    "cleanupEnabled",
  ]) {
    const definition = allFields(ctx.config)[field]!;
    const input = (
      await ctx.ui.input(`${definition.label}（留空保留现有值）`, {
        value: next[field as keyof typeof next] ?? defaults[field],
      })
    ).trim();
    if (!input) continue;
    next[field as keyof typeof next] = validateField(ctx.config, field, input);
  }
  const plan = deploymentPlan(ctx.config.project, ctx.env, next);
  const localFields = new Set([
    "sshTarget",
    "remoteDirectory",
    "deploymentImage",
    "tunnelImage",
    "appOrigin",
    "syntheticFilesEnabled",
    "cleanupEnabled",
  ]);
  for (const check of plan.checks) {
    if (
      localFields.has(check.id) &&
      next[check.id as keyof typeof next] &&
      check.status === "missing"
    )
      throw new Error(`部署字段 ${check.id} 无效；未保存此次编辑。`);
  }
  Object.assign(values, next);
  await ctx.save();
  ctx.ui.log(
    "已保存本地部署配置；尚未连接或修改服务器。缺少的镜像与凭据可稍后补齐。",
  );
}

export async function checkDeploymentHost(
  ctx: Context,
): Promise<HostPreflight | undefined> {
  const target = current(ctx).sshTarget;
  if (!target) {
    ctx.ui.log("尚未配置 SSH 目标，请先填写部署配置。");
    return;
  }
  if (
    !(await ctx.ui.confirm(
      "确认使用现有 SSH 登录执行只读主机检查？不会安装软件、修改服务或绕过主机密钥核验。",
    ))
  )
    return;
  const result = await checkSshHost(target, ctx.runner);
  for (const check of result.checks)
    ctx.ui.log(`[${check.status}] ${check.id}：${check.message}`);
  if (result.facts)
    ctx.ui.log(
      `主机架构：${result.facts.architecture}；TCP 监听端口：${result.facts.listeningPorts.join(", ") || "无"}`,
    );
  return result;
}

export async function exportTunnelToken(ctx: Context): Promise<void> {
  const token = current(ctx).cloudflareTunnelToken;
  if (!token) {
    ctx.ui.log("当前未载入 Tunnel 连接 Token，请先读取或手动输入。");
    return;
  }
  singleLine(token);
  const input = await ctx.ui.input("Tunnel Token 文件（项目内且被 Git 忽略）", {
    value: `.fulcord/aws/${ctx.env}/tunnel-token`,
  });
  const path = await localExportPath(ctx.root, input, ctx.runner);
  const previous = await readPrivate(path);
  if (
    !(await ctx.ui.confirm(
      "确认将 Tunnel Token 明文写入/覆盖所选文件，权限设为 600？请勿提交此文件。",
    ))
  )
    return;
  await writePrivate(path, `${token}\n`, previous ?? null);
  ctx.ui.log(
    "Tunnel Token 文件已写入，权限 600；内容不显示。复制到服务器时请保持私有权限。",
  );
}
