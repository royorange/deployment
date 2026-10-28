import { homedir } from "node:os";
import { join } from "node:path";
import { selectDevice } from "./device-menu.ts";
import { DeviceStore, type Device } from "./devices.ts";
import { runRelease, type ReleaseReceipt } from "./release-engine.ts";
import { safeMessage, values, type Context } from "./wizard.ts";

export type ReleaseFlowOptions = {
  componentIds?: string[];
  deviceId?: string;
  chooseDevice?: boolean;
  store?: DeviceStore;
};
export type ReleaseFlowResult = {
  state: "health-checked" | "cancelled" | "blocked" | "failed";
  receipts: ReleaseReceipt[];
  deviceId?: string;
  reason?:
    | "missing-release"
    | "unknown-component"
    | "missing-tunnel"
    | "missing-device"
    | "release-error";
};
export async function openReleaseDevices(ctx: Context): Promise<DeviceStore> {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return DeviceStore.open(
    ctx.deviceDirectory ?? join(base, "project-setup", "devices"),
    { memory: ctx.storageMode === "memory" },
  );
}

/** Public orchestration for both the menu and a direct guided component step. */
export async function runReleaseFlow(
  ctx: Context,
  options: ReleaseFlowOptions = {},
  dependencies: { run?: typeof runRelease } = {},
): Promise<ReleaseFlowResult> {
  const receipts: ReleaseReceipt[] = [];
  let device: Device | undefined;
  const result = (
    state: ReleaseFlowResult["state"],
    reason?: ReleaseFlowResult["reason"],
  ): ReleaseFlowResult => ({
    state,
    receipts,
    ...(device ? { deviceId: device.id } : {}),
    ...(reason ? { reason } : {}),
  });
  try {
    const release = ctx.config.release;
    if (
      !release ||
      !ctx.config.repository ||
      !release.environments.includes(ctx.env)
    ) {
      ctx.ui.log(
        "当前环境尚未声明项目release适配器和组件。请由项目维护者提交deploy适配器与release映射；主机与Tunnel仍可先配置。",
      );
      return result("blocked", "missing-release");
    }
    let ids = options.componentIds;
    if (ids === undefined) {
      const chosen = await ctx.ui.select("选择发布组件", [
        ...release.components.map((component) => ({
          name: component.label,
          value: `component:${component.id}`,
        })),
        ...(release.components.length > 1
          ? [
              {
                name: release.order
                  ? "依次发布全部（项目声明顺序）"
                  : "依次发布全部（应用先于Pages）",
                value: "all",
              },
            ]
          : []),
        { name: "返回", value: "back" },
      ]);
      if (chosen === "back") return result("cancelled");
      ids =
        chosen === "all"
          ? release.components.map((component) => component.id)
          : [chosen.startsWith("component:") ? chosen.slice(10) : ""];
    }
    if (!ids.length) return result("cancelled");
    if (
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) => !release.components.some((component) => component.id === id),
      )
    ) {
      ctx.ui.log("未知或重复的发布组件；请重新选择当前项目声明的组件。");
      return result("blocked", "unknown-component");
    }
    const components = ids
      .map((id) => release.components.find((component) => component.id === id)!)
      .sort((a, b) =>
        release.order
          ? release.order.indexOf(a.id) - release.order.indexOf(b.id)
          : Number(a.kind === "pages") - Number(b.kind === "pages"),
      );
    if (
      components.some((component) => component.kind === "application") &&
      ctx.config.deploymentTopology === "aws-tunnel" &&
      !values(ctx).cloudflareTunnelId
    ) {
      ctx.ui.log(
        "缺少当前环境的独立Tunnel。请先配置Tunnel基础设施，完成后直接部署，无需导出文件。",
      );
      return result("blocked", "missing-tunnel");
    }
    if (components.some((component) => component.requiresDevice)) {
      const store = options.store ?? (await openReleaseDevices(ctx));
      const savedId = options.chooseDevice
        ? undefined
        : (options.deviceId ?? values(ctx)["@releaseDeviceId"]);
      if (savedId) {
        device = store.read(savedId);
        if (!device) {
          ctx.ui.log(
            "已保存的部署设备不在登记档案中。请重新选择或登记部署主机，不会改用其他主机。",
          );
          return result("blocked", "missing-device");
        }
        ctx.ui.log(
          `复用已登记的部署设备：${device.label} (${device.user}@${device.host}:${device.port})；发布计划仍会要求确认目标。`,
        );
      } else {
        device = await selectDevice({ ui: ctx.ui, store, runner: ctx.runner });
        if (!device) return result("cancelled");
      }
      if (values(ctx)["@releaseDeviceId"] !== device.id) {
        values(ctx)["@releaseDeviceId"] = device.id;
        await ctx.save();
      }
    }
    for (const component of components) {
      const receipt = await (dependencies.run ?? runRelease)(
        ctx,
        component.id,
        component.requiresDevice ? device : undefined,
      );
      if (
        !receipt ||
        receipt.project !== ctx.config.project ||
        receipt.environment !== ctx.env ||
        receipt.component !== component.id
      )
        throw new Error(
          "发布执行未返回当前项目、环境与组件的明确回执，未标记完成。",
        );
      receipts.push(receipt);
      if (receipt.state !== "health-checked") {
        ctx.ui.log(
          "本次流程已停止；已完成组件和数据库变更保留，请根据结果重试对应阶段。",
        );
        return result(receipt.state === "cancelled" ? "cancelled" : "failed");
      }
    }
    return result("health-checked");
  } catch (error) {
    if (
      error instanceof Error &&
      ["ExitPromptError", "AbortPromptError"].includes(error.name)
    )
      throw error;
    ctx.ui.log(safeMessage(error, ctx));
    return result("failed", "release-error");
  }
}
