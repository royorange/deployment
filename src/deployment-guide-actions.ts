import { allFields, validateField } from "./config.ts";
import { selectDevice } from "./device-menu.ts";
import type { Device, DeviceStore } from "./devices.ts";
import type { GuideOperationResult } from "./deployment-wizard.ts";
import type {
  GuideProgress,
  GuideStage,
  GuideStageId,
} from "./deployment-guide-model.ts";
import { runReleaseFlow, type ReleaseFlowResult } from "./release-flow.ts";
import { Supabase } from "./providers.ts";
import {
  importUnifiedEnv,
  values,
  verifyGuideCloudflare,
  verifyGuideTunnel,
  type Context,
} from "./wizard.ts";
export type GuideActions = Record<string, (ctx: Context) => Promise<unknown>>;
export type GuideActionResult = {
  outcome?: unknown;
  device?: Device;
  release?: ReleaseFlowResult;
};
export function operationResult(
  value: unknown,
): GuideOperationResult | undefined {
  if (!value || typeof value !== "object" || !("status" in value)) return;
  return ["verified", "configured", "cancelled", "manual"].includes(
    String(value.status),
  )
    ? (value as GuideOperationResult)
    : undefined;
}
export function boundCredential(
  ctx: Context,
  provider: "cloudflare" | "supabase",
): boolean {
  const p = values(ctx);
  if (
    p[`@${provider}Source`] === (provider === "cloudflare" ? "wrangler" : "cli")
  )
    return !!p[`@${provider}Profile`];
  return !!ctx.data.credentials[p[`@${provider}`] ?? ""];
}
export function localStageComplete(
  ctx: Context,
  stage: GuideStage,
  device: Device | undefined,
): boolean {
  if (
    stage.missingFields.length ||
    ["missing", "blocked"].includes(stage.state)
  )
    return false;
  if (stage.id === "device") return !!device;
  if (stage.id === "cloudflare")
    return (
      boundCredential(ctx, "cloudflare") ||
      (!ctx.config.release?.components.some((c) => c.kind === "pages") &&
        !!ctx.data.credentials[
          values(ctx)["@cloudflareTunnelManagement"] ?? ""
        ])
    );
  if (stage.id === "supabase") return boundCredential(ctx, "supabase");
  return stage.id === "configuration";
}
/** Read-only observations never open a credential prompt or write resource configuration. */
export async function probeGuide(
  ctx: Context,
  stage: GuideStageId,
): Promise<GuideOperationResult> {
  if (stage === "cloudflare") return verifyGuideCloudflare(ctx);
  if (stage === "tunnel") return verifyGuideTunnel(ctx);
  if (stage !== "auth" || ctx.config.setup?.auth !== "supabase")
    return { status: "configured" };
  const p = values(ctx),
    token = ctx.data.credentials[p["@supabase"] ?? ""];
  if (
    !token ||
    !p.supabaseProjectRef ||
    !p.appOrigin ||
    p["@supabaseSource"] === "cli"
  )
    return { status: "configured" };
  const checked = await new Supabase(token, ctx.fetcher).authOrigins(
    p.supabaseProjectRef,
  );
  return {
    status:
      checked.site_url === p.appOrigin &&
      typeof checked.uri_allow_list === "string" &&
      checked.uri_allow_list
        .split(",")
        .map((s) => s.trim())
        .includes(`${p.appOrigin}/**`)
        ? "verified"
        : "configured",
  };
}
export async function performGuideStage(
  ctx: Context,
  stage: GuideStage,
  options: {
    actions: GuideActions;
    devices: DeviceStore;
    progress: GuideProgress;
    release?: typeof runReleaseFlow;
    select?: typeof selectDevice;
    componentIds?: string[];
  },
): Promise<GuideActionResult> {
  const call = async (id: string) => {
    const action = options.actions[id];
    if (!action)
      throw new Error("当前项目未提供此配置操作，请查看项目部署说明。");
    return action(ctx);
  };
  if (stage.id === "import") {
    await importUnifiedEnv(ctx);
    return {};
  }
  if (stage.id === "device") {
    const device = await (options.select ?? selectDevice)({
      ui: ctx.ui,
      store: options.devices,
      runner: ctx.runner,
    });
    if (device) {
      values(ctx)["@releaseDeviceId"] = device.id;
      if (Object.hasOwn(ctx.config.variables, "sshTarget")) {
        try {
          values(ctx).sshTarget = validateField(
            ctx.config,
            "sshTarget",
            `${device.user}@${device.host}`,
          );
        } catch {
          /* The release adapter still receives the validated complete device. */
        }
      }
    }
    return { device, outcome: { status: device ? "configured" : "cancelled" } };
  }
  if (stage.id === "configuration") {
    if (ctx.config.deploymentTopology === "aws-tunnel")
      return { outcome: await call("deployment.configure") };
    const pending: Record<string, string> = {};
    for (const field of stage.missingFields) {
      const definition = allFields(ctx.config)[field]!;
      pending[field] = validateField(
        ctx.config,
        field,
        await ctx.ui.input(definition.label, {
          secret: definition.secret,
          value: values(ctx)[field],
        }),
      );
    }
    Object.assign(values(ctx), pending);
    return { outcome: { status: "configured" } };
  }
  if (stage.id === "cloudflare")
    return {
      outcome: await call(
        boundCredential(ctx, "cloudflare") && stage.state !== "blocked"
          ? "cloudflare.pages"
          : "cloudflare.account",
      ),
    };
  if (stage.id === "supabase")
    return { outcome: await call("supabase.project") };
  if (stage.id === "tunnel")
    return { outcome: await call("deployment.tunnel") };
  if (stage.id === "auth" && ctx.config.setup?.auth === "supabase")
    return { outcome: await call("supabase.auth") };
  if (stage.id === "application" || stage.id === "pages") {
    const componentIds =
      options.componentIds ??
      ctx.config
        .release!.components.filter(
          (c) =>
            c.kind === (stage.id === "application" ? "application" : "pages"),
        )
        .map((c) => c.id);
    const result = await (options.release ?? runReleaseFlow)(ctx, {
      componentIds,
      deviceId: options.progress.deviceId,
      store: options.devices,
    });
    return { release: result };
  }
  ctx.ui.log(
    stage.id === "auth"
      ? "请按项目认证文档完成外部身份、域名与回调配置；这一步不会自动验证业务登录。"
      : "发布与基础健康不代替业务验收。请按以下项目清单完成登录、租户权限及已启用业务流程：",
  );
  for (const check of ctx.config.setup?.requirements ?? [])
    ctx.ui.log(
      `${check.title}：${check.instructions}${check.docs ? `；项目文档 ${check.docs}` : ""}`,
    );
  return { outcome: { status: "manual" } };
}
