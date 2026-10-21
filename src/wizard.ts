import {
  allFields,
  name as resourceName,
  exportEntries,
  projectKey,
  repository,
  validateField,
  type Config,
  type Entry,
} from "./config.ts";
import { mergeEnv, parseEnv, readPrivate, writePrivate } from "./files.ts";
import { resolveEnvConflicts, unifiedEnvPath } from "./unified-env.ts";
import { ApiError, Cloudflare, Supabase, supabaseHealth } from "./providers.ts";
import {
  CommandUnavailableError,
  clipboard,
  githubSync,
  githubPages,
  localExportPath,
  openBrowser,
  run,
  type Runner,
} from "./process.ts";
import {
  acquireSupabaseToken,
  selectTokenProject,
  SupabaseTokenCancelled,
  tokenIdentity,
} from "./supabase-token.ts";
import { migrationSession } from "./migrations.ts";
import type { PagesEvidence } from "./setup-evidence.ts";
import { inspectPagesDeployment } from "./pages-status.ts";
import { CloudflareTunnels } from "./tunnels.ts";
import {
  configureTunnel,
  configureDeployment,
  showDeploymentPlan,
  checkDeploymentHost,
  exportTunnelToken,
} from "./deployment-wizard.ts";
import type { Values, VaultData } from "./vault.ts";
import {
  CliSupabase,
  machineJson,
  profileName,
  supabaseEnvironment,
  wranglerRun,
  wranglerSession,
} from "./official.ts";

type LoginStatus = {
  state: "未验证" | "已验证" | "验证失败";
  source: string;
  identity?: string;
  detail?: string;
};
type Runtime = {
  statuses: Record<string, LoginStatus>;
  officialCloudflareToken?: string;
  transientSupabaseToken?: string;
  pagesEvidence?: Record<string, PagesEvidence[]>;
  githubEnvironment?: Record<
    string,
    {
      repository: string;
      identity: string;
      variables?: string[];
      secrets?: string[];
    }
  >;
};

export type Choice = { name: string; value: string };
export type UI = {
  select: (message: string, choices: Choice[]) => Promise<string>;
  input: (
    message: string,
    options?: { value?: string; secret?: boolean },
  ) => Promise<string>;
  confirm: (message: string) => Promise<boolean>;
  check: (
    message: string,
    choices: Array<Choice & { checked?: boolean }>,
  ) => Promise<string[]>;
  log: (message: string) => void;
};
export type Context = {
  root: string;
  config: Config;
  env: string;
  data: VaultData;
  ui: UI;
  runner: Runner;
  fetcher?: typeof fetch;
  ensureSupabaseCli?: () => Promise<boolean>;
  deviceDirectory?: string;
  releaseDirectory?: string;
  save: () => Promise<void>;
  storageMode?: "metadata" | "memory" | "vault";
  vaultReferences?: Record<string, Values>;
  runtime?: Runtime;
};
function runtime(ctx: Context): Runtime {
  return (ctx.runtime ??= { statuses: {} });
}
function status(ctx: Context, provider: string, info: LoginStatus): void {
  runtime(ctx).statuses[`${ctx.env}/${provider}`] = info;
}
class ConnectionCancelled extends Error {}
async function connection(
  ctx: Context,
  action: (ctx: Context) => Promise<void>,
): Promise<void> {
  const before = structuredClone(ctx.data);
  const beforeRuntime = structuredClone(runtime(ctx));
  try {
    await action(ctx);
  } catch (error) {
    const message = safeMessage(error, ctx);
    ctx.data.credentials = before.credentials;
    ctx.data.profiles = before.profiles;
    ctx.runtime = beforeRuntime;
    if (
      error instanceof ConnectionCancelled ||
      error instanceof SupabaseTokenCancelled
    ) {
      ctx.ui.log("已取消切换，原账号与项目绑定保持不变。");
      return;
    }
    if (error instanceof Error && error.name === "ExitPromptError") throw error;
    // Provider causes can contain credentials; retain only the redacted message.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(message);
  }
}
export function values(ctx: Context): Values {
  const key = projectKey(ctx.config.project, ctx.env);
  return (ctx.data.profiles[key] ??= { ...ctx.config.defaults?.[ctx.env] });
}
export function safeMessage(error: unknown, ctx?: Context): string {
  let message = error instanceof Error ? error.message : "操作失败。";
  const secrets = [
    ctx?.runtime?.officialCloudflareToken,
    ctx?.runtime?.transientSupabaseToken,
    ...Object.values(ctx?.data.credentials ?? {}),
    ...Object.values(ctx?.data.profiles ?? {}).flatMap((profile) =>
      Object.entries(profile)
        .filter(([key]) => ctx && allFields(ctx.config)[key]?.secret)
        .map(([, value]) => value),
    ),
  ];
  for (const value of secrets)
    if (value) message = message.split(value).join("[已隐藏]");
  return message.replace(/[\x00-\x1f\x7f\x9b]/g, " ").slice(0, 1000);
}
function display(value: string): string {
  return value.replace(/[\x00-\x1f\x7f\x9b]/g, "").slice(0, 150);
}

