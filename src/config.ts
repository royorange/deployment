import { singleLine, variableName } from "./files.ts";
import type { Values } from "./vault.ts";
import { validateSetup, type SetupConfig } from "./setup-config.ts";

type Field = {
  label: string;
  secret: boolean;
  kind: "text" | "origin" | "name" | "account" | "ref" | "publishable";
};
export const fields: Record<string, Field> = {
  cloudflareToken: {
    label: "Cloudflare 部署 API Token",
    secret: true,
    kind: "text",
  },
  cloudflareAccountId: {
    label: "Cloudflare Account ID",
    secret: false,
    kind: "account",
  },
  pagesProject: { label: "Pages 项目名称", secret: false, kind: "name" },
  workerName: { label: "Worker 名称", secret: false, kind: "name" },
  siteOrigin: { label: "落地页 Origin", secret: false, kind: "origin" },
  appOrigin: { label: "应用 Origin", secret: false, kind: "origin" },
  supabaseUrl: { label: "Supabase 项目 URL", secret: false, kind: "origin" },
  supabasePublishableKey: {
    label: "Supabase Publishable Key",
    secret: true,
    kind: "publishable",
  },
  supabaseProjectRef: {
    label: "Supabase Project Ref",
    secret: false,
    kind: "ref",
  },
  cloudflareZoneId: {
    label: "Cloudflare Zone ID",
    secret: false,
    kind: "account",
  },
  cloudflareTunnelId: {
    label: "Cloudflare Tunnel ID",
    secret: false,
    kind: "text",
  },
  cloudflareTunnelToken: {
    label: "Cloudflare Tunnel 连接 Token",
    secret: true,
    kind: "text",
  },
  supabaseCleanupKey: {
    label: "独立清理进程 Supabase Secret Key",
    secret: true,
    kind: "text",
  },
  deploymentRuntime: {
    label: "应用运行方式（aws-tunnel）",
    secret: false,
    kind: "text",
  },
  deploymentTarget: { label: "部署环境", secret: false, kind: "text" },
  sshTarget: { label: "AWS SSH 别名或 user@host", secret: false, kind: "text" },
  remoteDirectory: { label: "远端独立部署目录", secret: false, kind: "text" },
  deploymentImage: {
    label: "应用镜像（固定 sha256 digest）",
    secret: false,
    kind: "text",
  },
  tunnelImage: {
    label: "cloudflared 镜像（固定 sha256 digest）",
    secret: false,
    kind: "text",
  },
  syntheticFilesEnabled: {
    label: "开放合成文件（true / false）",
    secret: false,
    kind: "text",
  },
  cleanupEnabled: {
    label: "启用独立清理调度（true / false）",
    secret: false,
    kind: "text",
  },
};
export type Config = {
  version: 1;
  project: string;
  repository?: string;
  deploymentTopology?: "aws-tunnel" | "worker-private-origin";
  migrationStrategy?: "supabase-cli" | "project-managed";
  setup?: SetupConfig;
  environments: string[];
  variables: Record<string, string>;
  defaults?: Record<string, Values>;
  extraFields?: Record<
    string,
    { label: string; kind: "text" | "origin"; secret: boolean }
  >;
  jsonExport?: Record<string, string>;
  githubSecrets?: string[];
  envExports?: Array<{ label: string; path: string; fields: string[] }>;
};
export type Entry = {
  field: string;
  name: string;
  value: string;
  secret: boolean;
};
export function name(value: string): boolean {
  return (
    typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(value)
  );
}
export function repository(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(
      value,
    )
  );
}
export function environment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}
export function projectKey(project: string, env: string): string {
  return JSON.stringify([project, env]);
}
export function allFields(config: Config): Record<string, Field> {
  return { ...fields, ...config.extraFields };
}

export function validateField(
  config: Config,
  field: string,
  value: string,
): string {
  const definition = allFields(config)[field];
  if (!Object.hasOwn(allFields(config), field) || !definition)
    throw new Error("未知配置字段。");
  if (typeof value !== "string") throw new Error("配置值必须为字符串。");
  singleLine(value);
  if (!value.trim()) throw new Error("配置值不能为空。");
  const kind = definition.kind;
  if (kind === "origin") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("请输入完整 HTTPS Origin。");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      /^(localhost|127\.|\[::1\])/.test(parsed.hostname)
    )
      throw new Error("请输入 HTTPS Origin，不带路径、末尾斜杠或账号信息。");
  }
  if (kind === "account" && !/^[a-f0-9]{32}$/.test(value))
    throw new Error("Account ID 应为 32 位小写十六进制。");
  if (kind === "ref" && !/^[a-z]{20}$/.test(value))
    throw new Error("Project Ref 应为 20 位小写字母。");
  if (kind === "name" && !name(value))
    throw new Error(
      "资源名称应为 2–63 位小写字母、数字、连字符，首尾为字母或数字。",
    );
  if (kind === "publishable" && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(value))
    throw new Error(
      "请使用 sb_publishable_ 开头的新 Publishable Key；不要使用 secret/service_role。",
    );
  return value;
}

