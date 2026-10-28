import {
  readReleaseCi,
  transientCiReason,
  type ReleaseCiEvidence,
  type ReleaseCiOptions,
  type ReleaseCiTransientReason,
} from "./release-ci.ts";

export type PassedCiEvidence = ReleaseCiEvidence & { state: "passed" };
export type ReleaseCiGateSnapshot = {
  degraded: boolean;
  observedAt: string;
  reason?: ReleaseCiTransientReason;
  reusedAt?: string;
};
export type ReleaseCiGateOptions = ReleaseCiOptions & {
  environment: string;
  transientFallback?: { maxAgeSeconds: number };
  confirm?: (message: string) => Promise<boolean>;
};

const blocked = (evidence?: ReleaseCiEvidence) =>
  new Error(
    `CI 核验未通过（${evidence?.reason ?? evidence?.state ?? "需重新开始"}）；未跳过验证，请重试或重新审阅发布计划。`,
  );

/** A capability scoped to one reviewed release, never persisted or shared between callers. */
export async function createReleaseCiGate(options: ReleaseCiGateOptions) {
  const maxAge = options.transientFallback?.maxAgeSeconds;
  if (maxAge !== undefined) {
    if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 300)
      throw new Error("CI 降级策略有效期必须为 1–300 秒。");
    if (
      ["production", "prod", "live"].includes(options.environment.toLowerCase())
    )
      throw new Error("生产环境不允许复用无法刷新的 CI 证据。");
  }
  const target: ReleaseCiOptions = {
    repository: options.repository,
    workflow: options.workflow,
    sha: options.sha,
    runner: options.runner,
    sleep: options.sleep,
  };
  const clock = options.now ?? Date.now;
  const confirm = options.confirm;
  const first = await readReleaseCi(target);
  if (first.state !== "passed") throw blocked(first);
  const accepted: PassedCiEvidence = { ...first, state: "passed" };
  let observed = clock();
  if (!Number.isSafeInteger(observed) || observed < 0) throw blocked();
  let valid = true;
  let busy = false;
  let degraded = false;
  let reason: ReleaseCiTransientReason | undefined;
  let reusedAt: string | undefined;
  const fresh = () => {
    const age = clock() - observed;
    return (
      maxAge !== undefined &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= maxAge * 1000
    );
  };
  const recheck = async (): Promise<PassedCiEvidence> => {
    if (!valid || busy) throw blocked();
    busy = true;
    try {
      const current = await readReleaseCi(target);
      if (current.state === "passed") {
        if (
          current.runId !== accepted.runId ||
          current.runAttempt !== accepted.runAttempt
        ) {
          valid = false;
          throw new Error("CI 运行或重试次数已变化，请重新审阅发布计划。");
        }
        const next = clock();
        if (!Number.isSafeInteger(next) || next < observed) {
          valid = false;
          throw blocked();
        }
        observed = next;
        return { ...accepted };
      }
      if (current.state !== "unknown" || !transientCiReason(current.reason)) {
        valid = false;
        throw blocked(current);
      }
      if (!fresh() || !confirm) throw blocked(current);
      const permitted = await confirm(
        `GitHub 暂时无法刷新 CI（${current.reason}）。本次已核验 ${target.repository} / ${target.workflow}，提交 ${accepted.sha}，运行 ${accepted.runId} / attempt ${accepted.runAttempt}，核验时间 ${new Date(observed).toISOString()}。允许在最多 ${maxAge} 秒有效期内复用该成功证据继续？当前并未确认最新远端结果；不会跳过源码、迁移和部署核验。`,
      );
      if (!permitted || !fresh()) throw blocked(current);
      degraded = true;
      reason = current.reason;
      reusedAt = new Date(clock()).toISOString();
      return { ...accepted };
    } finally {
      busy = false;
    }
  };
  return {
    initial: { ...accepted },
    recheck,
    snapshot: (): ReleaseCiGateSnapshot => ({
      degraded,
      observedAt: new Date(observed).toISOString(),
      ...(reason ? { reason } : {}),
      ...(reusedAt ? { reusedAt } : {}),
    }),
  };
}