async function browser(ctx: Context, url: string): Promise<void> {
  ctx.ui.log(url);
  if (await ctx.ui.confirm("在本机浏览器打开？远程终端可手动打开上方链接。")) {
    if (!(await openBrowser(url, ctx.runner)))
      ctx.ui.log("未能自动打开浏览器，请手动打开上方链接。");
  }
}
async function inputField(
  ctx: Context,
  field: string,
  suggestion?: string,
): Promise<string> {
  const definition = allFields(ctx.config)[field]!;
  while (true) {
    const value = await ctx.ui.input(definition.label, {
      secret: definition.secret,
      value: definition.secret ? undefined : (suggestion ?? values(ctx)[field]),
    });
    try {
      return validateField(ctx.config, field, value.trim());
    } catch (error) {
      ctx.ui.log(safeMessage(error, ctx));
    }
  }
}
async function credential(
  ctx: Context,
  provider: "cloudflare" | "supabase",
  options: {
    official?: boolean;
    defaultAlias?: string;
    purpose?: "tunnel";
  } = {},
): Promise<string> {
  const envName =
    provider === "cloudflare"
      ? "CLOUDFLARE_API_TOKEN"
      : "SUPABASE_ACCESS_TOKEN";
  const prefix = `${provider}/`;
  const aliases = Object.keys(ctx.data.credentials).filter((key) =>
    key.startsWith(prefix),
  );
  const selected = await ctx.ui.select(
    `${provider} 凭据来源（令牌值不会显示）`,
    [
      ...(provider === "supabase"
        ? [
            {
              name: `Supabase Management API / PAT（默认；无需 CLI，${ctx.storageMode === "vault" ? "保存到已启用保险库" : "仅本次内存"}）`,
              value: "new",
            },
          ]
        : []),
      ...(options.official === false
        ? []
        : [
            {
              name: `复用官方 ${provider === "cloudflare" ? "Wrangler" : "Supabase CLI"} 登录${provider === "cloudflare" ? "（默认）" : "（可选）"}`,
              value: "official",
            },
          ]),
      ...aliases.map((alias) => ({
        name: `${ctx.storageMode === "vault" ? "本机保险库" : "本次会话"}：${display(alias)}`,
        value: alias,
      })),
      ...(process.env[envName]
        ? [{ name: `当前进程环境变量 ${envName}`, value: "environment" }]
        : []),
      ...(provider === "cloudflare"
        ? [
            {
              name: `手动输入 Token（${ctx.storageMode === "vault" ? "保存到已启用保险库" : "仅本次内存"}）`,
              value: "new",
            },
          ]
        : []),
    ],
  );
  if (selected === "official") {
    if (
      provider === "supabase" &&
      ctx.ensureSupabaseCli &&
      !(await ctx.ensureSupabaseCli())
    )
      throw new ConnectionCancelled();
    const profile = profileName(
      await ctx.ui.input(
        "官方登录 profile（新账号建议使用新名称；同名重新登录影响引用它的项目）",
        { value: values(ctx)[`@${provider}Profile`] ?? "default" },
      ),
    );
    if (provider === "supabase") {
      let identity;
      try {
        identity = await new CliSupabase(
          profile,
          ctx.root,
          ctx.runner,
        ).identity();
      } catch (error) {
        if (error instanceof CommandUnavailableError) throw error;
        ctx.ui.log(safeMessage(error, ctx));
        ctx.ui.log(
          "需要 Supabase CLI >=2.120.0。官方登录使用系统凭据存储；不可用时可能回退官方明文文件。新账号请使用独立 profile。",
        );
        if (
          !(await ctx.ui.confirm(
            `运行官方 supabase login --profile ${profile}？`,
          ))
        )
          throw new ConnectionCancelled();
        await ctx.runner("supabase", ["login", "--profile", profile], {
          cwd: ctx.root,
          env: supabaseEnvironment(),
          inherit: true,
          timeout: 300_000,
        });
        identity = await new CliSupabase(
          profile,
          ctx.root,
          ctx.runner,
        ).identity();
      }
      Object.assign(values(ctx), {
        "@supabaseSource": "cli",
        "@supabaseProfile": profile,
        "@supabaseIdentity": identity.id,
        "@supabaseEmail": identity.email,
      });
      delete values(ctx)["@supabase"];
      status(ctx, "supabase", {
        state: "已验证",
        source: `官方 CLI / ${profile}`,
        identity: identity.email,
      });
      ctx.ui.log(
        `Supabase 已验证：${display(identity.email)}（${identity.id}），profile=${profile}；官方登录 Token 不复制到保险库。`,
      );
      return "";
    }
    let session;
    try {
      session = await wranglerSession(ctx.root, ctx.runner, profile);
    } catch (error) {
      if (error instanceof CommandUnavailableError) throw error;
      ctx.ui.log(safeMessage(error, ctx));
      ctx.ui.log(
        "官方 Wrangler 登录状态不可用。命名 profile 使用官方 auth create（需要支持该命令的版本）；存储由 Wrangler 管理。",
      );
      if (
        !(await ctx.ui.confirm(
          `登录/更新 Wrangler profile ${profile}？同名更新会影响引用它的项目。`,
        ))
      )
        throw new ConnectionCancelled();
      const args =
        profile === "default"
          ? [
              "login",
              ...((await ctx.ui.confirm(
                "使用系统钥匙串保存 Wrangler 登录？不可用时会停止，不自动回退。",
              ))
                ? ["--use-keyring"]
                : []),
            ]
          : ["auth", "create", profile];
      await wranglerRun(ctx.root, args, ctx.runner, {
        inherit: true,
        timeout: 300_000,
      });
      session = await wranglerSession(ctx.root, ctx.runner, profile);
    }
    runtime(ctx).officialCloudflareToken = session.token;
    Object.assign(values(ctx), {
      "@cloudflareSource": "wrangler",
      "@cloudflareProfile": profile,
      "@cloudflareIdentity": session.identity,
    });
    delete values(ctx)["@cloudflare"];
    delete values(ctx).cloudflareToken;
    status(ctx, "cloudflare", {
      state: "已验证",
      source: `官方 Wrangler / ${profile}`,
      identity: session.identity || "用户邮箱不可读，后续按 Account ID 验证",
    });
    ctx.ui.log(
      `Wrangler 已验证：${display(session.identity || "邮箱不可读")}；官方 OAuth Token 仅用于本次操作，不作为 CI Token 导出。`,
    );
    return session.token;
  }
  const acquiredSupabaseToken =
    provider === "supabase" && selected === "new"
      ? await acquireSupabaseToken(ctx.ui, ctx.runner, ctx.storageMode)
      : undefined;
  let alias = selected;
  if (selected === "new" || selected === "environment") {
    const aliasName = await ctx.ui.input(
      "账号别名（跨项目复用，例如 personal、work；同名将更新）",
      { value: options.defaultAlias ?? "personal" },
    );
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(aliasName))
      throw new Error("账号别名只能使用小写字母、数字、连字符。");
    alias = prefix + aliasName;
    if (ctx.data.credentials[alias]) {
      const references = Object.entries({
        ...ctx.vaultReferences,
        ...ctx.data.profiles,
      })
        .filter(([, profile]) =>
          [
            profile["@cloudflare"],
            profile["@cloudflareDeploy"],
            profile["@cloudflareTunnelManagement"],
            profile["@supabase"],
          ].includes(alias),
        )
        .map(([key]) => display(key));
      ctx.ui.log(
        `当前已加载配置中引用此别名的项目/环境：${references.join(", ") || "无"}。更新不会自动同步 GitHub Secrets。`,
      );
    }
    if (
      ctx.data.credentials[alias] &&
      !(await ctx.ui.confirm(`更新已有账号别名 ${alias} 的凭据？`))
    )
      throw new Error("已取消更新凭据。");
    let token = process.env[envName];
    if (selected === "new") {
      if (provider === "supabase") token = acquiredSupabaseToken;
      else {
        ctx.ui.log(
          options.purpose === "tunnel"
            ? "Tunnel 管理 API Token：仅目标账号的 Cloudflare Tunnel Edit，以及目标域的 Zone Read + DNS Edit。账号列表权限可选。该 Token 不作为容器连接 Token 或应用配置导出。"
            : "API Token：指定账号的 Cloudflare Pages Edit + Workers Scripts Edit；自动列出账号另需 Account Settings Read，也可手填 Account ID。",
        );
        await browser(ctx, "https://dash.cloudflare.com/profile/api-tokens");
        token = await ctx.ui.input(`${envName}（隐藏输入）`, { secret: true });
      }
    }
    if (!token || /[\x00-\x20\x7f]/.test(token) || token.length > 4096)
      throw new Error("令牌为空或格式无效。");
    ctx.data.credentials[alias] = token;
  }
  values(ctx)[`@${provider}`] = alias;
  values(ctx)[`@${provider}Source`] = "token";
  delete values(ctx)[`@${provider}Profile`];
  delete values(ctx)[`@${provider}Identity`];
  if (provider === "supabase") {
    delete values(ctx)["@supabaseIdentityMode"];
    delete values(ctx)["@supabaseOrganization"];
  }
  status(ctx, provider, {
    state: "未验证",
    source: `${selected === "environment" ? "环境变量" : "手动/保险库 Token"} / ${alias}`,
  });
  return ctx.data.credentials[alias]!;
}
function activeCredential(
  ctx: Context,
  provider: "cloudflare" | "supabase",
): string | undefined {
  const alias = values(ctx)[`@${provider}`];
  return (
    (alias ? ctx.data.credentials[alias] : undefined) ??
    (provider === "cloudflare" ? values(ctx).cloudflareToken : undefined)
  );
}
async function cloudflareToken(ctx: Context): Promise<string> {
  if (values(ctx)["@cloudflareSource"] === "wrangler") {
    const session = await wranglerSession(
      ctx.root,
      ctx.runner,
      values(ctx)["@cloudflareProfile"] ?? "default",
      values(ctx)["@cloudflareIdentity"],
      values(ctx).cloudflareAccountId,
    );
    runtime(ctx).officialCloudflareToken = session.token;
    status(ctx, "cloudflare", {
      state: "已验证",
      source: `官方 Wrangler / ${values(ctx)["@cloudflareProfile"]}`,
      identity: session.identity || "Account ID 已验证",
    });
    return session.token;
  }
  const token = activeCredential(ctx, "cloudflare");
  if (!token)
    throw new Error(
      "请先连接 Cloudflare 账号，选择官方 profile 或载入 Token；不会自动改变现有账号绑定。",
    );
  return token;
}
async function cloudflareClient(ctx: Context): Promise<Cloudflare> {
  return new Cloudflare(await cloudflareToken(ctx), ctx.fetcher);
}
async function tunnelClient(ctx: Context): Promise<CloudflareTunnels> {
  const alias = values(ctx)["@cloudflareTunnelManagement"];
  if (alias) {
    const token = ctx.data.credentials[alias];
    if (!token)
      throw new Error(
        "请解锁保险库或重新配置 Tunnel 管理 Token；不会改用其他凭据。",
      );
    return new CloudflareTunnels(token, ctx.fetcher);
  }
  ctx.ui.log(
    "将使用现有 Cloudflare 登录。若 DNS 返回 403，请配置专用 Tunnel 管理 API Token（Tunnel Edit、Zone Read、DNS Edit）。",
  );
  return new CloudflareTunnels(await cloudflareToken(ctx), ctx.fetcher);
}
async function tunnelManagementCredential(ctx: Context): Promise<void> {
  const before = { ...values(ctx) };
  const statuses = structuredClone(runtime(ctx).statuses);
  if (!before.cloudflareAccountId)
    throw new Error("请先绑定 Cloudflare Account ID。");
  const token = await credential(ctx, "cloudflare", {
    official: false,
    purpose: "tunnel",
    defaultAlias: `tunnel-${ctx.config.project}-${ctx.env}`.slice(0, 41),
  });
  const alias = values(ctx)["@cloudflare"]!;
  const client = new CloudflareTunnels(token, ctx.fetcher);
  const zoneId =
    before.cloudflareZoneId ??
    (await ctx.ui.input("目标 Zone ID（仅核验此区域）")).trim();
  const zone = await client.zone(before.cloudflareAccountId, zoneId);
  const hostname = before.appOrigin && new URL(before.appOrigin).hostname;
  const dnsHostname =
    hostname && (hostname === zone.name || hostname.endsWith(`.${zone.name}`))
      ? hostname
      : zone.name;
  await client.dnsRecords(before.cloudflareAccountId, zoneId, dnsHostname);
  await client.tunnels(before.cloudflareAccountId);
  ctx.data.profiles[projectKey(ctx.config.project, ctx.env)] = {
    ...before,
    cloudflareZoneId: zoneId,
    "@cloudflareTunnelManagement": alias,
  };
  runtime(ctx).statuses = statuses;
  ctx.ui.log(
    "Tunnel 管理 Token 已验证读取权限并绑定；写入权限在具体操作时核验，官方登录与 CI Token 绑定保留。",
  );
}
async function supabaseClient(ctx: Context): Promise<Supabase> {
  if (values(ctx)["@supabaseSource"] === "cli") {
    await officialSupabase(ctx).identity();
    const choice = await ctx.ui.select(
      "Auth 的细粒度 API 更新需要 PAT；官方 CLI 当前不能只推送这两个字段",
      [
        { name: "返回，使用官方项目页面配置", value: "back" },
        {
          name: "本次临时输入 PAT（不保存，验证与绑定账号相同）",
          value: "token",
        },
      ],
    );
    if (choice === "back") throw new ConnectionCancelled();
    const token = await acquireSupabaseToken(ctx.ui, ctx.runner);
    runtime(ctx).transientSupabaseToken = token;
    const client = new Supabase(token, ctx.fetcher);
    const identity = await tokenIdentity(client, token);
    if (!identity)
      throw new Error(
        "此操作需验证与官方 profile 同一用户，当前 scoped PAT 无法读取用户身份；请返回 Supabase 连接，选择 API/PAT 并明确确认改为资源范围绑定后重试 Auth。原绑定与 Auth 设置保持不变。",
      );
    if (identity.id !== values(ctx)["@supabaseIdentity"])
      throw new Error(
        "本次 PAT 与绑定的 Supabase 账号不同；未修改 Auth 设置。",
      );
    runtime(ctx).transientSupabaseToken = token;
    return client;
  }
  const token = activeCredential(ctx, "supabase");
  if (!token)
    throw new Error(
      "请先连接 Supabase 账号，选择官方 profile 或载入 PAT；不会自动改变现有账号绑定。",
    );
  const client = new Supabase(token, ctx.fetcher);
  if (values(ctx)["@supabaseIdentityMode"] === "resource") {
    const ref = values(ctx).supabaseProjectRef;
    const organization = values(ctx)["@supabaseOrganization"];
    if (!ref || !organization)
      throw new Error(
        "限定范围 PAT 缺少已验证的组织/Project Ref，请重新连接。",
      );
    const project = await client.project(ref);
    if (project.organization_id !== organization)
      throw new Error("Supabase 项目组织与绑定不一致，请显式重新连接。");
    return client;
  }
  const identity = await client.identity();
  if (
    values(ctx)["@supabaseIdentity"] &&
    values(ctx)["@supabaseIdentity"] !== identity.id
  )
    throw new Error(
      "Supabase Token 的账号身份与项目绑定不同；请显式重新连接。",
    );
  return client;
}
function officialSupabase(ctx: Context): CliSupabase {
  if (!values(ctx)["@supabaseIdentity"])
    throw new Error("请先连接 Supabase 官方 profile，并确认账号身份与项目。");
  return new CliSupabase(
    values(ctx)["@supabaseProfile"] ?? "default",
    ctx.root,
    ctx.runner,
    values(ctx)["@supabaseIdentity"],
  );
}
async function deploymentCredential(ctx: Context): Promise<void> {
  const current = { ...values(ctx) };
  const beforeStatuses = structuredClone(runtime(ctx).statuses);
  if (!current.cloudflareAccountId || !current.pagesProject)
    throw new Error("请先连接 Cloudflare 账号并读取/创建 Pages 项目。");
  const token = await credential(ctx, "cloudflare", {
    official: false,
    defaultAlias: `ci-${ctx.config.project}-${ctx.env}`.slice(0, 41),
  });
  const alias = values(ctx)["@cloudflare"]!;
  const project = await new Cloudflare(token, ctx.fetcher).pagesProject(
    current.cloudflareAccountId,
    current.pagesProject,
  );
  if (!project)
    throw new Error("CI Token 无法读取目标 Pages 项目；请检查账号范围与权限。");
  ctx.data.profiles[projectKey(ctx.config.project, ctx.env)] = {
    ...current,
    "@cloudflareDeploy": alias,
  };
  runtime(ctx).statuses = beforeStatuses;
  ctx.ui.log(
    "CI 部署 Token 已单独配置并验证目标 Pages 读取权限；实际部署写权限由部署脚本验证。官方登录绑定保持不变。",
  );
}
async function ensurePublishableKey(ctx: Context): Promise<void> {
  const ref = values(ctx).supabaseProjectRef;
  const official = values(ctx)["@supabaseSource"] === "cli";
  if (
    ref &&
    (official ||
      (!values(ctx).supabasePublishableKey &&
        activeCredential(ctx, "supabase")))
  ) {
    if (
      values(ctx).supabaseUrl &&
      values(ctx).supabaseUrl !== `https://${ref}.supabase.co`
    )
      throw new Error(
        "Supabase URL 与绑定的 Project Ref 不一致，请重新连接目标项目；未导出配置。",
      );
    const key = validateField(
      ctx.config,
      "supabasePublishableKey",
      await (
        official ? officialSupabase(ctx) : await supabaseClient(ctx)
      ).publishableKey(ref),
    );
    if (
      values(ctx).supabasePublishableKey &&
      values(ctx).supabasePublishableKey !== key
    )
      throw new Error(
        "本次输入的 Key 与官方 profile 读取的项目 Key 不一致，请重新读取项目配置；未导出。",
      );
    values(ctx).supabasePublishableKey = key;
  }
}
async function refreshLogin(ctx: Context, progress = false): Promise<void> {
  for (const provider of ["cloudflare", "supabase", "github"]) {
    if (progress) ctx.ui.log(`正在验证 ${provider} 登录…`);
    if (provider === "github") delete runtime(ctx).githubEnvironment?.[ctx.env];
    try {
      if (provider === "cloudflare") {
        if (values(ctx)["@cloudflareSource"] === "wrangler")
          await cloudflareClient(ctx);
        else if (
          values(ctx).cloudflareAccountId &&
          activeCredential(ctx, "cloudflare")
        ) {
          const client = await cloudflareClient(ctx);
          if (!values(ctx).pagesProject) {
            status(ctx, provider, {
              state: "未验证",
              source: "手动/保险库 Token 已载入",
              detail:
                "尚未核验目标资源权限；可在所需 Pages 或 Tunnel 操作中验证，不要求创建 Pages。",
            });
            continue;
          }
          if (
            !(await client.pagesProject(
              values(ctx).cloudflareAccountId!,
              values(ctx).pagesProject!,
            ))
          )
            throw new Error(
              "请先连接账号并选择 Pages 项目，才能验证此 Token 的目标权限。",
            );
          status(ctx, provider, {
            state: "已验证",
            source: "手动/保险库 Token",
            identity: values(ctx).cloudflareAccountId,
          });
        } else
          status(ctx, provider, {
            state: "未验证",
            source: "未绑定官方 profile 或 Token",
          });
      } else if (provider === "supabase") {
        if (values(ctx)["@supabaseSource"] === "cli") {
          const user = await officialSupabase(ctx).identity();
          if (values(ctx).supabaseProjectRef) await ensurePublishableKey(ctx);
          status(ctx, provider, {
            state: "已验证",
            source: `官方 CLI / ${values(ctx)["@supabaseProfile"]}`,
            identity: user.email,
          });
        } else if (activeCredential(ctx, "supabase")) {
          const client = await supabaseClient(ctx);
          const user =
            values(ctx)["@supabaseIdentityMode"] === "resource"
              ? undefined
              : await client.identity();
          if (values(ctx).supabaseProjectRef) await ensurePublishableKey(ctx);
          status(ctx, provider, {
            state: "已验证",
            source: "手动/保险库 PAT",
            identity:
              user?.email ??
              `限定项目 ${values(ctx).supabaseProjectRef}（用户身份不可读）`,
          });
        } else
          status(ctx, provider, {
            state: "未验证",
            source: "未绑定官方 profile 或 PAT",
          });
      } else {
        const user = await githubIdentity(ctx);
        const repo = values(ctx)["@repository"];
        let incomplete = false;
        if (repo && values(ctx)["@githubIdentity"]) {
          if (progress)
            ctx.ui.log(
              `正在检查 GitHub ${repo} / ${ctx.env} 的 Variable / Secret 名称（不读取 Secret 值）…`,
            );
          const [variables, secrets] = await Promise.allSettled([
            githubPages(
              `repos/${repo}/environments/${ctx.env}/variables`,
              "variables",
              ctx.runner,
            ),
            githubPages(
              `repos/${repo}/environments/${ctx.env}/secrets`,
              "secrets",
              ctx.runner,
            ),
          ]);
          const after = await githubIdentity(ctx);
          if (after.id !== user.id || values(ctx)["@repository"] !== repo)
            throw new Error(
              "GitHub 身份或仓库在读取期间变化，已丢弃云端状态。",
            );
          const snapshots = (runtime(ctx).githubEnvironment ??= {});
          snapshots[ctx.env] = {
            repository: repo,
            identity: String(user.id),
            variables:
              variables.status === "fulfilled"
                ? variables.value.map((entry) => entry.name)
                : undefined,
            secrets:
              secrets.status === "fulfilled"
                ? secrets.value.map((entry) => entry.name)
                : undefined,
          };
          incomplete =
            variables.status !== "fulfilled" || secrets.status !== "fulfilled";
        }
        status(ctx, provider, {
          state: "已验证",
          source: "官方 gh",
          identity: user.login,
          ...(incomplete
            ? {
                detail:
                  "部分 Environment 元数据查询失败；对应云端配置状态未知，请检查网络与权限。",
              }
            : {}),
        });
      }
    } catch (error) {
      status(ctx, provider, {
        state: "验证失败",
        source: "CLI/Token",
        detail: safeMessage(error, ctx),
      });
    }
  }
}
function loginLines(ctx: Context): string[] {
  return ["cloudflare", "supabase", "github"].map((provider) => {
    const current = runtime(ctx).statuses[`${ctx.env}/${provider}`] ?? {
      state: "未验证",
      source: values(ctx)[`@${provider}Profile`]
        ? `官方 profile / ${values(ctx)[`@${provider}Profile`]}`
        : "尚未连接",
    };
    return `${provider}: ${current.state} | ${current.source}${current.identity ? ` | ${display(current.identity)}` : ""}${current.detail ? ` | ${current.detail}` : ""}`;
  });
}
function showLogin(ctx: Context): void {
  for (const line of loginLines(ctx)) ctx.ui.log(line);
}
function configLines(ctx: Context): string[] {
  const targets = { ...ctx.config.variables };
  for (const field of Object.values(ctx.config.jsonExport ?? {}))
    targets[field] ??= field;
  return Object.entries(targets).map(([field, target]) => {
    const value =
      field === "cloudflareToken"
        ? (ctx.data.credentials[values(ctx)["@cloudflareDeploy"] ?? ""] ??
          activeCredential(ctx, "cloudflare") ??
          values(ctx)[field])
        : values(ctx)[field];
    if (value)
      return `${target}: ${allFields(ctx.config)[field]!.secret ? "本机已载入（值已隐藏）" : display(value)}`;
    const cloud = runtime(ctx).githubEnvironment?.[ctx.env];
    if (
      cloud &&
      cloud.repository === values(ctx)["@repository"] &&
      cloud.identity === values(ctx)["@githubIdentity"]
    ) {
      if (cloud.secrets?.includes(target))
        return `${target}: GitHub ${ctx.env}：已配置（Secret，值不可读取；本机未载入）`;
      if (cloud.variables?.includes(target))
        return `${target}: GitHub ${ctx.env}：已配置（Variable，本机未载入）`;
      if (
        cloud.variables &&
        cloud.secrets &&
        Object.hasOwn(ctx.config.variables, field)
      )
        return `${target}: 本机未载入；GitHub ${ctx.env}：未配置（仅检查 Environment 级）`;
    }
    return `${target}: 本机未载入（云端未检查或无法检查）`;
  });
}
async function showStatus(ctx: Context): Promise<void> {
  while (true) {
    delete runtime(ctx).githubEnvironment?.[ctx.env];
    // Show local values before a CLI/network check can delay the result. Keep
    // the final snapshot inside the prompt so menu rendering cannot hide it.
    ctx.ui.log(`\n${ctx.config.project} / ${ctx.env} — 本机配置（隐藏凭据）`);
    for (const line of configLines(ctx)) ctx.ui.log(line);
    await refreshLogin(ctx, true);
    const action = await ctx.ui.select(
      [
        `${ctx.config.project} / ${ctx.env} — 配置状态（隐藏凭据）`,
        ...loginLines(ctx),
        "",
        ...configLines(ctx),
        "",
        "本机未载入不代表云端未配置；Secret 仅核对名称，值不可读取。隐藏不代表本机已加密保存。",
      ].join("\n"),
      [
        { name: "返回上一级", value: "back" },
        { name: "刷新登录验证", value: "refresh" },
      ],
    );
    if (action !== "refresh") return;
  }
}
async function githubIdentity(
  ctx: Context,
): Promise<{ id: number; login: string }> {
  const user = machineJson<{ id: number; login: string }>(
    await ctx.runner("gh", ["api", "--hostname", "github.com", "user"]),
  );
  if (
    !Number.isSafeInteger(user.id) ||
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(user.login)
  )
    throw new Error("GitHub CLI 身份响应无效。");
  if (
    values(ctx)["@githubIdentity"] &&
    String(user.id) !== values(ctx)["@githubIdentity"]
  )
    throw new Error(
      "GitHub 当前登录身份与项目绑定不同，请通过“连接 GitHub”重新绑定。",
    );
  return user;
}

