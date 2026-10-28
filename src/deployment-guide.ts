import { homedir } from "node:os";
import { join } from "node:path";
import { allFields } from "./config.ts";
import type { Device } from "./devices.ts";
import { GuideProgressStore } from "./deployment-guide-store.ts";
import { guideStageBindings } from "./deployment-guide-bindings.ts";
import {
  deploymentGuideStages,
  guideBinding,
  guideReleaseGroups,
  type GuideHistory,
  type GuideStage,
  type GuideStageId,
} from "./deployment-guide-model.ts";
import {
  localStageComplete,
  operationResult,
  performGuideStage,
  probeGuide,
  type GuideActions,
} from "./deployment-guide-actions.ts";
import { openReleaseDevices, runReleaseFlow } from "./release-flow.ts";
import {
  inspectGuideApplication,
  inspectGuidePages,
  type GuideApplicationObservation,
} from "./deployment-guide-inspection.ts";
import { safeMessage, values, type Context } from "./wizard.ts";

type Dependencies = {
  directory?: string;
  commit?: () => Promise<string | undefined>;
  probe?: typeof probeGuide;
  release?: typeof runReleaseFlow;
  inspect?: typeof inspectGuideApplication;
};
const labels = {
  missing: "待配置",
  configured: "本地已配置",
  verified: "本次已核验",
  historical: "上次结果，待复查",
  blocked: "待处理",
  manual: "需人工验收",
};
const remoteStages = new Set<GuideStageId>(["cloudflare", "tunnel", "auth"]);
function interrupted(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["ExitPromptError", "AbortPromptError"].includes(error.name)
  );
}
async function currentCommit(ctx: Context): Promise<string | undefined> {
  try {
    const value = (
      await ctx.runner("git", ["--no-replace-objects", "rev-parse", "HEAD"], {
        cwd: ctx.root,
      })
    ).trim();
    return /^[a-f0-9]{40}$/.test(value) ? value : undefined;
  } catch {
    return;
  }
}
/** One resumable workflow. Only the existing release engine may migrate or publish. */
export async function deploymentGuide(
  ctx: Context,
  actions: GuideActions,
  dependencies: Dependencies = {},
): Promise<"exit" | "back"> {
  if (!ctx.config.release?.environments.includes(ctx.env))
    throw new Error("当前环境没有可执行发布声明，请先由项目配置发布适配器。");
  if (guideReleaseGroups(ctx.config).length > 2) {
    ctx.ui.log(
      "当前项目声明了交错组件发布顺序。请使用部署与发布 → 依次发布全部，按项目顺序执行；分组向导不会悄悄重排发布。",
    );
    return "back";
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const store = await GuideProgressStore.open(
    dependencies.directory ?? join(base, "project-setup", "guides"),
    {
      root: ctx.root,
      repository: ctx.config.repository,
      project: ctx.config.project,
      environment: ctx.env,
    },
    { memory: ctx.storageMode === "memory" },
  );
  const devices = await openReleaseDevices(ctx);
  const selectedDeviceId = values(ctx)["@releaseDeviceId"];
  let device: Device | undefined = devices.read(selectedDeviceId ?? "");
  let commit = await (dependencies.commit ?? (() => currentCommit(ctx)))();
  let progress = store.read(
    guideBinding(ctx.config, values(ctx), device, commit),
  );
  if (!selectedDeviceId && progress.deviceId)
    device = devices.read(progress.deviceId);
  if (device) progress.deviceId = device.id;
  const evidence: Partial<Record<GuideStageId, "verified" | "blocked">> = {};
  const attempted = new Set<GuideStageId>();
  const completedComponents = new Set<string>();
  let observations: GuideApplicationObservation[] = [];
  const componentIds = (stage: GuideStageId) =>
    ctx.config
      .release!.components.filter((c) => c.kind === stage)
      .map((c) => c.id);
  const clearComponents = (stage: GuideStageId) => {
    for (const id of componentIds(stage)) completedComponents.delete(id);
    if (stage === "application") observations = [];
  };
  const syncComponents = (stage: GuideStageId) => {
    const ids = componentIds(stage);
    if (ids.length && ids.every((id) => completedComponents.has(id)))
      evidence[stage] = "verified";
    else delete evidence[stage];
  };
  let stageBindings = guideStageBindings(
    ctx.config,
    values(ctx),
    device,
    commit,
    ctx.data.credentials,
  );
  let notice =
    "已有配置会复用；远端状态重新核验。发布、迁移及资源变更仍需明确确认。";
  let forced = false;
  const complete = (stage: GuideStage) => {
    if (stage.id === "import") return !!progress.importDisposition;
    if (stage.id === "acceptance") return false;
    if (stage.id === "auth" && ctx.config.setup?.auth !== "supabase")
      return progress.history.some(
        (h) => h.stage === "auth" && h.outcome === "configured",
      );
    if (
      stage.id === "cloudflare" &&
      ctx.config.release!.components.some((c) => c.kind === "pages")
    )
      return evidence.cloudflare === "verified" && !stage.missingFields.length;
    if (["tunnel", "auth", "application", "pages"].includes(stage.id))
      return stage.state === "verified";
    return localStageComplete(ctx, stage, device);
  };
  const stages = () =>
    deploymentGuideStages({
      config: ctx.config,
      values: values(ctx),
      device,
      commit,
      progress,
      evidence,
    });
  const record = (item: Omit<GuideHistory, "observedAt">) => {
    progress.history = [
      ...progress.history,
      { ...item, observedAt: new Date().toISOString() },
    ].slice(-64);
  };
  const save = async () => {
    await ctx.save();
    await store.save(progress);
  };
  const rebind = () => {
    const binding = guideBinding(ctx.config, values(ctx), device, commit);
    const next = guideStageBindings(
      ctx.config,
      values(ctx),
      device,
      commit,
      ctx.data.credentials,
    );
    const changed = new Set(
      (Object.keys(next) as GuideStageId[]).filter(
        (stage) => next[stage] !== stageBindings[stage],
      ),
    );
    for (const stage of changed) {
      delete evidence[stage];
      attempted.delete(stage);
      clearComponents(stage);
    }
    if (binding !== progress.binding || changed.size) {
      progress = {
        ...progress,
        binding,
        history: progress.history.filter((item) => !changed.has(item.stage)),
      };
    }
    stageBindings = next;
  };
  rebind();
  while (true) {
    rebind();
    const fresh = await (dependencies.commit ?? (() => currentCommit(ctx)))();
    if (fresh !== commit) {
      commit = fresh;
      rebind();
      notice = "提交或目标已变化，相关历史结果需重新核验。";
    }
    let list = stages();
    let current =
      list.find((s) => s.id === progress.cursor) ??
      list.find((s) => !complete(s))!;
    if (!forced && complete(current)) {
      delete progress.cursor;
      current = list.find((s) => !complete(s))!;
    }
    if (!current) throw new Error("引导阶段声明为空，未执行任何发布。");
    progress.cursor = current.id;
    const probeKey = current.id;
    if (
      !forced &&
      remoteStages.has(current.id) &&
      !current.missingFields.length &&
      !attempted.has(probeKey)
    ) {
      attempted.add(probeKey);
      ctx.ui.log(`正在只读检查：${current.title}；不会自动修改资源。`);
      try {
        const result = await (dependencies.probe ?? probeGuide)(
          ctx,
          current.id,
        );
        if (result.status === "verified") {
          evidence[current.id] = "verified";
          record({
            stage: current.id,
            outcome: "verified",
            ...(commit ? { commit } : {}),
          });
          await save();
          delete progress.cursor;
          continue;
        }
        if (result.message)
          notice = safeMessage(new Error(result.message), ctx);
      } catch (error) {
        if (interrupted(error)) throw error;
        evidence[current.id] = "blocked";
        notice = safeMessage(error, ctx);
      }
    }
    list = stages();
    current = list.find((s) => s.id === current.id)!;
    const number = list.findIndex((s) => s.id === current.id) + 1;
    const missing = current.missingFields.map(
      (f) => allFields(ctx.config)[f]?.label ?? f,
    );
    const configurable = list.filter(
      (stage) => !["application", "pages", "acceptance"].includes(stage.id),
    );
    const configured = configurable.filter((stage) =>
      stage.id === "import"
        ? !!progress.importDisposition
        : !stage.missingFields.length &&
          (["tunnel", "auth"].includes(stage.id) ||
            localStageComplete(ctx, { ...stage, state: "configured" }, device)),
    ).length;
    const verifiable = list.filter(
      (stage) =>
        remoteStages.has(stage.id) ||
        ["application", "pages"].includes(stage.id),
    );
    const verified = verifiable.filter(
      (stage) => evidence[stage.id] === "verified",
    ).length;
    const allPublished = list
      .filter((s) => ["application", "pages"].includes(s.id))
      .every(complete);
    const question = [
      `${ctx.config.project} / ${ctx.env} — 部署向导`,
      `阶段 ${number}/${list.length}：${current.title}`,
      `配置已就绪 ${configured}/${configurable.length}；本次已核验 ${verified}/${verifiable.length}；当前：${labels[current.state]}`,
      missing.length ? `待补齐：${missing.join("、")}` : "",
      ...(current.id === "application"
        ? observations.map(
            (item) =>
              `${item.component}：${item.state === "running" ? `实际运行 ${item.current}；待发布源码 ${commit ?? "未知"}；控制器 ${item.controllerCommit}` : "尚未核验运行"}`,
          )
        : []),
      notice,
      "仅目标依赖变化时重查相关阶段；历史结果不代替本次核验。",
    ]
      .filter(Boolean)
      .join("\n");
    const retryable =
      remoteStages.has(current.id) && !current.missingFields.length;
    const retainable =
      current.id === "application" &&
      observations.some(
        (item) =>
          item.state === "running" && !completedComponents.has(item.component),
      );
    const choice = await ctx.ui.select(question, [
      ...(current.id === "application"
        ? [
            {
              name: "只读检查已部署应用（不迁移、不重新发布）",
              value: "inspect",
            },
          ]
        : []),
      ...(current.id === "pages"
        ? [
            {
              name: "只读查看真实 Pages 部署（不发布）",
              value: "inspect-pages",
            },
          ]
        : []),
      ...(retainable
        ? [
            {
              name: "保留已核验的运行版本，继续其余组件（不应用待发布配置）",
              value: "keep-running",
            },
          ]
        : []),
      ...(retryable && current.state === "blocked"
        ? [{ name: "重新只读核验（不修改配置）", value: "recheck" }]
        : []),
      {
        name:
          current.id === "acceptance"
            ? "查看项目验收清单"
            : `${retryable && current.state === "blocked" ? "修改配置" : "继续"}：${current.title}`,
        value: "run",
      },
      ...(retryable && current.state !== "blocked"
        ? [{ name: "重新只读核验（不修改配置）", value: "recheck" }]
        : []),
      ...(current.id === "import"
        ? [{ name: "已有配置，跳过可选导入", value: "skip" }]
        : []),
      ...(current.id === "auth" && ctx.config.setup?.auth !== "supabase"
        ? [{ name: "记录外部配置已完成，业务仍待验收", value: "acknowledge" }]
        : []),
      ...(current.id === "tunnel"
        ? [{ name: "修复 Tunnel 管理 Token / 权限", value: "repair-tunnel" }]
        : []),
      ...(["cloudflare", "pages"].includes(current.id)
        ? [
            {
              name: "修复 Cloudflare 账号 / 发布凭据",
              value: "repair-cloudflare",
            },
          ]
        : []),
      ...(current.id === "acceptance" && allPublished
        ? [{ name: "完成本次部署向导，保留业务待验状态", value: "finish" }]
        : []),
      { name: "查看全部阶段 / 调整配置", value: "overview" },
      { name: "保存进度并退出", value: "exit" },
      { name: "返回主菜单", value: "back" },
    ]);
    if (choice === "exit" || choice === "back" || choice === "finish") {
      await save();
      if (choice === "finish")
        ctx.ui.log(
          "发布与基础健康检查已完成；业务验收仍按项目清单执行，未自动标记业务全部通过。",
        );
      return choice === "back" ? "back" : "exit";
    }
    if (choice === "inspect-pages") {
      delete evidence.pages;
      clearComponents("pages");
      try {
        const result = await inspectGuidePages(ctx);
        notice = safeMessage(new Error(result.message), ctx);
      } catch (error) {
        if (interrupted(error)) throw error;
        notice = safeMessage(error, ctx);
      }
      forced = true;
      continue;
    }
    if (choice === "inspect") {
      rebind();
      clearComponents("application");
      delete evidence.application;
      try {
        observations = await (dependencies.inspect ?? inspectGuideApplication)(
          ctx,
          device,
        );
        // Only declared component observations are eligible; failed/unknown checks never carry completion.
        const declared = new Set(componentIds("application"));
        if (
          observations.some((item) => !declared.has(item.component)) ||
          new Set(observations.map((item) => item.component)).size !==
            observations.length
        )
          throw new Error("只读检查返回未知或重复组件，未采纳运行证据。");
        notice =
          observations.map((item) => item.message).join("\n") ||
          "没有可核验的应用组件。";
      } catch (error) {
        if (interrupted(error)) throw error;
        observations = [];
        evidence.application = "blocked";
        notice = safeMessage(error, ctx);
      }
      forced = true;
      continue;
    }
    if (choice === "keep-running") {
      rebind();
      if (!observations.some((item) => item.state === "running")) {
        notice = "目标或配置已变化，运行证据已失效；请重新只读检查。";
        continue;
      }
      for (const item of observations) {
        if (
          item.state !== "running" ||
          !item.current ||
          !/^[a-f0-9]{40}$/.test(item.current)
        )
          continue;
        completedComponents.add(item.component);
        record({
          stage: "application",
          outcome: "verified",
          commit: item.current,
          component: item.component,
          phase: "verify",
        });
      }
      syncComponents("application");
      notice =
        "已保留本次核验的实际运行版本；待发布源码与配置尚未应用。不重复迁移或发布这些组件，业务仍待验收。";
      if (evidence.application === "verified") delete progress.cursor;
      forced = false;
      await save();
      continue;
    }
    if (choice === "recheck") {
      attempted.delete(current.id);
      delete evidence[current.id];
      forced = false;
      notice = "重新核验当前已保存的绑定；不会重新连接账号或修改资源。";
      continue;
    }
    if (choice === "overview") {
      const target = await ctx.ui.select(
        "部署阶段总览 — 已配置、已核验与历史结果分别显示",
        [
          ...list.map((s) => ({
            name: `[${s.id === "import" && complete(s) ? "已处理" : labels[s.state]}] ${s.title}`,
            value: `stage:${s.id}`,
          })),
          { name: "返回当前阶段", value: "back" },
        ],
      );
      if (target !== "back") {
        progress.cursor = target.slice(6) as GuideStageId;
        forced = true;
        await save();
      }
      continue;
    }
    if (choice === "skip") {
      progress.importDisposition = "skipped";
      delete progress.cursor;
      forced = false;
      notice = "已跳过可选导入；其余字段仍按实际配置检查。";
      await save();
      continue;
    }
    if (choice === "acknowledge") {
      record({ stage: "auth", outcome: "configured" });
      delete progress.cursor;
      forced = false;
      notice = "外部配置声明已记录，仍需在业务验收中验证。";
      await save();
      continue;
    }
    if (choice === "repair-cloudflare" || choice === "repair-tunnel") {
      const action =
        choice === "repair-tunnel"
          ? "deployment.management-token"
          : await ctx.ui.select("修复发布依赖 — 凭据仅在隐藏输入框输入", [
              { name: "重新连接 Cloudflare 账号", value: "cloudflare.account" },
              {
                name: "配置或更换 Pages 部署 Token",
                value: "cloudflare.ci-token",
              },
              { name: "重新选择 Pages 项目", value: "cloudflare.pages" },
              { name: "返回当前阶段", value: "back" },
            ]);
      if (action === "back") continue;
      try {
        const repair = actions[action];
        if (!repair) throw new Error("当前项目未提供此修复入口。");
        await repair(ctx);
        rebind();
        delete evidence.pages;
        clearComponents("pages");
        if (action === "deployment.management-token") {
          delete evidence.tunnel;
          attempted.delete("tunnel");
          progress.cursor = "tunnel";
        } else if (action !== "cloudflare.ci-token") {
          delete evidence.cloudflare;
          attempted.clear();
          progress.cursor = "cloudflare";
        }
        notice = "修复操作已返回，配置已保存；发布仍需重新确认和核验。";
      } catch (error) {
        if (interrupted(error)) throw error;
        rebind();
        notice = safeMessage(error, ctx);
      }
      await save();
      forced = false;
      continue;
    }
    if (choice !== "run") continue;
    if (["application", "pages"].includes(current.id)) {
      const before = list
        .slice(0, number - 1)
        .find((s) => s.id !== "acceptance" && !complete(s));
      if (before) {
        progress.cursor = before.id;
        forced = false;
        notice = `发布尚缺前置阶段：${before.title}。先完成此项，再继续发布。`;
        continue;
      }
    }
    if (["application", "pages"].includes(current.id) && complete(current))
      clearComponents(current.id);
    if (current.id === "application") observations = [];
    // Retain unrelated observations; publication must be explicitly checked again after adjustments.
    const invalidated: GuideStageId[] = [current.id];
    if (["application", "pages"].includes(current.id))
      invalidated.push("acceptance");
    else if (current.id !== "acceptance")
      invalidated.push("application", "pages", "acceptance");
    for (const stage of invalidated) {
      delete evidence[stage];
      attempted.delete(stage);
      if (!["application", "pages"].includes(current.id))
        clearComponents(stage);
    }
    const operationBinding = stageBindings[current.id];
    try {
      const result = await performGuideStage(ctx, current, {
        actions,
        devices,
        progress,
        release: dependencies.release,
        componentIds: ["application", "pages"].includes(current.id)
          ? componentIds(current.id).filter(
              (id) => !completedComponents.has(id),
            )
          : undefined,
      });
      if (result.device) {
        device = result.device;
        progress.deviceId = device.id;
      }
      rebind();
      if (current.id === "import") progress.importDisposition = "imported";
      const outcome = operationResult(result.outcome);
      if (result.release) {
        if (stageBindings[current.id] !== operationBinding)
          throw new Error(
            "发布期间目标或配置已变化；旧目标回执未采纳为当前目标成功，请重新只读核验。已完成的外部操作不会自动撤销。",
          );
        if (
          result.release.state !== "health-checked" &&
          result.release.receipts.length &&
          result.release.receipts.every((r) => r.state === "health-checked")
        )
          throw new Error(
            "发布流程与组件回执结果不一致，未采纳完成状态。请重新检查。",
          );
        for (const receipt of result.release.receipts) {
          if (
            !componentIds(current.id).includes(receipt.component) ||
            receipt.project !== ctx.config.project ||
            receipt.environment !== ctx.env
          )
            throw new Error("发布回执与当前组件目标不一致，未标记完成。");
          if (
            receipt.state === "health-checked" &&
            commit &&
            receipt.commit !== commit
          )
            throw new Error(
              "发布回执的提交与当前期望源码不同，未采纳完成状态。",
            );
          if (receipt.state === "health-checked")
            completedComponents.add(receipt.component);
          else completedComponents.delete(receipt.component);
          record({
            stage: current.id,
            outcome:
              receipt.state === "health-checked"
                ? "verified"
                : receipt.state === "cancelled"
                  ? "cancelled"
                  : "failed",
            commit: receipt.commit,
            component: receipt.component,
            database: receipt.database,
            ...([
              "plan",
              "migration",
              "pre-deploy-check",
              "deploy",
              "verify",
            ].includes(receipt.phase)
              ? { phase: receipt.phase }
              : {}),
          });
        }
        syncComponents(current.id);
        const changed = result.release.receipts.some(
          (r) => r.database === "applied" || r.database === "unknown",
        );
        notice = changed
          ? "数据库已变更或结果未知；不会自动回滚。应用、Pages 与业务验收仍分别记录。"
          : result.release.state === "health-checked"
            ? "当前组件发布与基础健康核验通过，继续下一阶段。"
            : "本阶段未完成，已停在当前步骤；可重试或保存退出。";
      } else {
        if (outcome?.status === "verified") evidence[current.id] = "verified";
        const checked = stages().find((s) => s.id === current.id)!;
        const configured = localStageComplete(ctx, checked, device);
        record({
          stage: current.id,
          outcome:
            outcome?.status === "verified"
              ? "verified"
              : outcome?.status === "cancelled"
                ? "cancelled"
                : configured || current.id === "import"
                  ? "configured"
                  : "cancelled",
          ...(commit ? { commit } : {}),
        });
        notice =
          (outcome?.message
            ? safeMessage(new Error(outcome.message), ctx)
            : undefined) ??
          (complete(checked)
            ? "本阶段配置已保存；接下来检查下一项。"
            : "操作已返回，但尚未确认本阶段完成；继续处理当前步骤，不会自动发布。");
      }
      forced = false;
      const after = stages().find((s) => s.id === current.id)!;
      if (complete(after)) delete progress.cursor;
      await save();
    } catch (error) {
      if (interrupted(error)) throw error;
      rebind();
      progress.cursor = current.id;
      evidence[current.id] = "blocked";
      record({
        stage: current.id,
        outcome: "failed",
        ...(commit ? { commit } : {}),
      });
      notice = `${safeMessage(error, ctx)}
已停在当前阶段；已保存的配置保留，可重试或保存退出。`;
      await save();
      forced = false;
    }
  }
}
