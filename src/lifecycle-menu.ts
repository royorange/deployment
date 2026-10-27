import type { LifecycleOutput } from "./lifecycle-protocol.ts";
import { selectDevice } from "./device-menu.ts";
import type { DeviceStore } from "./devices.ts";
import {
  createLifecycleController,
  lifecycleAvailable,
} from "./lifecycle-engine.ts";
import { openReleaseDevices } from "./release-flow.ts";
import { safeMessage, values, type Context } from "./wizard.ts";
function interrupted(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["ExitPromptError", "AbortPromptError"].includes(error.name)
  );
}
export async function lifecycleMenu(
  ctx: Context,
  options: { store?: DeviceStore } = {},
): Promise<void> {
  if (!lifecycleAvailable(ctx))
    throw new Error(
      "当前环境未声明运行生命周期；请先由项目维护者配置受信适配器。",
    );
  const components = ctx.config.release!.components.filter(
    (c) => c.kind === "application" && c.requiresDevice,
  );
  const componentId =
    components.length === 1
      ? components[0]!.id
      : await ctx.ui.select("选择运行组件", [
          ...components.map((c) => ({ name: c.label, value: c.id })),
          { name: "返回", value: "back" },
        ]);
  if (componentId === "back") return;
  const store = options.store ?? (await openReleaseDevices(ctx)),
    saved = values(ctx)["@releaseDeviceId"];
  const device = saved
    ? store.read(saved)
    : await selectDevice({ ui: ctx.ui, store, runner: ctx.runner });
  if (!device) {
    ctx.ui.log(
      saved
        ? "已保存的部署设备档案缺失；请重新登记或选择设备，不会改用其他主机。"
        : "已取消选择设备。",
    );
    return;
  }
  if (!saved) {
    values(ctx)["@releaseDeviceId"] = device.id;
    await ctx.save();
  }
  let controller;
  try {
    controller = await createLifecycleController(ctx, componentId, device);
  } catch (error) {
    if (error instanceof Error && error.name === "LifecycleCancelled") return;
    throw error;
  }
  while (true) {
    let status: LifecycleOutput | undefined;
    try {
      status = await controller.inspect();
    } catch (error) {
      if (interrupted(error)) throw error;
      ctx.ui.log(safeMessage(error, ctx));
    }
    const state = status?.snapshot?.state ?? "unknown";
    const action = await ctx.ui.select(
      `${ctx.config.project}/${ctx.env} · 运行状态与监控\n设备：${device.label} (${device.user}@${device.host}:${device.port})\n状态：${state}；当前版本：${status?.snapshot?.current ?? "无 / 未确认"}\n只读刷新不会修改资源；关闭仅停止本项目应用与连接器，数据库、Pages、DNS和磁盘文件保留。`,
      [
        { name: "刷新状态 / 资源 / 健康与操作历史", value: "refresh" },
        ...(["running", "degraded"].includes(state)
          ? [{ name: "停止当前环境", value: "stop" }]
          : []),
        ...(state === "stopped"
          ? [{ name: "恢复当前环境", value: "resume" }]
          : []),
        ...(["running", "stopped", "degraded"].includes(state) &&
        status?.snapshot?.revisions?.some(
          (r) => r.compatible && r.revision !== status.snapshot?.current,
        )
          ? [{ name: "回退兼容的已成功版本", value: "rollback" }]
          : []),
        { name: "返回部署与发布", value: "back" },
      ],
    );
    if (action === "back") return;
    if (action === "refresh") continue;
    try {
      let target: string | undefined;
      if (action === "rollback") {
        target = await ctx.ui.select(
          "选择已核验的回退版本；仅允许数据库迁移集与资源绑定兼容的版本",
          [
            ...(status?.snapshot?.revisions ?? [])
              .filter(
                (r) => r.compatible && r.revision !== status?.snapshot?.current,
              )
              .map((r) => ({
                name: `${r.revision} · ${safeMessage(new Error(r.reason), ctx)}`,
                value: r.revision,
              })),
            { name: "取消", value: "back" },
          ],
        );
        if (target === "back") continue;
      }
      if (!["stop", "resume", "rollback"].includes(action)) continue;
      const result = await controller.change(
        action as "stop" | "resume" | "rollback",
        target,
      );
      ctx.ui.log(
        result.state === "completed"
          ? "生命周期操作及最新状态核验通过。"
          : result.state === "cancelled"
            ? "已取消操作。"
            : "操作未通过；请查看最新状态与操作历史，未自动标记成功。",
      );
    } catch (error) {
      if (interrupted(error)) throw error;
      ctx.ui.log(safeMessage(error, ctx));
    }
  }
}