async function cloudflareAccount(ctx: Context): Promise<void> {
  const previousProfile = { ...values(ctx) };
  const client = new Cloudflare(
    await credential(ctx, "cloudflare"),
    ctx.fetcher,
  );
  let accounts: Array<{ id: string; name: string }> = [];
  try {
    accounts = await client.accounts();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403) throw error;
    ctx.ui.log(
      "无法列出账号，可手填 Account ID；后续 Pages 请求将检查实际权限。",
    );
  }
  const selected = await ctx.ui.select("选择 Cloudflare 账号", [
    ...accounts.map((account) => ({
      name: `${display(account.name)} (${display(account.id)})`,
      value: account.id,
    })),
    { name: "手动输入 Account ID", value: "manual" },
  ]);
  const nextAccount =
    selected === "manual"
      ? await inputField(ctx, "cloudflareAccountId")
      : validateField(ctx.config, "cloudflareAccountId", selected);
  if (
    previousProfile["@cloudflareIdentity"] &&
    previousProfile["@cloudflareIdentity"] !==
      values(ctx)["@cloudflareIdentity"] &&
    !(await ctx.ui.confirm(
      `当前凭据身份已从 ${display(previousProfile["@cloudflareIdentity"]!)} 变化；确认将当前环境绑定到新凭据与账号 ${nextAccount}？`,
    ))
  )
    throw new ConnectionCancelled();
  if (
    previousProfile.cloudflareAccountId &&
    previousProfile.cloudflareAccountId !== nextAccount
  ) {
    if (
      !(await ctx.ui.confirm(
        `切换到账号 ${nextAccount}？将清除当前环境旧的 Pages、Worker 和 Origin 配置，需要重新选择资源。`,
      ))
    ) {
      ctx.data.profiles[projectKey(ctx.config.project, ctx.env)] =
        previousProfile;
      throw new ConnectionCancelled();
    }
    for (const key of [
      "pagesProject",
      "workerName",
      "appOrigin",
      "siteOrigin",
      "cloudflareToken",
      "cloudflareZoneId",
      "cloudflareTunnelId",
      "cloudflareTunnelToken",
      "@cloudflareTunnelManagement",
      ...(ctx.config.setup?.components ?? [])
        .filter((component) => ["pages", "worker"].includes(component.hosting))
        .flatMap((component) => [
          component.projectField,
          component.originField,
          component.branchField,
        ])
        .filter((field): field is string => field !== undefined),
    ])
      delete values(ctx)[key];
  }
  values(ctx).cloudflareAccountId = nextAccount;
  status(ctx, "cloudflare", {
    state:
      values(ctx)["@cloudflareSource"] === "wrangler" ? "已验证" : "未验证",
    source:
      values(ctx)["@cloudflareSource"] === "wrangler"
        ? `官方 Wrangler / ${values(ctx)["@cloudflareProfile"]}`
        : "手动 Token（目标资源权限将在访问时验证）",
    identity: values(ctx)["@cloudflareIdentity"] || nextAccount,
  });
}
async function pages(ctx: Context): Promise<void> {
  const account = values(ctx).cloudflareAccountId;
  if (!account) throw new Error("请先选择 Cloudflare 账号。");
  const components =
    ctx.config.setup?.components?.filter(
      (item) =>
        item.hosting === "pages" && item.projectField && item.originField,
    ) ?? [];
  const selected = components.length
    ? await ctx.ui.select("选择要配置的 Pages 组件", [
        ...components.map((item) => ({
          name: item.title,
          value: `component:${item.id}`,
        })),
        { name: "返回", value: "back" },
      ])
    : undefined;
  if (selected === "back") return;
  const component = components.find(
    (item) => `component:${item.id}` === selected,
  );
  const projectField = component?.projectField ?? "pagesProject";
  const originField = component?.originField ?? "siteOrigin";
  const previousEvidence = runtime(ctx).pagesEvidence?.[ctx.env];
  if (previousEvidence) {
    const remaining = previousEvidence.filter(
      (item) => item.projectField !== projectField,
    );
    if (remaining.length) runtime(ctx).pagesEvidence![ctx.env] = remaining;
    else delete runtime(ctx).pagesEvidence![ctx.env];
  }
  const client = await cloudflareClient(ctx);
  const name = await inputField(
    ctx,
    projectField,
    values(ctx)[projectField] ??
      `${ctx.config.project.slice(0, 62 - (component?.id ?? "web").length)}-${component?.id ?? "web"}`,
  );
  if (!resourceName(name))
    throw new Error("Pages 项目名称必须为 2–63 位小写字母、数字和连字符。");
  const shared = components.find(
    (item) =>
      item.id !== component?.id && values(ctx)[item.projectField!] === name,
  );
  if (
    shared &&
    !(await ctx.ui.confirm(
      `此 Pages 项目已绑定${shared.title}，不同组件发布可能相互覆盖。仍要复用 ${name}？`,
    ))
  )
    return;
  let project = await client.pagesProject(account, name);
  if (!project) {
    if (
      !(await ctx.ui.confirm(
        `在账号 ${account} 创建 Direct Upload Pages 项目 ${name}，production branch = main？`,
      ))
    )
      return;
    project = await client.createPages(account, name);
  }
  if (project.name !== name)
    throw new Error("返回的 Pages 项目与目标名称不同，未保存绑定。");
  if (project.source)
    ctx.ui.log("现有项目使用 Git 构建；保留该构建方式，仅检查部署记录。");
  const branch = (
    await ctx.ui.input("待核验的真实部署分支（请对照项目部署脚本或控制台）", {
      value:
        component?.branchField && values(ctx)[component.branchField]
          ? values(ctx)[component.branchField]
          : ctx.env === "production"
            ? project.production_branch
            : ctx.env,
    })
  ).trim();
  if (!branch || branch.length > 255 || /[\x00-\x1f\x7f]/.test(branch))
    throw new Error("请输入有效的 Pages 部署分支。");
  const evidence = await inspectPagesDeployment(client, account, name, {
    branch,
    environment:
      branch === project.production_branch ? "production" : "preview",
  });
  values(ctx)[projectField] = name;
  if (component?.branchField) values(ctx)[component.branchField] = branch;
  const snapshots = (runtime(ctx).pagesEvidence ??= {});
  snapshots[ctx.env] = [
    ...(snapshots[ctx.env] ?? []).filter(
      (item) => item.projectField !== projectField,
    ),
    {
      account,
      project: name,
      projectField,
      branch,
      status: evidence.status,
      message: evidence.message,
      checkedAt: new Date().toISOString(),
    },
  ];
  ctx.ui.log(`Pages / ${name} / ${branch}：${evidence.message}`);
  if (evidence.status === "deployed" && evidence.deployment) {
    const url = evidence.deployment.url;
    ctx.ui.log(`API 确认的部署 URL：${url}`);
    if (
      values(ctx)[originField] !== url &&
      (await ctx.ui.confirm(
        `将真实部署 URL ${url} 保存为${allFields(ctx.config)[originField]!.label}？已有自定义域名默认保留；请另行核验 DNS、Access 和应用访问。`,
      ))
    )
      values(ctx)[originField] = validateField(ctx.config, originField, url);
  }
  ctx.ui.log(
    "资源存在、API 发布状态与实际访问是不同证据；认证、Access 和业务功能仍需独立验证。未生成预测地址，也未自动覆盖应用入口。",
  );
}
async function worker(ctx: Context): Promise<void> {
  const workerName = await inputField(
    ctx,
    "workerName",
    values(ctx).workerName ?? `${ctx.config.project}-app-${ctx.env}`,
  );
  let suggestion = values(ctx).appOrigin;
  const account = values(ctx).cloudflareAccountId;
  if (!suggestion && account) {
    try {
      const subdomain = await (
        await cloudflareClient(ctx)
      ).workerSubdomain(account);
      if (subdomain)
        suggestion = `https://${workerName}.${subdomain}.workers.dev`;
    } catch {
      ctx.ui.log(
        "无法读取 Workers 子域名，请从控制台填写 Origin；使用自定义域名的项目直接填写该域名。",
      );
    }
  }
  const origin = await inputField(ctx, "appOrigin", suggestion);
  values(ctx).workerName = workerName;
  values(ctx).appOrigin = origin;
  ctx.ui.log(
    "已记录 Worker 名称与 Origin。发布业务代码仍由项目的部署脚本完成。",
  );
}
async function selectSupabase(ctx: Context): Promise<void> {
  const previousProfile = { ...values(ctx) };
  const token = await credential(ctx, "supabase");
  const client =
    values(ctx)["@supabaseSource"] === "cli"
      ? officialSupabase(ctx)
      : new Supabase(token, ctx.fetcher);
  const official = values(ctx)["@supabaseSource"] === "cli";
  const identity = official
    ? await client.identity()
    : await tokenIdentity(client as Supabase, token);
  ctx.ui.log(
    identity
      ? `当前 Supabase 身份：${display(identity.email)}（${identity.id}）。`
      : "此 scoped PAT 无法读取用户身份；将验证并固定组织/Project Ref 资源范围。",
  );
  const project = await selectTokenProject(client, ctx.ui, display);
  const ref = project.id;
  if (!identity && client instanceof Supabase) {
    const verifiedProject = await client.project(ref);
    if (verifiedProject.organization_id !== project.organization_id)
      throw new Error("Supabase 项目组织与所选组织不一致，未更改绑定。");
  }
  const key = await client.publishableKey(ref);
  const previous = previousProfile.supabaseProjectRef;
  if (
    ((previous && previous !== ref) ||
      (previousProfile["@supabaseIdentity"] &&
        previousProfile["@supabaseIdentity"] !== identity?.id) ||
      (previousProfile["@supabaseIdentityMode"] === "resource" &&
        (!!identity ||
          previousProfile["@supabaseOrganization"] !==
            project.organization_id))) &&
    !(await ctx.ui.confirm(
      `将当前环境从 Supabase ${previous ?? "未绑定"} 切换到 ${ref}，${identity ? `账号 ${display(identity.email)}（${identity.id}）` : `组织 ${display(project.organization_id)}（用户身份不可读，改用资源范围绑定）`}？`,
    ))
  )
    throw new ConnectionCancelled();
  if (previous !== ref) {
    delete values(ctx).supabaseCleanupKey;
    values(ctx).cleanupEnabled = "false";
    values(ctx).syntheticFilesEnabled = "false";
  }
  if (identity) {
    Object.assign(values(ctx), {
      "@supabaseIdentity": identity.id,
      "@supabaseEmail": identity.email,
    });
    delete values(ctx)["@supabaseIdentityMode"];
    delete values(ctx)["@supabaseOrganization"];
  } else {
    Object.assign(values(ctx), {
      "@supabaseIdentityMode": "resource",
      "@supabaseOrganization": project.organization_id,
    });
    delete values(ctx)["@supabaseIdentity"];
    delete values(ctx)["@supabaseEmail"];
  }
  values(ctx).supabaseProjectRef = validateField(
    ctx.config,
    "supabaseProjectRef",
    ref,
  );
  values(ctx).supabaseUrl = validateField(
    ctx.config,
    "supabaseUrl",
    `https://${ref}.supabase.co`,
  );
  values(ctx).supabasePublishableKey = validateField(
    ctx.config,
    "supabasePublishableKey",
    key,
  );
  status(ctx, "supabase", {
    state: "已验证",
    source:
      values(ctx)["@supabaseSource"] === "cli"
        ? `官方 CLI / ${values(ctx)["@supabaseProfile"]}`
        : "手动/保险库 PAT",
    identity: identity?.email ?? `限定项目 ${ref}（用户身份不可读）`,
  });
  ctx.ui.log(
    "已读取 URL 和 Publishable Key。Management API 可用不代表项目网关可用；暂停项目需先在控制台恢复。项目状态不能证明数据库迁移已执行或组织额度充足。",
  );
}
async function authOrigins(ctx: Context): Promise<void> {
  const ref = values(ctx).supabaseProjectRef;
  const origin = values(ctx).appOrigin;
  if (!ref || !origin)
    throw new Error("请先选择 Supabase 项目并配置应用 Origin。");
  if (
    values(ctx)["@supabaseSource"] === "cli" &&
    (await ctx.ui.confirm(
      "使用官方项目页面配置 Auth URL？选择否可临时输入 PAT 自动更新两个字段。",
    ))
  ) {
    ctx.ui.log(
      `项目 ${ref}：Site URL = ${origin}；Redirect URL = ${origin}/**。`,
    );
    await browser(
      ctx,
      `https://supabase.com/dashboard/project/${ref}/auth/url-configuration`,
    );
    return;
  }
  const client = await supabaseClient(ctx);
  const old = await client.authOrigins(ref);
  const allow = [
    ...new Set([
      ...old.uri_allow_list
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      `${origin}/**`,
    ]),
  ].join(",");
  ctx.ui.log(
    `项目 ${ref}：Site URL ${display(old.site_url)} → ${origin}；追加 Redirect URL ${origin}/**，保留已有回调地址。`,
  );
  if (
    await ctx.ui.confirm(
      "应用以上 Auth URL 设置？一个 Supabase 项目只有一个 Site URL，应为每个环境使用独立项目。",
    )
  ) {
    await client.setAuthOrigins(ref, origin, allow);
    ctx.ui.log("Auth URL 已更新。");
  } else ctx.ui.log("已取消 Auth URL 更新，远端设置保持不变。");
}
export type MigrationReleaseResult = {
  state: "applied" | "up-to-date";
  ref: string;
  files: string[];
};
export async function releaseMigrations(
  ctx: Context,
  expectedCommit?: string,
): Promise<MigrationReleaseResult | undefined> {
  try {
    return await migrations(ctx, true, expectedCommit);
  } catch (error) {
    if (
      error instanceof Error &&
      ["ExitPromptError", "AbortPromptError"].includes(error.name)
    ) {
      ctx.ui.log("已取消迁移发布步骤；不会继续发布应用。");
      return;
    }
    throw error;
  }
}
async function migrations(
  ctx: Context,
  release = false,
  expectedCommit?: string,
): Promise<MigrationReleaseResult | undefined> {
  const ref = values(ctx).supabaseProjectRef;
  if (!ref) throw new Error("请先选择 Supabase 项目。");
  if (ctx.config.migrationStrategy !== "supabase-cli")
    throw new Error(
      ctx.config.migrationStrategy === "project-managed"
        ? "本项目使用自己的迁移流程与账本；请按项目文档执行，不运行官方 CLI，不自动 repair 或补写历史。"
        : "项目映射尚未明确 migrationStrategy；请先按项目既有账本声明策略，再运行迁移。未安装 CLI 或连接数据库。",
    );
  if (ctx.ensureSupabaseCli && !(await ctx.ensureSupabaseCli())) {
    ctx.ui.log("已取消迁移，未请求数据库密码或连接数据库。");
    return;
  }
  const official = values(ctx)["@supabaseSource"] === "cli";
  if (official) await officialSupabase(ctx).identity();
  const token = official ? undefined : activeCredential(ctx, "supabase");
  if (!official && !token)
    throw new Error(
      "请先连接 Supabase 账号并确认项目；本次迁移不自动重绑定账号。",
    );
  if (!official) await supabaseClient(ctx);
  const resourceOrganization =
    !official && values(ctx)["@supabaseIdentityMode"] === "resource"
      ? values(ctx)["@supabaseOrganization"]
      : undefined;
  const verifyResource = resourceOrganization
    ? async () => {
        const project = await new Supabase(token!, ctx.fetcher).project(ref);
        if (project.organization_id !== resourceOrganization)
          throw new Error("迁移目标项目组织与绑定不同；未执行数据库操作。");
      }
    : undefined;
  const password = await ctx.ui.input(
    "数据库密码（仅本次内存使用，不保存、不导出）",
    { secret: true },
  );
  if (!password) {
    ctx.ui.log("已取消迁移，未连接数据库。");
    return;
  }
  if (/[\r\n\x00]/.test(password)) throw new Error("数据库密码格式无效。");
  ctx.ui.log(
    `目标：${ctx.config.project}/${ctx.env} → ${ref}。官方 CLI 将使用独立临时目录，不改动本地 Supabase 链接。`,
  );
  if (!(await ctx.ui.confirm("确认目标项目并执行数据库迁移预演？"))) return;
  const session = await migrationSession(
    ctx.root,
    ref,
    token,
    password,
    ctx.runner,
    official
      ? {
          profile: values(ctx)["@supabaseProfile"]!,
          identity: values(ctx)["@supabaseIdentity"]!,
        }
      : undefined,
    verifyResource,
    expectedCommit,
  );
  try {
    ctx.ui.log(
      expectedCommit
        ? `已从 CI 提交 ${expectedCommit} 冻结迁移快照：${session.files.join(", ")}`
        : `已冻结本地迁移快照：${session.files.join(", ")}`,
    );
    const pending = await session.preview();
    ctx.ui.log(
      `CLI 预演成功，输出识别到的待执行文件：${pending.join(", ") || "无（未识别到文件名时请用官方 CLI 核对历史）"}。请审阅本地 SQL；工具不会自动判断其破坏性。`,
    );
    if (!pending.length) {
      if (release && session.upToDate) {
        ctx.ui.log("官方 CLI 已明确确认远端数据库迁移已是最新；无需重复应用。");
        return { state: "up-to-date", ref, files: [] };
      }
      if (release)
        throw new Error(
          "无法确认数据库迁移状态：CLI 输出未识别到待执行文件，也未明确确认 up-to-date；已阻止后续应用发布，请按官方 CLI 核对账本。",
        );
      ctx.ui.log("没有可审阅的待执行文件清单，本次不应用迁移。");
      return;
    }
    if (ctx.env === "production")
      ctx.ui.log("当前为 production；下面的确认会实际修改生产数据库。");
    const answer = await ctx.ui.input(
      `如需应用迁移，完整输入目标 Project Ref ${ref}；直接回车只保留预演`,
    );
    if (answer !== ref) {
      ctx.ui.log("未执行迁移。");
      return;
    }
    if (release) {
      try {
        await session.apply();
        await session.preview();
        if (!session.upToDate) throw new Error("post-apply status unconfirmed");
      } catch {
        throw new Error(
          "迁移可能已应用，但应用后的复验未能明确确认 up-to-date；已阻止后续应用发布。未回滚数据库，也未执行 reset、repair 或 down，请核对远端迁移账本后重试。",
        );
      }
      ctx.ui.log(
        "官方 CLI db push 已完成且复验为 up-to-date；迁移历史由 Supabase CLI 管理。",
      );
      return { state: "applied", ref, files: pending };
    }
    await session.apply();
    ctx.ui.log("官方 CLI db push 已完成，迁移历史由 Supabase CLI 管理。");
  } finally {
    await session.close();
  }
}

