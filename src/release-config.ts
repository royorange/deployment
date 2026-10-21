import type { Config } from "./config.ts";
export type ReleaseComponent = {
  id: string;
  label: string;
  kind: "pages" | "application";
  requiresDevice: boolean;
  migrations: "none" | "supabase-cli" | "project-managed";
  runtimeFields?: string[];
};
export type ReleaseConfig = {
  adapter: string;
  ciWorkflow: string;
  buildWorkflow?: string;
  buildWorkflowRef?: string;
  environments: string[];
  publicFields?: string[];
  components: ReleaseComponent[];
};
function keys(
  input: unknown,
  allowed: string[],
): asserts input is Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new Error("发布声明必须为白名单对象；不支持任意命令或凭据。");
}
export function workflowName(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.ya?ml$/.test(input)
  );
}
export function validateRelease(
  config: Config,
  definitions: Record<string, { secret: boolean }>,
): void {
  if (config.release === undefined) return;
  const release = config.release;
  keys(release, [
    "adapter",
    "ciWorkflow",
    "buildWorkflow",
    "buildWorkflowRef",
    "environments",
    "publicFields",
    "components",
  ]);
  if (
    !config.repository ||
    !workflowName(release.ciWorkflow) ||
    (release.buildWorkflow !== undefined &&
      !workflowName(release.buildWorkflow))
  )
    throw new Error("发布需要仓库和合法工作流文件名。");
  if (
    release.buildWorkflowRef !== undefined &&
    (!release.buildWorkflow ||
      typeof release.buildWorkflowRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(release.buildWorkflowRef) ||
      release.buildWorkflowRef.includes("..") ||
      release.buildWorkflowRef.includes("//"))
  )
    throw new Error("构建工作流运行分支不合法。");
  if (
    typeof release.adapter !== "string" ||
    release.adapter.length > 200 ||
    !/^deploy\/[A-Za-z0-9][A-Za-z0-9_./-]*\.(mts|mjs)$/.test(release.adapter) ||
    release.adapter
      .split("/")
      .some((part) => part === ".." || part === "." || part === "")
  )
    throw new Error("发布适配器必须是deploy内已跟踪的Node文件。");
  if (
    !Array.isArray(release.environments) ||
    !release.environments.length ||
    release.environments.length > 10 ||
    new Set(release.environments).size !== release.environments.length ||
    release.environments.some((env) => !config.environments.includes(env))
  )
    throw new Error("发布环境必须为项目已声明的环境。");
  if (
    release.publicFields !== undefined &&
    (!Array.isArray(release.publicFields) ||
      release.publicFields.length > 50 ||
      new Set(release.publicFields).size !== release.publicFields.length ||
      release.publicFields.some(
        (field) =>
          typeof field !== "string" ||
          !Object.hasOwn(config.variables, field) ||
          !Object.hasOwn(definitions, field) ||
          definitions[field]!.secret,
      ))
  )
    throw new Error("发布公开字段不能包含凭据或未知映射。");
  if (
    !Array.isArray(release.components) ||
    !release.components.length ||
    release.components.length > 12
  )
    throw new Error("发布组件数量不合法。");
  const ids = new Set<string>();
  for (const item of release.components) {
    keys(item, [
      "id",
      "label",
      "kind",
      "requiresDevice",
      "migrations",
      "runtimeFields",
    ]);
    if (
      item.runtimeFields !== undefined &&
      (!Array.isArray(item.runtimeFields) ||
        item.runtimeFields.length > 50 ||
        new Set(item.runtimeFields).size !== item.runtimeFields.length ||
        item.runtimeFields.some(
          (field) =>
            typeof field !== "string" ||
            !Object.hasOwn(config.variables, field) ||
            !Object.hasOwn(definitions, field) ||
            !definitions[field]!.secret ||
            ["cloudflareToken", "supabaseCleanupKey"].includes(field),
        ))
    )
      throw new Error(
        "发布运行字段只允许显式项目敏感字段，不能包含账号管理凭据、特权清理Key或未知映射。",
      );
    if (
      typeof item.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,49}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      item.label.length > 100 ||
      /[\x00-\x1f\x7f-\x9f]/.test(item.label) ||
      !["pages", "application"].includes(String(item.kind)) ||
      typeof item.requiresDevice !== "boolean" ||
      !["none", "supabase-cli", "project-managed"].includes(
        String(item.migrations),
      )
    )
      throw new Error("发布组件定义不合法。");
    ids.add(item.id);
    if (
      item.kind === "pages" &&
      (item.requiresDevice || item.migrations !== "none")
    )
      throw new Error("Pages发布不执行主机部署或数据库迁移。");
    if (
      item.migrations !== "none" &&
      item.migrations !== config.migrationStrategy
    )
      throw new Error("发布迁移策略与项目账本不一致。");
  }
}
