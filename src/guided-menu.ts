import { deploymentGuide } from "./deployment-guide.ts";
import { releaseMenu } from "./release-menu.ts";
import { withPagesEvidence } from "./setup-evidence.ts";
import { setupChecks, type SetupCheck } from "./setup-model.ts";
import {
  modules,
  operations,
  safeMessage,
  values,
  type Context,
} from "./wizard.ts";

export type SetupActions = Record<string, (ctx: Context) => Promise<unknown>>;
const defaultActions: SetupActions = {
  ...operations,
  release: releaseMenu,
  ...Object.fromEntries(
    modules.flatMap((module) =>
      module.actions.map((action) => [
        `${module.id}.${action.id}`,
        action.execute,
      ]),
    ),
  ),
};
const stateLabels: Record<SetupCheck["state"], string> = {
  missing: "缺失",
  configured: "本地已配置",
  unknown: "未知 / 待验证",
  manual: "需项目流程验证",
  published: "API 确认发布（业务待验）",
};
const homeChoices = [
  { name: "引导配置 / 继续配置", value: "guide" },
  { name: "账号、项目与服务", value: "services" },
  { name: "查看状态 / 补齐缺项", value: "status" },
  { name: "导入与导出", value: "transfer" },
  { name: "部署与发布", value: "release" },
  { name: "保存并退出", value: "exit" },
];
function currentChecks(ctx: Context): SetupCheck[] {
  return withPagesEvidence(
    ctx.config,
    values(ctx),
    setupChecks(ctx.config, values(ctx)),
    ctx.runtime?.pagesEvidence?.[ctx.env],
  );
}
function summary(ctx: Context): string {
  const checks = currentChecks(ctx);
  return `${checks.filter((check) => check.state === "missing").length} 项缺失，${checks.filter((check) => ["unknown", "manual"].includes(check.state)).length} 项待验证`;
}
async function execute(
  ctx: Context,
  id: string,
  actions: SetupActions,
): Promise<void> {
  try {
    const action = actions[id];
    if (!action) throw new Error("此步骤尚无自动配置入口，请按项目说明处理。");
    await action(ctx);
    await ctx.save();
    ctx.ui.log(
      ctx.storageMode === "memory"
        ? "操作已返回。内存模式不自动保存；请重新检查当前状态。"
        : "操作已返回，配置已保存；取消或未验证的步骤仍会保留为缺失或待验证。",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      ["ExitPromptError", "AbortPromptError"].includes(error.name)
    )
      throw error;
    ctx.ui.log(safeMessage(error, ctx));
  }
  await ctx.ui.select("操作结果 — 请查看上方说明", [
    { name: "继续当前流程", value: "continue" },
  ]);
}
async function step(
  ctx: Context,
  id: string,
  actions: SetupActions,
): Promise<boolean> {
  while (true) {
    const check = currentChecks(ctx).find((item) => item.id === id);
    if (!check) return false;
    const action = await ctx.ui.select(
      [
        check.title,
        `用途：${check.purpose}`,
        `当前：${stateLabels[check.state]}`,
        `在哪里、如何配置：${check.instructions}`,
        "本地配置不代表远端资源已就绪或业务已验收；请按提示验证。",
      ].join("\n"),
      [
        ...(check.action ? [{ name: "进入配置 / 检查", value: "run" }] : []),
        { name: "重新检查本地配置", value: "recheck" },
        { name: "继续下一步（保留当前待验证状态）", value: "next" },
        { name: "稍后处理 / 返回上一级", value: "back" },
      ],
    );
    if (action === "back") return false;
    if (action === "next") return true;
    if (action === "run" && check.action)
      await execute(ctx, check.action, actions);
  }
}
async function guide(ctx: Context, actions: SetupActions): Promise<void> {
  const deferred = new Set<string>();
  while (true) {
    const checks = currentChecks(ctx);
    const next = checks.find(
      (check) =>
        !["configured", "published"].includes(check.state) &&
        !deferred.has(check.id),
    );
    const choice = await ctx.ui.select(
      `${ctx.config.project} / ${ctx.env} — 引导配置\n${summary(ctx)}。每一步都可返回或稍后处理，重新进入时按当前配置继续。`,
      [
        ...(next
          ? [
              { name: `推荐下一项：${next.title}`, value: "next" },
              { name: "这项稍后处理，查看下一项", value: "later" },
            ]
          : []),
        { name: "选择其他配置步骤", value: "all" },
        { name: "返回主菜单", value: "back" },
      ],
    );
    if (choice === "back") return;
    if (choice === "later" && next) deferred.add(next.id);
    if (choice === "next" && next && (await step(ctx, next.id, actions)))
      deferred.add(next.id);
    if (choice === "all") await statusScreen(ctx, actions);
  }
}
async function statusScreen(
  ctx: Context,
  actions: SetupActions,
): Promise<void> {
  while (true) {
    const checks = currentChecks(ctx);
    const choice = await ctx.ui.select(
      `${ctx.config.project} / ${ctx.env} — 状态与下一步\n${summary(ctx)}。本地配置不代表资源已部署或业务可运行。`,
      [
        ...checks.map((check) => ({
          name: `[${stateLabels[check.state]}] ${check.title}`,
          value: `check:${check.id}`,
        })),
        {
          name: "只读刷新账号 / GitHub 配置明细（需要网络）",
          value: "details",
        },
        { name: "返回上一级", value: "back" },
      ],
    );
    if (choice === "back") return;
    if (choice === "details") await execute(ctx, "status", actions);
    else if (choice.startsWith("check:"))
      await step(ctx, choice.slice(6), actions);
  }
}
function available(ctx: Context, moduleId: string, actionId: string): boolean {
  if (moduleId === "deployment" && actionId === "token-file") return false;
  if (
    moduleId === "cloudflare" &&
    actionId === "worker" &&
    ctx.config.deploymentTopology === "aws-tunnel"
  )
    return false;
  if (
    moduleId === "supabase" &&
    actionId === "auth" &&
    ctx.config.setup?.auth &&
    ctx.config.setup.auth !== "supabase"
  )
    return false;
  if (
    moduleId === "supabase" &&
    actionId === "migrations" &&
    ctx.config.migrationStrategy !== "supabase-cli"
  )
    return false;
  return true;
}
async function services(ctx: Context, actions: SetupActions): Promise<void> {
  while (true) {
    const candidates = modules.filter(
      (module) =>
        module.id !== "deployment" ||
        ctx.config.deploymentTopology === "aws-tunnel",
    );
    const selected = await ctx.ui.select(
      "账号与服务 — 先选服务，再按步骤操作",
      [
        ...candidates.map((module) => ({
          name: module.title,
          value: module.id,
        })),
        { name: "项目、环境与高级设置", value: "advanced" },
        { name: "返回主菜单", value: "back" },
      ],
    );
    if (selected === "back") return;
    if (selected === "advanced") {
      await advanced(ctx, actions);
      continue;
    }
    const module = candidates.find((item) => item.id === selected);
    if (!module) continue;
    while (true) {
      const action = await ctx.ui.select(`${module.title} — 账号与服务`, [
        ...module.actions
          .filter((item) => available(ctx, module.id, item.id))
          .map((item) => ({
            name: item.title,
            value: `${module.id}.${item.id}`,
          })),
        { name: "返回服务列表", value: "back" },
      ]);
      if (action === "back") break;
      await execute(ctx, action, actions);
    }
  }
}
async function transfer(ctx: Context, actions: SetupActions): Promise<void> {
  while (true) {
    const choice = await ctx.ui.select("导入与导出 — 只处理当前项目与环境", [
      { name: "导入本地 .env / 配置", value: "import" },
      { name: "导出 .env / 剪贴板 / GitHub / 项目 JSON", value: "export" },
      { name: "返回主菜单", value: "back" },
    ]);
    if (choice === "back") return;
    await execute(ctx, choice, actions);
  }
}
async function advanced(ctx: Context, actions: SetupActions): Promise<void> {
  while (true) {
    const choice = await ctx.ui.select(
      `项目：${ctx.config.project}\n目录：${safeMessage(new Error(ctx.root), ctx)}\n当前环境：${ctx.env}\n切换项目请保存退出后重新运行 project-setup，可选择已记录的项目。`,
      [
        { name: "切换环境", value: "environment" },
        { name: "编辑配置字段", value: "edit" },
        { name: "返回主菜单", value: "back" },
      ],
    );
    if (choice === "back") return;
    if (choice === "edit") await execute(ctx, "edit", actions);
    if (choice === "environment")
      ctx.env = await ctx.ui.select(
        "选择环境",
        ctx.config.environments.map((env) => ({ name: env, value: env })),
      );
  }
}
export async function guidedWizard(
  ctx: Context,
  actions: SetupActions = defaultActions,
): Promise<void> {
  while (true) {
    const selected = await ctx.ui.select(
      `${ctx.config.project} / ${ctx.env} — 配置中心\n${summary(ctx)}`,
      homeChoices.map((choice) =>
        choice.value === "guide" &&
        ctx.config.release?.environments.includes(ctx.env)
          ? { ...choice, name: "开始 / 继续部署（自动引导）" }
          : choice,
      ),
    );
    if (selected === "exit") {
      await ctx.save();
      return;
    }
    if (selected === "guide") {
      try {
        if (ctx.config.release?.environments.includes(ctx.env)) {
          if ((await deploymentGuide(ctx, actions)) === "exit") return;
        } else await guide(ctx, actions);
      } catch (error) {
        if (
          error instanceof Error &&
          ["ExitPromptError", "AbortPromptError"].includes(error.name)
        )
          throw error;
        ctx.ui.log(safeMessage(error, ctx));
      }
    }
    if (selected === "services") await services(ctx, actions);
    if (selected === "status") await statusScreen(ctx, actions);
    if (selected === "transfer") await transfer(ctx, actions);
    if (selected === "release") {
      try {
        await actions.release?.(ctx);
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
}