async function selectedEntries(
  ctx: Context,
  allowed?: string[],
): Promise<Entry[]> {
  const profile = { ...values(ctx) };
  const cfToken =
    ctx.data.credentials[values(ctx)["@cloudflareDeploy"] ?? ""] ??
    activeCredential(ctx, "cloudflare");
  if (cfToken) profile.cloudflareToken = cfToken;
  const available = exportEntries(ctx.config, profile).filter(
    (entry) => !allowed || allowed.includes(entry.field),
  );
  const choices = available.map((entry) => ({
    name: `${entry.name} ${entry.secret ? "[Secret]" : "[Variable]"}`,
    value: entry.name,
    checked: !["cloudflareToken", "supabaseCleanupKey"].includes(entry.field),
  }));
  if (
    (!allowed || allowed.includes("supabasePublishableKey")) &&
    !profile.supabasePublishableKey &&
    (profile["@supabaseSource"] === "cli" ||
      !!activeCredential(ctx, "supabase")) &&
    profile.supabaseProjectRef &&
    ctx.config.variables.supabasePublishableKey
  )
    choices.push({
      name: `${ctx.config.variables.supabasePublishableKey} [Secret，选择后从绑定项目读取]`,
      value: ctx.config.variables.supabasePublishableKey,
      checked: true,
    });
  if (!choices.length) {
    ctx.ui.log("当前没有可导出配置；请先连接服务、导入配置或编辑字段。");
    return [];
  }
  const selected = await ctx.ui.check(
    "选择导出项（仅显示变量名；管理Token与特权清理Key默认不选）",
    choices,
  );
  if (selected.includes(ctx.config.variables.supabasePublishableKey!))
    await ensurePublishableKey(ctx);
  const entries = exportEntries(ctx.config, {
    ...values(ctx),
    ...(cfToken ? { cloudflareToken: cfToken } : {}),
  }).filter(
    (entry) =>
      (!allowed || allowed.includes(entry.field)) &&
      selected.includes(entry.name),
  );
  if (
    entries.some((entry) => entry.field === "cloudflareToken") &&
    values(ctx).cloudflareAccountId &&
    values(ctx).pagesProject
  ) {
    const project = await new Cloudflare(cfToken!, ctx.fetcher).pagesProject(
      values(ctx).cloudflareAccountId!,
      values(ctx).pagesProject!,
    );
    if (!project)
      throw new Error(
        "待导出的 CI Token 无法读取当前绑定的 Pages 项目；未导出。",
      );
  }
  return entries;
}
async function exportConfig(ctx: Context): Promise<void> {
  const destination = await ctx.ui.select("导出目标", [
    { name: "本地 .env（权限 600，合并而不清空其他变量）", value: "env" },
    { name: "本机剪贴板（明文，可能进入剪贴板历史）", value: "clipboard" },
    { name: "GitHub Environment Variables / Secrets", value: "github" },
    ...(ctx.config.jsonExport
      ? [{ name: "项目 JSON 配置文件（按 manifest 映射）", value: "json" }]
      : []),
  ]);
  if (destination === "github") {
    await syncGithub(ctx);
    return;
  }
  if (destination === "json") {
    if (
      Object.values(ctx.config.jsonExport ?? {}).includes(
        "supabasePublishableKey",
      )
    )
      await ensurePublishableKey(ctx);
    const output: Values = {};
    for (const [target, field] of Object.entries(ctx.config.jsonExport ?? {})) {
      const value = values(ctx)[field];
      if (!value)
        throw new Error(
          `JSON 配置尚缺 ${allFields(ctx.config)[field]?.label ?? field}，请先在“编辑配置字段”中补齐。`,
        );
      output[target] = validateField(ctx.config, field, value);
    }
    const path = await localExportPath(
      ctx.root,
      await ctx.ui.input("JSON 导出路径（须在 .gitignore 中）", {
        value: ".env.setup.json",
      }),
      ctx.runner,
    );
    const old = await readPrivate(path);
    if (
      !(await ctx.ui.confirm(
        `写入 ${path}（${old === undefined ? "新建" : "替换已有 JSON"}）？`,
      ))
    ) {
      ctx.ui.log("已取消 JSON 导出，目标保持不变。");
      return;
    }
    await writePrivate(
      path,
      `${JSON.stringify(output, null, 2)}\n`,
      old ?? null,
    );
    ctx.ui.log("JSON 已导出；业务项目自己的部署校验仍须通过。");
    return;
  }
  const entries = await selectedEntries(ctx);
  if (!entries.length) {
    ctx.ui.log("未导出任何变量，目标保持不变。");
    return;
  }
  const output = Object.fromEntries(
    entries.map((entry) => [entry.name, entry.value]),
  );
  ctx.ui.log(`导出：${entries.map((entry) => entry.name).join(", ")}`);
  if (destination === "clipboard") {
    if (
      await ctx.ui.confirm(
        "将所选配置以明文写入本机剪贴板？使用后请自行清空剪贴板及其历史。",
      )
    ) {
      await clipboard(mergeEnv("", output), ctx.runner);
      ctx.ui.log("已复制到本机剪贴板。");
    } else ctx.ui.log("已取消剪贴板导出，剪贴板保持不变。");
  } else {
    const path = await localExportPath(
      ctx.root,
      await ctx.ui.input("统一 .env 导出路径（明文；部署无需导出）", {
        value: unifiedEnvPath(ctx.env),
      }),
      ctx.runner,
    );
    const old = await readPrivate(path);
    const selectedOutput = await resolveEnvConflicts(
      parseEnv(old ?? ""),
      output,
      ctx.ui,
    );
    const contents = mergeEnv(old ?? "", selectedOutput);
    if (
      await ctx.ui.confirm(`向 ${path} 合并上述变量（已有同名变量将更新）？`)
    ) {
      await writePrivate(path, contents, old ?? null);
      ctx.ui.log("已写入本地 .env，权限 600。");
    } else ctx.ui.log("已取消 .env 导出，目标文件保持不变。");
  }
}
async function connectGithub(ctx: Context): Promise<string | undefined> {
  // gh owns authentication/keychain and local sealed-box encryption for Actions secrets.
  try {
    await ctx.runner("gh", ["auth", "status", "--hostname", "github.com"]);
  } catch {
    ctx.ui.log(
      "需要官方 GitHub CLI：https://cli.github.com/。已有 GH_TOKEN/GITHUB_TOKEN 会覆盖 gh 登录；无效时请在终端修正。",
    );
    if (!(await ctx.ui.confirm("运行 gh auth login --web 完成 GitHub 授权？")))
      return;
    await ctx.runner(
      "gh",
      [
        "auth",
        "login",
        "--web",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
      ],
      { inherit: true, timeout: 300_000 },
    );
    await ctx.runner("gh", ["auth", "status", "--hostname", "github.com"]);
  }
  const repo = await ctx.ui.input("目标 GitHub 仓库 owner/repo", {
    value: values(ctx)["@repository"] ?? ctx.config.repository,
  });
  const user = machineJson<{ id: number; login: string }>(
    await ctx.runner("gh", ["api", "--hostname", "github.com", "user"]),
  );
  if (
    !Number.isSafeInteger(user.id) ||
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(user.login)
  )
    throw new Error("GitHub CLI 身份响应无效。");
  if (
    values(ctx)["@githubIdentity"] &&
    values(ctx)["@githubIdentity"] !== String(user.id) &&
    !(await ctx.ui.confirm(
      `GitHub 当前账号 ${user.login} 与原绑定 ${values(ctx)["@githubLogin"]} 不同；确认重新绑定当前环境？`,
    ))
  )
    return;
  if (!repository(repo)) throw new Error("GitHub 仓库应为 owner/repo。");
  await ctx.runner("gh", ["api", `repos/${repo}`]);
  values(ctx)["@repository"] = repo;
  values(ctx)["@githubIdentity"] = String(user.id);
  values(ctx)["@githubLogin"] = user.login;
  status(ctx, "github", {
    state: "已验证",
    source: "官方 gh",
    identity: user.login,
  });
  ctx.ui.log(
    `已验证仓库访问：${repo}。这用于 CI 配置，不会打开 Cloudflare/Supabase 自带的 Git 自动部署。`,
  );
  return repo;
}
async function syncGithub(ctx: Context): Promise<void> {
  const repo = await connectGithub(ctx);
  if (!repo) return;
  const environments = await githubPages(
    `repos/${repo}/environments`,
    "environments",
    ctx.runner,
  );
  const exists = environments.some((env) => env.name === ctx.env);
  const entries = await selectedEntries(ctx);
  if (!entries.length) {
    ctx.ui.log("没有选中同步项，GitHub 保持不变。");
    return;
  }
  ctx.ui.log(
    `目标：${repo} → Environment ${ctx.env}（${exists ? "已有" : "待创建"}）。\n${entries.map((entry) => `${entry.secret ? "Secret" : "Variable"}: ${entry.name}`).join("\n")}\n同名项会更新；GitHub 无法回读 Secret 值，现有 Secret 必须从本地来源导入一次。`,
  );
  if (!(await ctx.ui.confirm("确认创建环境（如需要）并同步以上变量？"))) {
    ctx.ui.log("已取消同步，GitHub 保持不变。");
    return;
  }
  await githubIdentity(ctx);
  if (!exists)
    await ctx.runner("gh", [
      "api",
      "--method",
      "PUT",
      `repos/${repo}/environments/${encodeURIComponent(ctx.env)}`,
    ]);
  await githubSync(repo, ctx.env, entries, ctx.runner, () =>
    githubIdentity(ctx),
  );
  ctx.ui.log(
    "GitHub 已接受所选变量/Secret 的写入。未改动环境保护规则，也未触发部署工作流。",
  );
}
async function readGithub(ctx: Context): Promise<void> {
  const repo = await connectGithub(ctx);
  if (!repo) return;
  const remoteVariables = await githubPages(
    `repos/${repo}/environments/${ctx.env}/variables`,
    "variables",
    ctx.runner,
  );
  const remote = Object.fromEntries(
    remoteVariables.map((variable) => [variable.name, variable.value!]),
  );
  const candidates = Object.entries(ctx.config.variables).filter(
    ([field, name]) => !allFields(ctx.config)[field]!.secret && remote[name],
  );
  ctx.ui.log(
    "只读取 Environment Variables；GitHub Secrets 无法回读。本机需要使用的值请从所属服务或本地来源读取，已有 Secret 无需重复写入。",
  );
  if (!candidates.length) {
    ctx.ui.log(
      `${repo} / ${ctx.env} 没有可导入的 Environment Variables；请核对环境名与变量映射。仓库级 Variables 和 Secrets 不在此列表中，本机配置未更改。`,
    );
    return;
  }
  const selected = await ctx.ui.check(
    "选择导入的公开配置",
    candidates.map(([field, name]) => ({ name, value: field, checked: true })),
  );
  const pending: Values = {};
  for (const [field, name] of candidates)
    if (selected.includes(field))
      pending[field] = validateField(ctx.config, field, remote[name]!);
  Object.assign(values(ctx), pending);
  ctx.ui.log(
    `已从 ${repo} / ${ctx.env} 导入 ${Object.keys(pending).length} 项公开变量到本机；可在“查看配置状态”查看。未修改 GitHub。`,
  );
}
async function importConfig(ctx: Context): Promise<void> {
  const source = await ctx.ui.select("导入来源（只读取 manifest 声明的变量）", [
    { name: "当前终端环境变量", value: "process" },
    { name: "项目内 .env 文件", value: "env" },
  ]);
  let imported: NodeJS.ProcessEnv;
  if (source === "process") imported = process.env;
  else {
    const path = await localExportPath(
      ctx.root,
      await ctx.ui.input("统一 .env 文件路径（可指定旧文件导入）", {
        value: unifiedEnvPath(ctx.env),
      }),
      ctx.runner,
    );
    const contents = await readPrivate(path);
    if (contents === undefined) throw new Error(".env 文件不存在。");
    imported = parseEnv(contents);
  }
  const found = Object.entries(ctx.config.variables).filter(
    ([field, name]) => field !== "cloudflareToken" && imported[name],
  );
  if (!found.length) {
    ctx.ui.log(
      "所选来源没有与当前项目映射匹配的变量；没有可导入项，本机配置未更改。",
    );
    return;
  }
  const selected = await ctx.ui.check(
    "选择导入项（不显示值）",
    found.map(([field, name]) => ({ name, value: field, checked: true })),
  );
  const pending: Values = {};
  for (const [field, name] of found)
    if (selected.includes(field))
      pending[field] = validateField(ctx.config, field, imported[name]!);
  const current = Object.fromEntries(
    Object.entries(ctx.config.variables)
      .filter(([field]) => values(ctx)[field] !== undefined)
      .map(([field, name]) => [name, values(ctx)[field]!]),
  );
  const namedPending = Object.fromEntries(
    Object.entries(pending).map(([field, value]) => [
      ctx.config.variables[field]!,
      value,
    ]),
  );
  const resolved = await resolveEnvConflicts(current, namedPending, ctx.ui);
  const accepted = Object.fromEntries(
    Object.entries(pending).filter(([field]) =>
      Object.hasOwn(resolved, ctx.config.variables[field]!),
    ),
  );
  Object.assign(values(ctx), accepted);
  ctx.ui.log(
    `已导入 ${Object.keys(accepted).length} 项。管理令牌请通过对应服务的“连接账号”导入。`,
  );
}
async function edit(ctx: Context): Promise<void> {
  const definitions = allFields(ctx.config);
  const editable = new Set([
    ...Object.keys(ctx.config.variables),
    ...Object.keys(ctx.config.jsonExport ?? {}).map(
      (key) => ctx.config.jsonExport![key]!,
    ),
  ]);
  const field = await ctx.ui.select(
    "选择配置字段",
    [...editable]
      .filter((field) => field !== "cloudflareToken")
      .map((field) => ({ name: definitions[field]!.label, value: field })),
  );
  values(ctx)[field] = await inputField(ctx, field);
  ctx.ui.log(
    `已更新 ${definitions[field]!.label}，仅影响 ${ctx.config.project} / ${ctx.env} 的本机配置。`,
  );
}

