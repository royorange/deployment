import { resolve } from "node:path";
import { allFields, validateField } from "./config.ts";
import {
  adapterOutput,
  releaseCheckout,
  releaseProcessEnvironment,
} from "./release-preflight.ts";
import { safeMessage, values, type Context } from "./wizard.ts";

export type LocalBuildReceipt = {
  version: 1;
  provider: "local";
  project: string;
  environment: string;
  repository?: string;
  sourceCommit?: string;
  state: "built" | "adopted" | "cancelled" | "failed";
  outputs: Record<string, string>;
  startedAt: string;
  completedAt: string;
};

type BuildRequest = {
  version: 1;
  project: string;
  environment: string;
  repository: string;
  sourceCommit: string;
  publicValues: Record<string, string>;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOutput(
  raw: string,
  request: BuildRequest,
  phase: "plan" | "build",
  ctx: Context,
  outputFields: string[],
) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("本地构建适配器未返回合法 JSON；原始输出未显示。");
  }
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "project",
          "environment",
          "repository",
          "sourceCommit",
          "ready",
          "summary",
          "missing",
          "effects",
          "outputs",
        ].includes(key),
    ) ||
    value.version !== 1 ||
    value.project !== request.project ||
    value.environment !== request.environment ||
    value.repository !== request.repository ||
    value.sourceCommit !== request.sourceCommit ||
    !object(value.outputs)
  ) {
    throw new Error("本地构建结果协议或项目、环境、源码绑定不匹配。");
  }
  const status = adapterOutput(
    JSON.stringify({
      ready: value.ready,
      summary: value.summary,
      missing: value.missing,
      effects: value.effects,
    }),
  );
  const rawOutputs = value.outputs;
  const keys = Object.keys(rawOutputs);
  if (
    (phase === "plan" && keys.length !== 0) ||
    (phase === "build" &&
      status.ready &&
      (keys.length !== outputFields.length ||
        outputFields.some((field) => !Object.hasOwn(rawOutputs, field)))) ||
    keys.some(
      (field) =>
        !outputFields.includes(field) || typeof rawOutputs[field] !== "string",
    )
  ) {
    throw new Error(
      "本地构建输出必须匹配声明的公开产物字段；计划阶段不得返回产物。",
    );
  }
  const outputs: Record<string, string> = {};
  for (const field of keys) {
    outputs[field] = validateField(
      ctx.config,
      field,
      rawOutputs[field] as string,
    );
    if (!outputs[field]) throw new Error("本地构建产物字段不能为空。");
    if (
      ["deploymentImage", "tunnelImage"].includes(field) &&
      !/^[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(outputs[field])
    ) {
      throw new Error("构建镜像必须固定为 sha256 digest，不能采用可变标签。");
    }
  }
  return { ...status, outputs };
}

