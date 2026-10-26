import { createHash } from "node:crypto";
import { allFields, validateField, type Config } from "./config.ts";
import { validateDevice, type Device } from "./devices.ts";
import type { Values } from "./vault.ts";

export const guideStageIds = [
  "import",
  "cloudflare",
  "device",
  "configuration",
  "tunnel",
  "supabase",
  "auth",
  "application",
  "pages",
  "acceptance",
] as const;
export type GuideStageId = (typeof guideStageIds)[number];
export type GuideScope = {
  root: string;
  repository?: string;
  project: string;
  environment: string;
};
export type GuideHistory = {
  stage: GuideStageId;
  observedAt: string;
  outcome: "verified" | "configured" | "failed" | "cancelled";
  commit?: string;
  component?: string;
  database?: "not-run" | "applied" | "up-to-date" | "unknown";
  phase?: string;
};
export type GuideProgress = {
  version: 1;
  scope: GuideScope;
  binding: string;
  cursor?: GuideStageId;
  deviceId?: string;
  importDisposition?: "imported" | "skipped";
  history: GuideHistory[];
};
export type GuideStage = {
  id: GuideStageId;
  title: string;
  state:
    | "missing"
    | "configured"
    | "verified"
    | "historical"
    | "blocked"
    | "manual";
  missingFields: string[];
};
const providerBindings = [
  "@cloudflare",
  "@cloudflareSource",
  "@cloudflareProfile",
  "@cloudflareIdentity",
  "@cloudflareDeploy",
  "@cloudflareTunnelManagement",
  "@supabase",
  "@supabaseSource",
  "@supabaseProfile",
  "@supabaseIdentity",
  "@supabaseIdentityMode",
  "@supabaseOrganization",
  "@repository",
  "@githubIdentity",
  "@githubLogin",
];

/** Only declared public targets enter this digest. Secret values and their hashes never do. */
export function guideBinding(
  config: Config,
  values: Values,
  device?: Device,
  commit?: string,
): string {
  const definitions = allFields(config);
  const targets = Object.fromEntries(
    Object.keys(config.variables)
      .sort()
      .filter((field) => definitions[field] && !definitions[field]!.secret)
      .map((field) => [field, values[field] ?? null]),
  );
  const selected = device ? validateDevice(device) : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: config.project,
        repository: config.repository ?? null,
        targets,
        providers: Object.fromEntries(
          providerBindings.map((field) => [
            field,
            typeof values[field] === "string" ? values[field] : null,
          ]),
        ),
        release: config.release ?? null,
        setup: config.setup ?? null,
        device: selected
          ? {
              id: selected.id,
              host: selected.host,
              user: selected.user,
              port: selected.port,
            }
          : null,
        commit: commit ?? null,
      }),
    )
    .digest("hex");
}

/** Recompute navigation from facts; successful void actions are deliberately not an input. */
export function deploymentGuideStages(input: {
  config: Config;
  values: Values;
  device?: Device;
  commit?: string;
  progress?: GuideProgress;
  evidence?: Partial<Record<GuideStageId, "verified" | "blocked">>;
}): GuideStage[] {
  const { config, values, evidence = {} } = input;
  const binding = guideBinding(config, values, input.device, input.commit);
  const progress =
    input.progress?.binding === binding ? input.progress : undefined;
  const components = config.release?.components ?? [];
  const stages: GuideStage[] = [];
  const mapped = (names: string[]) =>
    names.filter((name) => Object.hasOwn(config.variables, name));
  const valid = (field: string) => {
    try {
      return !!values[field] && !!validateField(config, field, values[field]!);
    } catch {
      return false;
    }
  };
  const add = (
    id: GuideStageId,
    title: string,
    fields: string[] = [],
    fallback: GuideStage["state"] = "missing",
  ) => {
    const missingFields = fields.filter((field) => !valid(field));
    const history = progress?.history
      .filter((item) => item.stage === id)
      .at(-1);
    const state: GuideStage["state"] =
      evidence[id] === "blocked"
        ? "blocked"
        : evidence[id] === "verified" && !missingFields.length
          ? "verified"
          : history?.outcome === "verified" && !missingFields.length
            ? "historical"
            : missingFields.length
              ? "missing"
              : fallback;
    stages.push({ id, title, state, missingFields });
  };
  add(
    "import",
    "导入统一配置（可跳过）",
    [],
    progress?.importDisposition ? "verified" : "missing",
  );
  if (
    Object.keys(config.variables).some((field) =>
      /^(cloudflare|pagesProject|workerName)/.test(field),
    ) ||
    components.some((item) => item.kind === "pages")
  )
    add(
      "cloudflare",
      "Cloudflare 账号与项目",
      mapped(["cloudflareAccountId"]),
      "configured",
    );
  if (components.some((item) => item.requiresDevice)) {
    add(
      "device",
      "选择部署设备",
      input.device ? [] : ["device"],
      input.device ? "configured" : "missing",
    );
  }
  add(
    "configuration",
    "部署参数与入口",
    mapped([
      "deploymentRuntime",
      "deploymentTarget",
      "remoteDirectory",
      "deploymentImage",
      "tunnelImage",
      "appOrigin",
      "pagesProject",
      "siteOrigin",
    ]),
    "configured",
  );
  if (config.deploymentTopology === "aws-tunnel")
    add(
      "tunnel",
      "Tunnel 路由、DNS 与连接凭据",
      mapped([
        "cloudflareZoneId",
        "cloudflareTunnelId",
        "cloudflareTunnelToken",
        "appOrigin",
      ]),
      "configured",
    );
  if (
    Object.keys(config.variables).some((field) => field.startsWith("supabase"))
  )
    add(
      "supabase",
      "Supabase 项目与应用凭据",
      mapped(["supabaseProjectRef", "supabaseUrl", "supabasePublishableKey"]),
      "configured",
    );
  if (config.setup?.auth === "supabase")
    add(
      "auth",
      "核验 Supabase Auth 回调",
      mapped(["supabaseProjectRef", "appOrigin"]),
      "configured",
    );
  else if (config.setup?.auth && config.setup.auth !== "none")
    add("auth", "外部认证配置与回调", [], "manual");
  if (components.some((item) => item.kind === "application"))
    add("application", "CI、迁移与应用发布");
  if (components.some((item) => item.kind === "pages"))
    add("pages", "Pages 发布与验证");
  add("acceptance", "应用业务验收", [], "manual");
  return stages;
}