type Module = {
  id: string;
  title: string;
  actions: Array<{
    id: string;
    title: string;
    execute: (ctx: Context) => Promise<unknown>;
  }>;
};
export const modules: Module[] = [
  {
    id: "cloudflare",
    title: "Cloudflare",
    actions: [
      {
        id: "account",
        title: "连接账号 / API Token",
        execute: (ctx) => connection(ctx, cloudflareAccount),
      },
      {
        id: "ci-token",
        title: "配置 CI 部署 Token（可选，与官方登录分开）",
        execute: (ctx) => connection(ctx, deploymentCredential),
      },
      { id: "pages", title: "读取或创建 Pages 项目", execute: pages },
      {
        id: "worker",
        title: "配置 Worker 名称 / 应用 Origin",
        execute: worker,
      },
      {
        id: "dashboard",
        title: "打开 Cloudflare 控制台",
        execute: (ctx) => browser(ctx, "https://dash.cloudflare.com/"),
      },
    ],
  },
  {
    id: "supabase",
    title: "Supabase",
    actions: [
      {
        id: "project",
        title: "连接账号 / 选择组织与项目 / 读取应用 Key",
        execute: (ctx) => connection(ctx, selectSupabase),
      },
      {
        id: "auth",
        title: "配置 Auth Site URL / Redirect URL",
        execute: (ctx) => connection(ctx, authOrigins),
      },
      {
        id: "health",
        title: "验证项目 Auth 网关（识别额度 / Key / 网络问题）",
        execute: async (ctx) => {
          await ensurePublishableKey(ctx);
          const ref = values(ctx).supabaseProjectRef;
          const key = values(ctx).supabasePublishableKey;
          if (!ref || !key)
            throw new Error("请先选择项目并读取 Publishable Key。");
          await supabaseHealth(ref, key, ctx.fetcher);
          ctx.ui.log(
            "Auth 网关可达，Key 已被接受；数据库迁移、RLS 和业务流程仍需项目测试验证。",
          );
        },
      },
      {
        id: "migrations",
        title: "官方 CLI 预演 / 应用数据库迁移",
        execute: async (ctx) => {
          await migrations(ctx);
        },
      },
      {
        id: "create",
        title: "打开创建项目页面（区域与计费在网页确认）",
        execute: async (ctx) => {
          ctx.ui.log(
            "区域优先与后端同区；组织名称不等于环境隔离，应分别建项目。付费组织新增项目可能产生计算费用；工具不会升级套餐或迁移组织。",
          );
          await browser(ctx, "https://supabase.com/dashboard/new");
        },
      },
    ],
  },
  {
    id: "github",
    title: "GitHub",
    actions: [
      {
        id: "connect",
        title: "连接 GitHub / 验证仓库访问",
        execute: connectGithub,
      },
      {
        id: "switch",
        title: "切换官方 gh 已登录账号（会修改 gh 默认账号）",
        execute: async (ctx) => {
          const login = await ctx.ui.input("已登录 GitHub 用户名", {
            value: values(ctx)["@githubLogin"],
          });
          if (!/^[A-Za-z0-9-]{1,39}$/.test(login))
            throw new Error("GitHub 用户名不合法。");
          if (
            await ctx.ui.confirm(
              `将 gh 默认账号切换到 ${login}？其他项目的绑定不会自动更改。`,
            )
          ) {
            await ctx.runner("gh", [
              "auth",
              "switch",
              "--hostname",
              "github.com",
              "--user",
              login,
            ]);
            await refreshLogin(ctx);
          }
        },
      },
      {
        id: "read",
        title: "读取已有 GitHub Environment Variables",
        execute: readGithub,
      },
      {
        id: "sync",
        title: "同步 GitHub Environment Variables / Secrets",
        execute: syncGithub,
      },
    ],
  },
  {
    id: "deployment",
    title: "AWS / Zero Trust Tunnel 部署准备",
    actions: [
      {
        id: "configure",
        title: "配置 AWS 目标 / 固定镜像 / 应用域名",
        execute: configureDeployment,
      },
      {
        id: "management-token",
        title: "配置专用 Tunnel 管理 Token（Zone/DNS 权限）",
        execute: (ctx) => connection(ctx, tunnelManagementCredential),
      },
      {
        id: "tunnel",
        title: "配置独立 Tunnel / DNS / 读取连接 Token",
        execute: async (ctx) => configureTunnel(ctx, await tunnelClient(ctx)),
      },
      {
        id: "host",
        title: "只读检查 SSH 主机 / Docker / 资源余量",
        execute: checkDeploymentHost,
      },
      {
        id: "plan",
        title: "检查缺失配置与部署计划（不发布）",
        execute: showDeploymentPlan,
      },
      {
        id: "token-file",
        title: "导出 Tunnel Token 私密文件",
        execute: exportTunnelToken,
      },
    ],
  },
];