/** Build evidence is separate from CI evidence and cannot authorize deployment. */
export async function runLocalBuild(ctx: Context): Promise<LocalBuildReceipt> {
  const startedAt = new Date().toISOString();
  const receipt: LocalBuildReceipt = {
    version: 1,
    provider: "local",
    project: ctx.config.project,
    environment: ctx.env,
    state: "failed",
    outputs: {},
    startedAt,
    completedAt: startedAt,
  };
  try {
    const release = ctx.config.release;
    const build = release?.localBuild;
    if (
      !release ||
      !ctx.config.repository ||
      !release.environments.includes(ctx.env) ||
      !build?.environments.includes(ctx.env)
    ) {
      throw new Error(
        "当前项目/环境未声明本地构建适配器；请使用项目已有构建流程。",
      );
    }
    const fields = allFields(ctx.config);
    receipt.repository = ctx.config.repository;
    const publicFields = [...(release.publicFields ?? [])];
    const outputFields = [...build.outputFields];
    if (
      !outputFields.length ||
      new Set(outputFields).size !== outputFields.length ||
      [...publicFields, ...outputFields].some(
        (field) =>
          !Object.hasOwn(ctx.config.variables, field) ||
          !fields[field] ||
          fields[field]!.secret,
      ) ||
      outputFields.some((field) => !publicFields.includes(field))
    ) {
      throw new Error(
        "本地构建只接受已声明的公开字段；产物字段必须属于发布公开白名单。",
      );
    }
    const adapter = build.adapter;
    const sourceCommit = await releaseCheckout(ctx, adapter);
    receipt.sourceCommit = sourceCommit;
    const capture = () =>
      JSON.stringify({
        root: ctx.root,
        environment: ctx.env,
        config: ctx.config,
        publicValues: Object.fromEntries(
          publicFields.map((field) => [field, values(ctx)[field]]),
        ),
      });
    const binding = capture();
    const publicValues: Record<string, string> = {};
    for (const field of publicFields) {
      if (values(ctx)[field])
        publicValues[field] = validateField(
          ctx.config,
          field,
          values(ctx)[field]!,
        );
    }
    const request: BuildRequest = {
      version: 1,
      project: receipt.project,
      environment: receipt.environment,
      repository: ctx.config.repository,
      sourceCommit,
      publicValues,
    };
    const input = JSON.stringify(request);
    const recheck = async () => {
      if (
        capture() !== binding ||
        (await releaseCheckout(ctx, adapter)) !== sourceCommit
      ) {
        throw new Error(
          "构建期间源码、目标或公开配置发生变化；未采用构建结果，请重新检查。",
        );
      }
    };
    ctx.ui.log(
      `本地构建：${receipt.project}/${receipt.environment}\n源码：${sourceCommit}\n适配器：${adapter}\n构建成功不代表 CI 已通过，也不会发布应用或执行数据库迁移。`,
    );
    if (
      !(await ctx.ui.confirm(
        "允许执行此已提交仓库的本地构建适配器读取计划？请确认信任该源码。工具仅传入公开构建配置。",
      ))
    ) {
      receipt.state = "cancelled";
      return receipt;
    }
    const call = async (phase: "plan" | "build") => {
      await recheck();
      const output = readOutput(
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
            input,
            env: releaseProcessEnvironment(),
            timeout: phase === "plan" ? 120_000 : 1_800_000,
          },
        ),
        request,
        phase,
        ctx,
        outputFields,
      );
      for (const line of [
        ...output.summary,
        ...output.missing,
        ...output.effects,
      ])
        ctx.ui.log(safeMessage(new Error(line), ctx));
      if (!output.ready || output.missing.length)
        throw new Error("本地构建检查未通过，请补齐显示的缺项后重试。");
      await recheck();
      return output;
    };
    await call("plan");
    if (
      !(await ctx.ui.confirm(
        "执行以上构建计划？构建可能按计划推送镜像等产物；不会部署应用或执行数据库迁移。",
      ))
    ) {
      receipt.state = "cancelled";
      return receipt;
    }
    const result = await call("build");
    receipt.state = "built";
    receipt.outputs = result.outputs;
    ctx.ui.log(
      `本地构建完成：${sourceCommit}。产物字段：${outputFields.join(", ")}。CI 和应用发布仍需分别核验。`,
    );
    if (
      !(await ctx.ui.confirm(
        "采用这些已核验产物，更新当前环境的待发布配置？此操作不会更改正在运行的版本。",
      ))
    )
      return receipt;
    await recheck();
    const target = values(ctx);
    const previous = Object.fromEntries(
      outputFields.map((field) => [field, target[field]]),
    );
    for (const field of outputFields) target[field] = result.outputs[field]!;
    try {
      await ctx.save();
    } catch (error) {
      for (const field of outputFields) {
        if (previous[field] === undefined) delete target[field];
        else target[field] = previous[field]!;
      }
      throw error;
    }
    receipt.state = "adopted";
    return receipt;
  } catch (error) {
    if (
      error instanceof Error &&
      ["ExitPromptError", "AbortPromptError"].includes(error.name)
    )
      throw error;
    receipt.state = "failed";
    ctx.ui.log(safeMessage(error, ctx));
    return receipt;
  } finally {
    receipt.completedAt = new Date().toISOString();
  }
}
