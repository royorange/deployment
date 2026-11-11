import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { allFields, validateField } from "./config.ts";
import { databaseFields } from "./release-config.ts";
import {
  releaseCheckout,
  releaseProcessEnvironment,
} from "./release-preflight.ts";
import {
  databaseOutput,
  type DatabaseOutput,
  type DatabaseRequest,
} from "./project-database-protocol.ts";
import { databaseSources } from "./project-database-sources.ts";
import {
  safeMessage,
  values,
  releaseDatabaseCredential,
  type Context,
} from "./wizard.ts";

export type ProjectDatabaseResult = {
  state: "applied" | "up-to-date";
  ref: string;
  files: string[];
  ledger: string;
  sourceDigest: string;
  verification: "versions-only" | "checksums";
};

/** Called inside the release lock, after trust and exact-source CI verification. */
export async function runProjectDatabase(
  ctx: Context,
  commit: string,
  beforeApply: () => Promise<void>,
  onApply?: () => void,
): Promise<ProjectDatabaseResult | undefined> {
  const config = ctx.config.release?.database;
  if (
    !config ||
    !config.environments.includes(ctx.env) ||
    ctx.config.migrationStrategy !== "project-managed" ||
    !ctx.config.repository
  )
    throw new Error("项目自管数据库缺少当前环境的受控步骤声明。");
  const profile = values(ctx);
  const ref = validateField(
    ctx.config,
    "supabaseProjectRef",
    profile.supabaseProjectRef ?? "",
  );
  if (
    profile.supabaseUrl &&
    profile.supabaseUrl !== `https://${ref}.supabase.co`
  )
    throw new Error("数据库 Project Ref 与 URL 不一致。");
  const binding = () =>
    JSON.stringify({
      project: ctx.config.project,
      repository: ctx.config.repository,
      env: ctx.env,
      database: ctx.config.release?.database,
      strategy: ctx.config.migrationStrategy,
      targets: Object.fromEntries(
        Object.entries(values(ctx)).filter(
          ([key]) => !allFields(ctx.config)[key]?.secret,
        ),
      ),
    });
  const initialBinding = binding();
  const assertSource = async () => {
    if (
      binding() !== initialBinding ||
      (await releaseCheckout(ctx, config.adapter)) !== commit ||
      binding() !== initialBinding
    )
      throw new Error("数据库目标、声明或提交已变化；请重新检查计划。");
  };
  await assertSource();
  const credentials: Record<string, string> = {};
  for (const field of databaseFields(config)) {
    if (
      !Object.hasOwn(ctx.config.variables, field) ||
      !ctx.config.extraFields?.[field]?.secret ||
      ctx.config.release?.components.some((component) =>
        component.runtimeFields?.includes(field),
      )
    )
      throw new Error("数据库凭据必须独立于应用运行配置。");
    const supplied =
      profile[field] ??
      (field === config.credentialField
        ? await releaseDatabaseCredential(ctx, ref)
        : undefined);
    if (!supplied) throw new Error(`数据库专属字段尚未配置：${field}。`);
    credentials[field] = validateField(ctx.config, field, supplied);
  }
  const secrets = Object.values(credentials);
  const redact = (error: unknown) => {
    let message = error instanceof Error ? error.message : "数据库步骤失败。";
    for (const secret of secrets)
      message = message.split(secret).join("[已隐藏]");
    return safeMessage(new Error(message), ctx);
  };
  try {
    const sources = await databaseSources(
      ctx.root,
      commit,
      config.sourcePaths,
      ctx.runner,
    );
    const sourceDigest = createHash("sha256")
      .update(
        JSON.stringify(sources.map(({ path, sha256 }) => ({ path, sha256 }))),
      )
      .digest("hex");
    const request: DatabaseRequest = {
      version: 1,
      repository: ctx.config.repository,
      project: ctx.config.project,
      environment: ctx.env,
      commit,
      target: { provider: "supabase", projectRef: ref, ledger: config.ledger },
      sourceDigest,
      sources,
      credentials,
    };
    const call = async (
      phase: "inspect" | "plan" | "apply" | "verify",
      expectedToken?: string,
    ): Promise<DatabaseOutput> => {
      await assertSource();
      if (phase === "apply") onApply?.();
      const output = databaseOutput(
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
            input: JSON.stringify({
              ...request,
              ...(expectedToken ? { expectedToken } : {}),
            }),
            env: releaseProcessEnvironment(),
            timeout: phase === "apply" ? 300_000 : 120_000,
          },
        ),
        request,
      );
      for (const line of [
        ...output.summary,
        ...output.missing,
        ...output.effects,
      ])
        ctx.ui.log(redact(new Error(line)));
      if (
        !output.ready ||
        output.missing.length ||
        output.snapshot.state === "unknown"
      )
        throw new Error("数据库检查未通过或远端状态未知，已阻止应用发布。");
      return output;
    };
    const inspected = await call("inspect");
    const planned = await call("plan");
    if (JSON.stringify(inspected.snapshot) !== JSON.stringify(planned.snapshot))
      throw new Error("数据库状态在计划期间变化，请重新核验。");
    ctx.ui.log(
      `数据库目标：${ctx.config.project}/${ctx.env} · ${ref} · ${config.ledger}；SQL 摘要：${sourceDigest}`,
    );
    if (planned.snapshot.verification === "versions-only")
      ctx.ui.log("账本仅记录版本；本次未验证历史已执行 SQL 的内容校验和。");
    let applied = false;
    if (planned.snapshot.state === "pending") {
      if (
        !(await ctx.ui.confirm(
          "执行以上项目数据库变更？仅执行已确认的 SQL 与初始化步骤，不自动回滚数据库。",
        ))
      )
        return;
      if (
        /^(production|prod|live)$/i.test(ctx.env) &&
        (await ctx.ui.input(
          `输入 ${ctx.config.project}/${ctx.env} 确认数据库变更`,
        )) !== `${ctx.config.project}/${ctx.env}`
      )
        return;
      await beforeApply();
      const current = await call("inspect");
      if (JSON.stringify(current.snapshot) !== JSON.stringify(planned.snapshot))
        throw new Error("数据库状态在确认后变化，请重新审阅计划。");
      await call("apply", planned.snapshot.token);
      applied = true;
    }
    const verified = await call("verify");
    if (
      verified.snapshot.state !== "up-to-date" ||
      verified.snapshot.pending.length
    )
      throw new Error("数据库写后核验未完成，已阻止应用发布。");
    return {
      state: applied ? "applied" : "up-to-date",
      ref,
      files: sources.map((source) => source.path),
      ledger: config.ledger,
      sourceDigest,
      verification: verified.snapshot.verification,
    };
  } catch (error) {
    const sanitized = new Error(redact(error));
    if (
      error instanceof Error &&
      ["ExitPromptError", "AbortPromptError"].includes(error.name)
    )
      sanitized.name = error.name;
    throw sanitized;
  } finally {
    for (const field of Object.keys(credentials)) delete credentials[field];
    secrets.length = 0;
  }
}