export async function wizard(ctx: Context): Promise<void> {
  while (true) {
    showLogin(ctx);
    const selected = await ctx.ui.select(
      `${ctx.config.project} / ${ctx.env} — 配置中心`,
      [
        ...modules.map((module) => ({ name: module.title, value: module.id })),
        { name: "导入本地配置", value: "import" },
        { name: "编辑配置字段", value: "edit" },
        { name: "导出 .env / 剪贴板 / GitHub / 项目 JSON", value: "export" },
        { name: "查看配置状态（隐藏凭据）", value: "status" },
        { name: "切换环境", value: "environment" },
        { name: "保存并退出", value: "exit" },
      ],
    );
    const ui = ctx.ui;
    const resultLines: string[] = [];
    ctx.ui = {
      ...ui,
      log: (line) => {
        resultLines.push(line);
        ui.log(line);
      },
    };
    try {
      if (selected === "exit") {
        await ctx.save();
        return;
      }
      if (selected === "environment") {
        ctx.env = await ctx.ui.select(
          "选择环境",
          ctx.config.environments.map((env) => ({ name: env, value: env })),
        );
        continue;
      }
      if (selected === "status") {
        await showStatus(ctx);
        continue;
      }
      const providerModule = modules.find((item) => item.id === selected);
      if (providerModule) {
        const action = await ctx.ui.select(providerModule.title, [
          ...providerModule.actions.map((action) => ({
            name: action.title,
            value: action.id,
          })),
          { name: "返回", value: "back" },
        ]);
        if (action === "back") continue;
        await providerModule.actions
          .find((item) => item.id === action)
          ?.execute(ctx);
      } else {
        if (selected === "import") await importConfig(ctx);
        else if (selected === "edit") await edit(ctx);
        else if (selected === "export") await exportConfig(ctx);
      }
      await ctx.save();
      ctx.ui.log(
        ctx.storageMode === "memory"
          ? "内存模式：本次配置未保存到本机状态文件。"
          : ctx.storageMode === "vault"
            ? "凭据已加密保存；本机项目配置与绑定已保存。"
            : "公开配置与绑定已保存；本次凭据退出后不保留。",
      );
    } catch (error) {
      if (error instanceof Error && error.name === "ExitPromptError")
        throw error;
      ctx.ui.log(safeMessage(error, ctx));
      if (["cloudflare", "supabase", "github"].includes(selected))
        status(ctx, selected, {
          state: "验证失败",
          source: "当前操作未通过",
          detail: safeMessage(error, ctx),
        });
    } finally {
      ctx.ui = ui;
    }
    {
      const next = await ui.select(
        [
          `${ctx.config.project} / ${ctx.env} — 操作结果`,
          ...resultLines
            .slice(-8)
            .map((line) => safeMessage(new Error(line), ctx)),
          ctx.storageMode === "vault"
            ? "统一加密保险库已启用；各服务 Token/Key 隐藏保存，下次解锁复用。"
            : "当前未启用保险库；本次 Token/Key 退出后不保留。",
        ].join("\n"),
        [
          { name: "返回主菜单", value: "back" },
          { name: "查看配置状态（隐藏凭据）", value: "status" },
        ],
      );
      if (next === "status") await showStatus(ctx);
    }
  }
}

// Shared operations keep the guided entrypoint on the same preview, credential
// and confirmation paths as the provider integration harness.
export const operations = {
  import: importConfig,
  export: exportConfig,
  edit,
  status: showStatus,
};
export const defaultRunner = run;

export async function releaseCloudflareToken(ctx: Context): Promise<string> {
  return (
    ctx.data.credentials[values(ctx)["@cloudflareDeploy"] ?? ""] ??
    (await cloudflareToken(ctx))
  );
}

export async function releasePublishableKey(ctx: Context): Promise<void> {
  const profile = values(ctx);
  if (
    profile.supabaseProjectRef &&
    profile.supabaseUrl &&
    profile.supabaseUrl !== `https://${profile.supabaseProjectRef}.supabase.co`
  )
    throw new Error("Supabase URL 与绑定的 Project Ref 不一致，已停止发布。");
  await ensurePublishableKey(ctx);
}
