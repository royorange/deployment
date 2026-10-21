import { homedir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { deviceMenu, selectDevice } from "./device-menu.ts";
import { readReleaseCi } from "./release-ci.ts";
import { runRelease } from "./release-engine.ts";
import { releaseCheckout } from "./release-preflight.ts";
import {
  modules,
  operations,
  safeMessage,
  values,
  type Context,
} from "./wizard.ts";

export async function releaseMenu(ctx: Context): Promise<void> {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const store = await DeviceStore.open(
    ctx.deviceDirectory ?? join(base, "project-setup", "devices"),
    { memory: ctx.storageMode === "memory" },
  );
  while (true) {
    const selected = await ctx.ui.select(
      `${ctx.config.project} / ${ctx.env} — 部署与发布`,
      [
        { name: "部署应用 / API / Pages", value: "deploy" },
        { name: "创建或配置 Tunnel / DNS / 连接 Token", value: "tunnel" },
        { name: "导入/导出统一 .env（可选）", value: "export" },
        { name: "部署主机（保存 IP、用户名、端口）", value: "devices" },
        { name: "核验 CI / 启动镜像构建", value: "ci" },
        { name: "返回主菜单", value: "back" },
      ],
    );
    if (selected === "back") return;
    try {
      if (selected === "devices") {
        await deviceMenu({ ui: ctx.ui, store, runner: ctx.runner });
        continue;
      }
      if (selected === "tunnel") {
        if (ctx.config.deploymentTopology !== "aws-tunnel")
          throw new Error(
            "当前自动Tunnel路由仅支持明确的AWS整站拓扑，其他拓扑沿用项目流程。",
          );
        const module = modules.find((item) => item.id === "deployment")!;
        const chosen = await ctx.ui.select("Tunnel 基础设施 — 每次变更先预览", [
          ...module.actions
            .filter((item) =>
              ["configure", "management-token", "tunnel", "host"].includes(
                item.id,
              ),
            )
            .map((item) => ({ name: item.title, value: item.id })),
          { name: "返回", value: "back" },
        ]);
        if (chosen !== "back") {
          await module.actions.find((item) => item.id === chosen)!.execute(ctx);
          await ctx.save();
        }
        continue;
      }
      if (selected === "export") {
        const method = await ctx.ui.select("统一配置传输 — 部署无需导出文件", [
          { name: "导入统一 .env / 旧配置文件", value: "import" },
          { name: "导出统一 .env / 其他目标", value: "env" },
          { name: "返回", value: "back" },
        ]);
        if (method === "env") await operations.export(ctx);
        if (method === "import") {
          await operations.import(ctx);
          await ctx.save();
        }
        continue;
      }
      const release = ctx.config.release;
      if (
        !release ||
        !ctx.config.repository ||
        !release.environments.includes(ctx.env)
      )
        throw new Error(
          "当前环境尚未声明项目release适配器和组件。请由项目维护者提交deploy适配器与release映射；主机与Tunnel仍可先配置。",
        );
      if (selected === "ci") {
        const sha = await releaseCheckout(ctx);
        const ci = await readReleaseCi({
          repository: ctx.config.repository,
          workflow: release.ciWorkflow,
          sha,
          runner: ctx.runner,
        });
        ctx.ui.log(
          `提交：${sha}；CI：${ci.state}${ci.url ? `；${ci.url}` : ""}`,
        );
        if (
          release.buildWorkflow &&
          ci.state === "passed" &&
          (await ctx.ui.confirm(
            `运行 ${release.buildWorkflow} 构建此提交的镜像？此操作只构建，不发布应用。`,
          ))
        ) {
          await ctx.runner("gh", [
            "workflow",
            "run",
            release.buildWorkflow,
            "--repo",
            ctx.config.repository,
            "--ref",
            release.buildWorkflowRef ?? "main",
            "--raw-field",
            `commit=${sha}`,
          ]);
          ctx.ui.log(
            `构建请求已提交；在 https://github.com/${ctx.config.repository}/actions 查看结果，将镜像digest填入部署配置后再发布。`,
          );
        }
        continue;
      }
      if (selected === "deploy") {
        const chosen = await ctx.ui.select("选择发布组件", [
          ...release.components.map((item) => ({
            name: item.label,
            value: `component:${item.id}`,
          })),
          ...(release.components.length > 1
            ? [{ name: "依次发布全部（应用先于Pages）", value: "all" }]
            : []),
          { name: "返回", value: "back" },
        ]);
        if (chosen === "back") continue;
        const components =
          chosen === "all"
            ? [...release.components].sort(
                (a, b) =>
                  Number(a.kind === "pages") - Number(b.kind === "pages"),
              )
            : release.components.filter(
                (item) => `component:${item.id}` === chosen,
              );
        const device = components.some((item) => item.requiresDevice)
          ? await selectDevice({ ui: ctx.ui, store, runner: ctx.runner })
          : undefined;
        if (components.some((item) => item.requiresDevice) && !device) continue;
        if (
          components.some((item) => item.kind === "application") &&
          ctx.config.deploymentTopology === "aws-tunnel" &&
          !values(ctx).cloudflareTunnelId
        ) {
          ctx.ui.log(
            "缺少当前环境的独立Tunnel。请先进入本页Tunnel基础设施操作，完成后直接部署，无需导出文件。",
          );
          continue;
        }
        for (const component of components) {
          const receipt = await runRelease(
            ctx,
            component.id,
            component.requiresDevice ? device : undefined,
          );
          if (receipt.state !== "health-checked") {
            ctx.ui.log(
              "本次流程已停止；已完成组件和数据库变更保留，请根据结果重试对应阶段。",
            );
            break;
          }
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        ["ExitPromptError", "AbortPromptError"].includes(error.name)
      )
        throw error;
      ctx.ui.log(safeMessage(error, ctx));
    }
  }
}
