import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { allFields, validateField } from "./config.ts";
import { validateDevice, type Device } from "./devices.ts";
import { noSymlinks, writePrivate } from "./files.ts";
import { assertReleaseCi } from "./release-ci.ts";
import { releaseRuntimeValues } from "./release-runtime.ts";
import {
  adapterOutput,
  releaseCheckout,
  releaseProcessEnvironment,
} from "./release-preflight.ts";
import {
  releaseMigrations,
  releaseCloudflareToken,
  safeMessage,
  values,
  type Context,
} from "./wizard.ts";

type MigrationResult = {
  state: "applied" | "up-to-date";
  ref: string;
  files: string[];
};
export type ReleaseReceipt = {
  version: 1;
  project: string;
  environment: string;
  component: string;
  commit: string;
  deviceId?: string;
  ciRunId: number;
  state: "planned" | "cancelled" | "failed" | "deployed" | "health-checked";
  database: "not-run" | "applied" | "up-to-date" | "unknown";
  phase: string;
  checkedAt: string;
};
type Dependencies = {
  migrate?: (
    ctx: Context,
    commit?: string,
  ) => Promise<MigrationResult | undefined>;
  cloudflareToken?: (ctx: Context) => Promise<string>;
};
const running = new Set<string>();
export async function runRelease(
  ctx: Context,
  componentId: string,
  device?: Device,
  deps: Dependencies = {},
): Promise<ReleaseReceipt> {
  const config = ctx.config.release;
  if (
    !config ||
    !ctx.config.repository ||
    !config.environments.includes(ctx.env)
  )
    throw new Error("当前项目/环境尚未声明可用发布流程。");
  const component = config.components.find((item) => item.id === componentId);
  if (!component) throw new Error("未知发布组件。");
  if (component.requiresDevice && !device)
    throw new Error("请先选择SSH目标主机。");
  if (device) validateDevice(device);
  if (component.migrations === "project-managed")
    throw new Error(
      "本组件使用项目自管迁移；尚未声明受控初始化步骤，已阻止自动发布，不混用官方迁移账本。",
    );
  const sha = await releaseCheckout(ctx);
  const ci = await assertReleaseCi({
    repository: ctx.config.repository,
    workflow: config.ciWorkflow,
    sha,
    runner: ctx.runner,
  });
  const receipt: ReleaseReceipt = {
    version: 1,
    project: ctx.config.project,
    environment: ctx.env,
    component: component.id,
    commit: sha,
    ...(device ? { deviceId: device.id } : {}),
    ciRunId: ci.runId!,
    state: "planned",
    database: "not-run",
    phase: "plan",
    checkedAt: new Date().toISOString(),
  };
  const scope = createHash("sha256")
    .update(JSON.stringify([ctx.root, ctx.config.project, ctx.env]))
    .digest("hex");
  if (running.has(scope)) throw new Error("当前项目环境已有发布正在进行。");
  running.add(scope);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  let operationToken: string | undefined;
  let runtimeSecrets: string[] = [];
  const report = (error: unknown) => {
    let message = error instanceof Error ? error.message : "操作失败。";
    if (operationToken)
      message = message.split(operationToken).join("[已隐藏]");
    for (const secret of runtimeSecrets)
      message = message.split(secret).join("[已隐藏]");
    ctx.ui.log(safeMessage(new Error(message), ctx));
  };
  try {
    if (ctx.releaseDirectory && ctx.storageMode !== "memory") {
      await noSymlinks(ctx.releaseDirectory);
      await mkdir(ctx.releaseDirectory, { recursive: true, mode: 0o700 });
      lockPath = join(ctx.releaseDirectory, `${scope}.lock`);
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch {
        throw new Error("此环境已有发布锁；请确认旧进程已退出后再处理锁文件。");
      }
    }
    ctx.ui.log(
      `发布目标：${ctx.config.project}/${ctx.env} · ${component.label}\n提交：${sha}\nCI：${ci.url}\n适配器：${config.adapter}${device ? `\n设备：${device.label} / ${device.user}@${device.host}:${device.port}` : ""}`,
    );
    if (
      !(await ctx.ui.confirm(
        `允许执行此已提交仓库的发布适配器以读取计划？请先确认信任此版本的项目代码。${component.runtimeFields?.length ? `该组件将通过stdin读取运行字段：${component.runtimeFields.join(", ")}；后续计划、部署和核验使用同一份配置。` : ""}`,
      ))
    ) {
      receipt.state = "cancelled";
      return receipt;
    }
    const runtimeValues = await releaseRuntimeValues(ctx, component);
    runtimeSecrets = Object.values(runtimeValues ?? {}).filter(Boolean);
    const publicValues: Record<string, string> = {};
    for (const field of config.publicFields ?? []) {
      if (allFields(ctx.config)[field]?.secret)
        throw new Error("公开发布字段包含敏感项，已停止。");
      if (values(ctx)[field])
        publicValues[field] = validateField(
          ctx.config,
          field,
          values(ctx)[field]!,
        );
    }
    const request = {
      version: runtimeValues === undefined ? 1 : 2,
      project: ctx.config.project,
      environment: ctx.env,
      component: component.id,
      commit: sha,
      ci: { runId: ci.runId },
      ...(device ? { device } : {}),
      publicValues,
      ...(runtimeValues === undefined ? {} : { runtimeValues }),
    };
    const extra: NodeJS.ProcessEnv = {};
    if (component.kind === "pages") {
      operationToken = await (deps.cloudflareToken ?? releaseCloudflareToken)(
        ctx,
      );
      extra.CLOUDFLARE_API_TOKEN = operationToken;
    }
    const env = releaseProcessEnvironment(extra);
    const call = async (phase: "plan" | "deploy" | "verify") => {
      if ((await releaseCheckout(ctx)) !== sha)
        throw new Error("执行适配器前提交或工作区已变化，已停止。");
      receipt.phase = phase;
      const output = adapterOutput(
        await ctx.runner(
          process.execPath,
          [
            "--experimental-strip-types",
            resolve(ctx.root, config.adapter),
            "--phase",
            phase,
          ],
          {
            cwd: ctx.root,
            input: JSON.stringify(request),
            env,
            timeout: phase === "plan" ? 120000 : 1800000,
          },
        ),
      );
      for (const line of [
        ...output.summary,
        ...output.missing,
        ...output.effects,
      ])
        report(new Error(line));
      if (!output.ready)
        throw new Error("发布阶段检查未通过；请补齐显示的缺项后重试。");
    };
    await call("plan");
    if (
      !(await ctx.ui.confirm(
        "执行以上发布计划？数据库迁移先于应用发布；已完成的数据库变更不会自动回滚。",
      ))
    ) {
      receipt.state = "cancelled";
      return receipt;
    }
    if (
      ctx.env === "production" &&
      (await ctx.ui.input(
        `输入 ${ctx.config.project}/production 确认生产发布`,
      )) !== `${ctx.config.project}/production`
    ) {
      receipt.state = "cancelled";
      return receipt;
    }
    const recheck = async () => {
      if ((await releaseCheckout(ctx)) !== sha)
        throw new Error("发布期间本地提交发生变化，已停止。");
      const latest = await assertReleaseCi({
        repository: ctx.config.repository!,
        workflow: config.ciWorkflow,
        sha,
        runner: ctx.runner,
      });
      if (latest.runId !== ci.runId)
        throw new Error("CI运行已变化，请重新审阅发布计划。");
    };
    await recheck();
    if (component.migrations === "supabase-cli") {
      receipt.phase = "migration";
      const migration = await (deps.migrate ?? releaseMigrations)(ctx, sha);
      if (!migration) {
        receipt.state = "cancelled";
        return receipt;
      }
      receipt.database = migration.state;
    }
    receipt.phase = "pre-deploy-check";
    await recheck();
    await call("deploy");
    receipt.state = "deployed";
    await call("verify");
    receipt.state = "health-checked";
    ctx.ui.log("发布与基础健康检查完成；业务验收需单独执行。");
    return receipt;
  } catch (error) {
    if (receipt.phase === "migration" && receipt.database === "not-run")
      receipt.database = "unknown";
    if (
      error instanceof Error &&
      ["ExitPromptError", "AbortPromptError"].includes(error.name)
    ) {
      receipt.state = "cancelled";
      throw error;
    }
    receipt.state = "failed";
    report(error);
    if (receipt.database === "applied" || receipt.phase === "migration")
      ctx.ui.log(
        "数据库可能已有变更；未执行数据库回滚。请核对迁移结果后恢复发布。",
      );
    return receipt;
  } finally {
    receipt.checkedAt = new Date().toISOString();
    try {
      if (ctx.releaseDirectory && ctx.storageMode !== "memory" && lock)
        await writePrivate(
          join(
            ctx.releaseDirectory,
            `${scope}-${Date.now()}-${randomBytes(4).toString("hex")}.json`,
          ),
          `${JSON.stringify(receipt, null, 2)}\n`,
          null,
        );
      ctx.ui.log(
        `发布结果：${receipt.state}；阶段：${receipt.phase}；数据库：${receipt.database}`,
      );
    } finally {
      await lock?.close();
      if (lockPath && lock) await rm(lockPath, { force: true });
      running.delete(scope);
      operationToken = undefined;
      runtimeSecrets = [];
    }
  }
}
