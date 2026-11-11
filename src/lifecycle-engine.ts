import { resolve } from "node:path";
import { allFields, validateField } from "./config.ts";
import { validateDevice, type Device } from "./devices.ts";
import { assertReleaseCi } from "./release-ci.ts";
import {
  releaseCheckout,
  releaseProcessEnvironment,
} from "./release-preflight.ts";
import {
  lifecycleOutput,
  type LifecycleOperation,
  type LifecycleOutput,
  type LifecycleRequest,
} from "./lifecycle-protocol.ts";
import { lifecycleAudit, lockLifecycle } from "./lifecycle-audit.ts";
import { safeMessage, values, type Context } from "./wizard.ts";
export type LifecycleResult = {
  state: "completed" | "cancelled" | "blocked" | "failed";
  output?: LifecycleOutput;
};
function interrupted(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["ExitPromptError", "AbortPromptError"].includes(error.name)
  );
}
export function lifecycleAvailable(ctx: Context): boolean {
  const release = ctx.config.release;
  return (
    !!release?.lifecycle &&
    release.environments.includes(ctx.env) &&
    release.lifecycle.environments.includes(ctx.env) &&
    release.components.some((c) => c.kind === "application" && c.requiresDevice)
  );
}
export async function createLifecycleController(
  ctx: Context,
  componentId: string,
  device: Device,
) {
  const release = ctx.config.release;
  const component = release?.components.find(
    (c) => c.id === componentId && c.kind === "application" && c.requiresDevice,
  );
  if (
    !lifecycleAvailable(ctx) ||
    !release?.lifecycle ||
    !component ||
    !ctx.config.repository
  )
    throw new Error("当前项目、环境或组件未声明可用生命周期适配器。");
  const selected = validateDevice(device),
    adapter = release.lifecycle.adapter;
  const project = ctx.config.project,
    environment = ctx.env,
    repository = ctx.config.repository,
    root = ctx.root,
    declaration = JSON.stringify(release);
  const fields = [...(release.publicFields ?? [])];
  const auditContext = {
    ...ctx,
    env: environment,
    config: { ...ctx.config, project },
  };
  const commit = await releaseCheckout(ctx, adapter);
  if (
    !(await ctx.ui.confirm(
      `允许执行已提交的生命周期适配器 ${adapter} 读取状态？提交 ${commit}；设备 ${selected.label} (${selected.user}@${selected.host}:${selected.port})。只传公开配置，不读取运行凭据；停止、恢复与回退另需计划确认。`,
    ))
  ) {
    const e = new Error("已取消读取生命周期状态。");
    e.name = "LifecycleCancelled";
    throw e;
  }
  const readPublicValues = (): Record<string, string> => {
    const snapshot: Record<string, string> = {};
    for (const field of fields) {
      if (allFields(ctx.config)[field]?.secret)
        throw new Error("生命周期公开字段包含敏感项，已停止。");
      if (values(ctx)[field])
        snapshot[field] = validateField(ctx.config, field, values(ctx)[field]!);
    }
    return snapshot;
  };
  const publicValues = readPublicValues();
  const selectedId = values(ctx)["@releaseDeviceId"];
  const checkSource = async () => {
    if (
      ctx.root !== root ||
      JSON.stringify(ctx.config.release) !== declaration ||
      ctx.config.project !== project ||
      ctx.env !== environment ||
      ctx.config.repository !== repository ||
      ctx.config.release?.lifecycle?.adapter !== adapter ||
      JSON.stringify(readPublicValues()) !== JSON.stringify(publicValues) ||
      values(ctx)["@releaseDeviceId"] !== selectedId
    )
      throw new Error("生命周期目标或环境已变化，请重新审阅计划。");
    if ((await releaseCheckout(ctx, adapter)) !== commit)
      throw new Error("生命周期控制器提交或工作区已变化，请重新打开状态页。");
  };
  const show = (out: LifecycleOutput) => {
    for (const line of [...out.summary, ...out.missing, ...out.effects])
      ctx.ui.log(safeMessage(new Error(line), ctx));
  };
  const call = async (
    phase: "inspect" | "apply",
    operation: LifecycleOperation,
    extra: Partial<
      Pick<LifecycleRequest, "expectedToken" | "targetRevision">
    > = {},
  ) => {
    if (!["status", "stop", "resume", "rollback"].includes(operation))
      throw new Error("未知生命周期操作。");
    await checkSource();
    const request: LifecycleRequest = {
      version: 1,
      project,
      environment,
      component: componentId,
      operation,
      commit,
      device: selected,
      publicValues: { ...publicValues },
      ...extra,
    };
    const output = lifecycleOutput(
      await ctx.runner(
        process.execPath,
        [
          "--experimental-strip-types",
          resolve(ctx.root, adapter),
          "--phase",
          phase,
        ],
        {
          cwd: ctx.root,
          input: JSON.stringify(request),
          env: releaseProcessEnvironment(),
          timeout: phase === "inspect" ? 120_000 : 600_000,
        },
      ),
    );
    show(output);
    return output;
  };
  const inspect = async (
    operation: LifecycleOperation = "status",
    targetRevision?: string,
  ) => call("inspect", operation, targetRevision ? { targetRevision } : {});
  const change = async (
    operation: Exclude<LifecycleOperation, "status">,
    targetRevision?: string,
  ): Promise<LifecycleResult> => {
    if (
      operation === "rollback" &&
      (!targetRevision || !/^[a-f0-9]{40}$/.test(targetRevision))
    )
      throw new Error("回退需要明确的已验证版本。");
    if (operation !== "rollback" && targetRevision !== undefined)
      throw new Error("此操作不允许指定其他版本。");
    const unlock = await lockLifecycle(ctx);
    let result: LifecycleResult["state"] = "failed",
      current: string | undefined;
    try {
      const ci = await assertReleaseCi({
        repository,
        workflow: release.ciWorkflow,
        sha: commit,
        runner: ctx.runner,
      });
      const plan = await inspect(operation, targetRevision);
      current = plan.snapshot?.current;
      if (
        !plan.ready ||
        plan.missing.length > 0 ||
        !plan.snapshot ||
        !current ||
        ["busy", "unknown", "absent"].includes(plan.snapshot.state)
      ) {
        result = "blocked";
        return { state: result, output: plan };
      }
      if (
        operation === "rollback" &&
        !plan.snapshot.revisions?.some(
          (r) => r.revision === targetRevision && r.compatible,
        )
      ) {
        result = "blocked";
        return { state: result, output: plan };
      }
      if (
        !(await ctx.ui.confirm(
          `执行上述 ${operation} 计划？目标 ${ctx.config.project}/${ctx.env} · ${component.label}；设备 ${selected.user}@${selected.host}:${selected.port}；当前 ${current}${targetRevision ? ` → ${targetRevision}` : ""}。仅操作此项目；不回滚数据库，不删除云端资源或其他应用。`,
        ))
      ) {
        result = "cancelled";
        return { state: result, output: plan };
      }
      await checkSource();
      if (
        environment === "production" &&
        (await ctx.ui.input(
          `输入 ${ctx.config.project}/production 确认生产操作`,
        )) !== `${ctx.config.project}/production`
      ) {
        result = "cancelled";
        return { state: result, output: plan };
      }
      await checkSource();
      const latest = await assertReleaseCi({
        repository,
        workflow: release.ciWorkflow,
        sha: commit,
        runner: ctx.runner,
      });
      if (latest.runId !== ci.runId)
        throw new Error("CI运行已变化，请重新审阅生命周期计划。");
      const applied = await call("apply", operation, {
        expectedToken: plan.snapshot.token,
        ...(targetRevision ? { targetRevision } : {}),
      });
      if (!applied.ready || applied.missing.length) {
        result = "blocked";
        return { state: result, output: applied };
      }
      const post = await inspect();
      const expected = operation === "stop" ? "stopped" : "running";
      result =
        post.ready &&
        post.missing.length === 0 &&
        post.snapshot?.state === expected &&
        post.snapshot.current ===
          (operation === "rollback" ? targetRevision : current)
          ? "completed"
          : "failed";
      if (result === "failed")
        ctx.ui.log(
          "操作请求已返回，但最新状态未通过核验；请检查状态和操作历史，不会标记完成。",
        );
      return { state: result, output: post };
    } catch (error) {
      if (interrupted(error)) {
        result = "cancelled";
        throw error;
      }
      throw error;
    } finally {
      try {
        await lifecycleAudit(auditContext, {
          operation,
          component: componentId,
          deviceId: selected.id,
          commit,
          result,
          ...(current ? { current } : {}),
          ...(targetRevision ? { targetRevision } : {}),
        });
      } finally {
        await unlock();
      }
    }
  };
  return { commit, inspect, change };
}
