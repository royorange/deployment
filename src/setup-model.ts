import { validateField, type Config } from "./config.ts";
import type { Values } from "./vault.ts";

export type SetupCheck = {
  id: string;
  title: string;
  purpose: string;
  instructions: string;
  state: "missing" | "configured" | "unknown" | "manual" | "published";
  action?: string;
};

const localOnly =
  "本地字段已配置仅表示格式完整，不代表远端资源、部署或业务验证通过。";

/** Pure local checks: never contact providers or turn declarations into deployment evidence. */
export function setupChecks(config: Config, values: Values): SetupCheck[] {
  const checks: SetupCheck[] = [];
  const mapped = (field: string) => Object.hasOwn(config.variables, field);
  const complete = (names: string[]) =>
    names.length > 0 &&
    names.every((field) => {
      try {
        return (
          !!values[field] && !!validateField(config, field, values[field]!)
        );
      } catch {
        return false;
      }
    });
  const local = (
    id: string,
    title: string,
    purpose: string,
    names: string[],
    action: string,
    instructions: string,
  ) => {
    checks.push({
      id,
      title,
      purpose,
      instructions: `${instructions} ${localOnly}`,
      state: complete(names) ? "configured" : "missing",
      action,
    });
  };
  const manual = (
    id: string,
    title: string,
    purpose: string,
    instructions: string,
  ) => {
    checks.push({ id, title, purpose, instructions, state: "manual" });
  };
  const cloudflare =
    Object.keys(config.variables).some((field) =>
      /^(cloudflare|pagesProject|workerName)/.test(field),
    ) ||
    config.setup?.components?.some((component) =>
      ["pages", "worker"].includes(component.hosting),
    );
  if (cloudflare) {
    local(
      "cloudflare.account",
      "Cloudflare 账号",
      "为所选环境选择部署账号与凭据。",
      ["cloudflareAccountId"],
      "cloudflare.account",
      "在账号与服务中连接 Cloudflare；官方控制台提供账号与 API Token 管理入口。",
    );
    if (mapped("pagesProject"))
      local(
        "cloudflare.pages",
        "Pages 项目配置",
        "绑定前台所用 Pages 项目。",
        ["pagesProject"],
        "cloudflare.pages",
        "在 Cloudflare 服务中选择或创建项目；真实部署、分支与地址须另行读取核验。",
      );
  }
  if (
    mapped("pagesProject") &&
    !config.setup?.components?.some(
      (component) =>
        component.hosting === "pages" &&
        component.projectField === "pagesProject" &&
        component.originField,
    )
  )
    checks.push({
      id: "cloudflare.pages.deployment",
      title: "Pages 真实发布记录",
      purpose: "核验所选分支的资源发布状态。",
      instructions:
        "读取真实部署分支与状态；资源发布成功仍需验证自定义域名、Access 与业务。",
      state: "unknown",
      action: "cloudflare.pages",
    });
  const supabase = Object.keys(config.variables).some((field) =>
    field.startsWith("supabase"),
  );
  if (supabase) {
    const projectFields = [
      "supabaseProjectRef",
      "supabaseUrl",
      "supabasePublishableKey",
    ].filter(mapped);
    local(
      "supabase.project",
      "Supabase 项目配置",
      "选择数据库与 Storage 所用项目并读取应用凭据。",
      projectFields,
      "supabase.project",
      "在账号与服务中连接 Supabase，选择组织与项目；管理 Token 在官方账号设置获取，应用 Key 从项目读取。",
    );
    if (config.setup?.auth === "supabase")
      checks.push({
        id: "supabase.auth",
        title: "Supabase Auth 回调",
        purpose: "让登录后的浏览器返回当前环境。",
        state: "unknown",
        action: "supabase.auth",
        instructions:
          "进入 Supabase Auth 操作前先核对项目实际回调路径和现有允许地址；默认通配路径不代表项目支持，保存后通过真实登录回调验证。",
      });
    else if (!config.setup?.auth)
      manual(
        "supabase.auth",
        "确认应用认证方式",
        "避免把数据库服务误当作登录服务。",
        "在项目 setup.auth 声明 supabase、firebase、external 或 none；未声明时不自动修改 Auth 回调。",
      );
    if (config.migrationStrategy === "supabase-cli")
      checks.push({
        id: "supabase.migrations",
        title: "数据库迁移",
        purpose: "建立业务表、策略与正式迁移历史。",
        state: "unknown",
        action: "supabase.migrations",
        instructions:
          "使用官方 CLI 预演并核对目标项目与已有迁移账本后应用；连接成功或 Auth 通过不代表业务数据库已初始化。",
      });
    else
      manual(
        "supabase.migrations",
        "项目数据库初始化",
        "沿用项目负责的迁移账本和受限数据库角色。",
        config.migrationStrategy === "project-managed"
          ? "按项目已有部署文档执行迁移、执行器角色与连接串配置；不混用官方 CLI 迁移账本。"
          : "先在项目声明 migrationStrategy 并核对已有账本；未声明时不运行迁移。项目额外角色、密码和执行器配置遵循项目文档。",
      );
  }
  if (config.setup?.auth === "firebase" || config.setup?.auth === "external")
    manual(
      "auth.external",
      config.setup.auth === "firebase" ? "Firebase 登录配置" : "外部登录配置",
      "验证前台登录、API 身份校验及管理入口鉴权。",
      "按照项目文档检查认证项目、允许域名、服务端凭据和回调；用独立测试账号完成前台与管理入口登录，不能用 Supabase Auth 检查代替。",
    );
  if (config.repository)
    checks.push({
      id: "github.account",
      title: "GitHub 仓库与部署变量",
      purpose: "连接仓库并准备各环境 CI/CD 配置。",
      state: "unknown",
      action: "github.connect",
      instructions:
        "在账号与服务中连接 GitHub 并确认仓库和 Environment；Secret 名称存在不代表值正确，部署权限与工作流执行须独立验证。",
    });
  if (config.deploymentTopology === "aws-tunnel") {
    local(
      "deployment.configure",
      "AWS 应用部署配置",
      "配置独立目录、固定镜像与应用入口。",
      [
        "deploymentRuntime",
        "deploymentTarget",
        "sshTarget",
        "remoteDirectory",
        "deploymentImage",
        "tunnelImage",
        "appOrigin",
      ],
      "deployment.configure",
      "进入应用部署配置，确认 SSH 主机、环境、资源限制与固定镜像摘要。",
    );
    local(
      "deployment.tunnel",
      "整站 Tunnel 配置",
      "将公网应用入口连接至 AWS 私有应用。",
      ["cloudflareZoneId", "cloudflareTunnelId", "cloudflareTunnelToken"],
      "deployment.tunnel",
      "进入 Tunnel 配置，先核对域名、现有 DNS 与 ingress；远端变更需预览后确认。",
    );
    checks.push({
      id: "deployment.host",
      title: "AWS 主机预检",
      purpose: "确认 SSH、Docker、机器架构和资源满足部署要求。",
      state: "unknown",
      action: "deployment.host",
      instructions:
        "运行只读主机检查；本地填好 SSH 地址不代表主机可达或有足够资源。",
    });
  } else if (config.deploymentTopology === "worker-private-origin")
    manual(
      "worker.private-origin",
      "Worker 与私有 API 链路",
      "核验前台、Worker、Access、Tunnel 与业务 API 的访问关系。",
      "按项目既有流程配置 Worker 和私有 API Origin，分别验证 Access 服务凭据与 Tunnel 路由；整站 AWS Tunnel 向导不适用于此拓扑。",
    );
  else if (!config.setup?.components?.length)
    manual(
      "deployment.topology",
      "确认部署拓扑",
      "先确定组件托管位置，再选择相应部署流程。",
      "在项目声明 deploymentTopology，或通过 setup.components 说明独立前台、后台、API 与任务服务；未声明时不推断 Tunnel 关系。",
    );
  for (const component of config.setup?.components ?? []) {
    const fields = [
      component.originField,
      component.projectField,
      component.branchField,
    ].filter((field): field is string => field !== undefined);
    const instructions = `${component.instructions ?? "按项目部署文档配置此组件。"}${component.docs ? ` 文档：${component.docs}` : ""}`;
    const purpose = `准备${component.title}的入口与托管资源配置。`;
    if (fields.length)
      local(
        `component.${component.id}.config`,
        `${component.title}配置`,
        purpose,
        fields,
        component.hosting === "pages" &&
          component.projectField &&
          component.originField
          ? "cloudflare.pages"
          : "edit",
        instructions,
      );
    else
      manual(
        `component.${component.id}.config`,
        `${component.title}配置`,
        purpose,
        instructions,
      );
    checks.push({
      id: `component.${component.id}.deployment`,
      title: `${component.title}发布验证`,
      purpose: "区分配置完整、发布成功和实际可用。",
      state: "unknown",
      ...(component.hosting === "pages" &&
      component.projectField &&
      component.originField
        ? { action: "cloudflare.pages" }
        : {}),
      instructions: `${instructions} 核对真实部署的提交、环境、分支与可访问地址；管理后台须验证 Access 策略及默认托管地址是否可绕过。HTTP 200 或进程存活不能证明依赖和业务可用。`,
    });
  }
  for (const requirement of config.setup?.requirements ?? []) {
    const instructions = `${requirement.instructions}${requirement.docs ? ` 文档：${requirement.docs}` : ""}`;
    if (requirement.fields?.length)
      local(
        `requirement.${requirement.id}`,
        requirement.title,
        requirement.purpose,
        requirement.fields,
        "edit",
        instructions,
      );
    else
      manual(
        `requirement.${requirement.id}`,
        requirement.title,
        requirement.purpose,
        instructions,
      );
  }
  checks.push({
    id: "application.verified",
    title: "应用业务验证",
    purpose: "确认新环境完成可用的业务闭环。",
    state: "unknown",
    instructions:
      "发布后按项目测试流程验证前台、后台、API、认证、数据库和 Storage；仅运行项目声明启用的支付、AI、推送等能力检查。另行确认日志、备份恢复与回滚流程；此本地配置检查不能给出业务已可用结论。",
  });
  return checks;
}