export function validateConfig(input: unknown): Config {
  if (!input || typeof input !== "object") throw new Error("无效的项目配置。");
  const config = input as Config;
  if (config.version !== 1 || !name(config.project))
    throw new Error("配置版本或项目名称不合法。");
  if (config.repository && !repository(config.repository))
    throw new Error("GitHub 仓库应为 owner/repo。");
  if (
    config.deploymentTopology !== undefined &&
    !["aws-tunnel", "worker-private-origin"].includes(config.deploymentTopology)
  )
    throw new Error("未知部署拓扑，未推断应用与私有入口关系。");
  if (
    config.migrationStrategy !== undefined &&
    !["supabase-cli", "project-managed"].includes(config.migrationStrategy)
  )
    throw new Error("未知迁移策略，未推断或修改迁移账本。");
  if (
    !Array.isArray(config.environments) ||
    !config.environments.length ||
    config.environments.some(
      (env) => typeof env !== "string" || !environment(env),
    ) ||
    new Set(config.environments).size !== config.environments.length
  )
    throw new Error("环境名称不合法或重复。");
  for (const [key, definition] of Object.entries(config.extraFields ?? {})) {
    if (
      !/^[a-z][A-Za-z0-9]{1,50}$/.test(key) ||
      Object.hasOwn(fields, key) ||
      /token|password|secret|key/i.test(key)
    )
      throw new Error("扩展字段名称冲突或包含保留的凭据名称。");
    if (
      !definition ||
      typeof definition.label !== "string" ||
      definition.label.length > 100 ||
      !["text", "origin"].includes(definition.kind) ||
      typeof definition.secret !== "boolean"
    )
      throw new Error("扩展字段定义不合法。");
    singleLine(definition.label);
  }
  const definitions = allFields(config);
  if (config.envExports) {
    if (!Array.isArray(config.envExports) || config.envExports.length > 10)
      throw new Error(".env 导出预设不合法。");
    for (const preset of config.envExports) {
      if (
        !preset ||
        typeof preset.label !== "string" ||
        typeof preset.path !== "string" ||
        !Array.isArray(preset.fields) ||
        preset.fields.some(
          (field) => !Object.hasOwn(config.variables ?? {}, field),
        )
      )
        throw new Error(".env 导出预设引用了未知变量。");
      singleLine(preset.label);
      singleLine(preset.path);
      if (/^(?:[\\/]|[A-Za-z]:)|\.\./.test(preset.path))
        throw new Error(".env 预设路径必须位于项目内。");
    }
  }
  if (
    config.githubSecrets &&
    (!Array.isArray(config.githubSecrets) ||
      config.githubSecrets.some(
        (field) =>
          typeof field !== "string" || !Object.hasOwn(definitions, field),
      ))
  )
    throw new Error("GitHub Secret 字段声明不合法。");
  if (
    !config.variables ||
    Array.isArray(config.variables) ||
    typeof config.variables !== "object"
  )
    throw new Error("缺少变量映射。");
  const used = new Set<string>();
  for (const [field, target] of Object.entries(config.variables)) {
    if (!Object.hasOwn(definitions, field))
      throw new Error(
        "项目映射包含当前工具不支持的字段；请更新 project-setup 后重试。",
      );
    if (typeof target !== "string") throw new Error("变量名不合法。");
    variableName(target);
    if (
      definitions[field]!.secret &&
      /^(NEXT_PUBLIC_|PUBLIC_|VITE_)/.test(target)
    )
      throw new Error("凭据变量不能使用公开前缀。");
    if (used.has(target)) throw new Error("变量映射不能重复。");
    used.add(target);
  }
  for (const [env, values] of Object.entries(config.defaults ?? {})) {
    if (!config.environments.includes(env))
      throw new Error("默认值引用了未知环境。");
    for (const [field, value] of Object.entries(values)) {
      if (definitions[field]?.secret)
        throw new Error("项目配置不能包含明文凭据默认值。");
      if (typeof value !== "string") throw new Error("默认值必须为字符串。");
      validateField(config, field, value);
    }
  }
  for (const [target, field] of Object.entries(config.jsonExport ?? {})) {
    if (
      !/^[a-z][A-Za-z0-9]{0,60}$/.test(target) ||
      ["constructor", "prototype"].includes(target) ||
      !Object.hasOwn(definitions, field) ||
      definitions[field]!.secret
    )
      throw new Error("JSON 导出仅支持公开配置字段。");
  }
  validateSetup(config, definitions);
  return config;
}

export function exportEntries(config: Config, values: Values): Entry[] {
  return Object.entries(config.variables).flatMap(([field, target]) =>
    values[field]
      ? [
          {
            field,
            name: target,
            value: validateField(config, field, values[field]!),
            secret:
              allFields(config)[field]!.secret ||
              (config.githubSecrets?.includes(field) ?? false),
          },
        ]
      : [],
  );
}
