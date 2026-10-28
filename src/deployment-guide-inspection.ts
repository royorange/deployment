import type { Device } from "./devices.ts";
import {
  createLifecycleController,
  lifecycleAvailable,
} from "./lifecycle-engine.ts";
import {
  releaseCloudflareToken,
  safeMessage,
  values,
  type Context,
} from "./wizard.ts";
import { Cloudflare } from "./providers.ts";
import { inspectPagesDeployment } from "./pages-status.ts";
import type { GuideOperationResult } from "./deployment-wizard.ts";

export type GuideApplicationObservation = {
  component: string;
  state: "running" | "unavailable";
  current?: string;
  controllerCommit?: string;
  message: string;
};

/** Recheck each component using its trusted, public-only lifecycle protocol. */
export async function inspectGuideApplication(
  ctx: Context,
  device: Device | undefined,
): Promise<GuideApplicationObservation[]> {
  const results: GuideApplicationObservation[] = [];
  for (const component of ctx.config.release?.components ?? []) {
    if (component.kind !== "application") continue;
    if (!device || !component.requiresDevice || !lifecycleAvailable(ctx)) {
      results.push({
        component: component.id,
        state: "unavailable",
        message: `${component.label}：未声明可用的只读生命周期检查或未选择设备；不能由历史记录认定已部署。`,
      });
      continue;
    }
    try {
      const controller = await createLifecycleController(
        ctx,
        component.id,
        device,
      );
      const result = await controller.inspect();
      const current = result.snapshot?.current;
      const healthy =
        result.ready &&
        result.missing.length === 0 &&
        result.snapshot?.state === "running" &&
        !!current;
      results.push({
        component: component.id,
        state: healthy ? "running" : "unavailable",
        controllerCommit: controller.commit,
        ...(healthy ? { current } : {}),
        message: healthy
          ? `${component.label}：实际运行 ${current}；检查控制器 ${controller.commit}。仅核验现有部署，不代表待发布配置已应用。`
          : `${component.label}：现有部署未通过运行与健康检查；请查看运行状态或发布，未跳过此组件。`,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ["ExitPromptError", "AbortPromptError"].includes(error.name)
      )
        throw error;
      results.push({
        component: component.id,
        state: "unavailable",
        message: safeMessage(error, ctx),
      });
    }
  }
  return results;
}

/** Provider publication evidence alone cannot establish origin or application health. */
export async function inspectGuidePages(
  ctx: Context,
): Promise<GuideOperationResult> {
  const components =
    ctx.config.release?.components.filter((c) => c.kind === "pages") ?? [];
  const declarations =
    ctx.config.setup?.components?.filter((c) => c.hosting === "pages") ?? [];
  const p = values(ctx);
  const messages: string[] = [];
  for (const component of components) {
    const declaration =
      declarations.find((c) => c.id === component.id) ??
      (components.length === 1 && declarations.length === 1
        ? declarations[0]
        : undefined);
    const branch = declaration?.branchField && p[declaration.branchField];
    const project = declaration?.projectField && p[declaration.projectField];
    const account = p.cloudflareAccountId;
    if (!branch || !project || !account) {
      messages.push(
        `${component.label}：请在项目声明中绑定 Pages 项目和真实部署分支；不会根据环境名称猜测分支。`,
      );
      continue;
    }
    const client = new Cloudflare(
      await releaseCloudflareToken(ctx),
      ctx.fetcher,
    );
    const resource = await client.pagesProject(account, project);
    if (!resource || resource.name !== project) {
      messages.push(
        `${component.label}：所绑定 Pages 项目不存在或不匹配；未创建资源。`,
      );
      continue;
    }
    const result = await inspectPagesDeployment(client, account, project, {
      branch,
      environment:
        branch === resource.production_branch ? "production" : "preview",
    });
    messages.push(
      `${component.label} / ${project} / ${branch}：${result.message}${result.deployment ? ` 部署 URL：${result.deployment.url}` : ""}`,
    );
  }
  return {
    status: "configured",
    message: [
      ...messages,
      "以上仅为 Pages API 证据；入口 HTTP、Access 与组件发布验证仍待完成，未标记部署阶段通过。",
    ].join("\n"),
  };
}
