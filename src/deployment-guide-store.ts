import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { missing, noSymlinks, readPrivate, writePrivate } from "./files.ts";
import {
  guideStageIds,
  type GuideProgress,
  type GuideScope,
} from "./deployment-guide-model.ts";

const invalid = () =>
  new Error(
    "部署引导进度格式或目标不匹配；未覆盖原记录。仅保存公开导航与历史摘要。",
  );
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw invalid();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): boolean {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
  );
}
function scopeValue(value: unknown): GuideScope {
  const scope = object(value, ["root", "repository", "project", "environment"]);
  if (
    typeof scope.root !== "string" ||
    scope.root.length > 4096 ||
    /[\x00-\x1f\x7f-\x9f]/.test(scope.root) ||
    !isAbsolute(scope.root) ||
    resolve(scope.root) !== scope.root ||
    !identifier(scope.project) ||
    !identifier(scope.environment) ||
    (scope.repository !== undefined &&
      (typeof scope.repository !== "string" ||
        !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(
          scope.repository,
        )))
  )
    throw invalid();
  return {
    root: scope.root,
    ...(scope.repository ? { repository: scope.repository as string } : {}),
    project: scope.project as string,
    environment: scope.environment as string,
  };
}
function stage(value: unknown): boolean {
  return guideStageIds.includes(value as (typeof guideStageIds)[number]);
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw invalid();
}
function progressValue(
  value: unknown,
  expectedScope: GuideScope,
): GuideProgress {
  const progress = object(value, [
    "version",
    "scope",
    "binding",
    "cursor",
    "deviceId",
    "importDisposition",
    "history",
  ]);
  if (
    progress.version !== 1 ||
    JSON.stringify(scopeValue(progress.scope)) !==
      JSON.stringify(expectedScope) ||
    (progress.cursor !== undefined && !stage(progress.cursor)) ||
    (progress.deviceId !== undefined && !identifier(progress.deviceId)) ||
    (progress.importDisposition !== undefined &&
      !["imported", "skipped"].includes(
        progress.importDisposition as string,
      )) ||
    !Array.isArray(progress.history) ||
    progress.history.length > 64
  )
    throw invalid();
  digest(progress.binding);
  for (const value of progress.history) {
    const item = object(value, [
      "stage",
      "observedAt",
      "outcome",
      "commit",
      "component",
      "database",
      "phase",
    ]);
    if (
      !stage(item.stage) ||
      typeof item.observedAt !== "string" ||
      !Number.isFinite(Date.parse(item.observedAt)) ||
      new Date(item.observedAt).toISOString() !== item.observedAt ||
      !["verified", "configured", "failed", "cancelled"].includes(
        item.outcome as string,
      ) ||
      (item.commit !== undefined &&
        (typeof item.commit !== "string" ||
          !/^[a-f0-9]{40}$/.test(item.commit))) ||
      (item.component !== undefined && !identifier(item.component)) ||
      (item.database !== undefined &&
        !["not-run", "applied", "up-to-date", "unknown"].includes(
          item.database as string,
        )) ||
      (item.phase !== undefined &&
        !["plan", "migration", "pre-deploy-check", "deploy", "verify"].includes(
          item.phase as string,
        ))
    )
      throw invalid();
  }
  return structuredClone(progress) as GuideProgress;
}
async function privateDirectory(path: string): Promise<void> {
  await noSymlinks(path);
  try {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new Error("部署引导目录须为权限 700 的真实私有目录。");
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/** Navigation persists; historical observations never establish current remote readiness. */
export class GuideProgressStore {
  readonly directory: string;
  readonly path: string;
  readonly memory: boolean;
  private readonly scope: GuideScope;
  private previous: string | null = null;
  private progress?: GuideProgress;
  private constructor(directory: string, scope: GuideScope, memory: boolean) {
    this.directory = resolve(directory);
    this.scope = scopeValue(scope);
    this.memory = memory;
    const key = createHash("sha256")
      .update(JSON.stringify(this.scope))
      .digest("hex");
    this.path = join(this.directory, `${key}.json`);
  }
  static async open(
    directory: string,
    scope: GuideScope,
    options: { memory?: boolean } = {},
  ): Promise<GuideProgressStore> {
    const store = new GuideProgressStore(
      directory,
      scope,
      options.memory ?? false,
    );
    if (!store.memory) {
      await privateDirectory(store.directory);
      store.previous = (await readPrivate(store.path)) ?? null;
      if (store.previous !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(store.previous);
        } catch {
          throw invalid();
        }
        store.progress = progressValue(parsed, store.scope);
      }
    }
    return store;
  }
  read(binding: string): GuideProgress {
    digest(binding);
    if (this.progress?.binding === binding)
      return structuredClone(this.progress);
    return {
      version: 1,
      scope: { ...this.scope },
      binding,
      ...(this.progress?.deviceId ? { deviceId: this.progress.deviceId } : {}),
      ...(this.progress?.importDisposition
        ? { importDisposition: this.progress.importDisposition }
        : {}),
      history: [],
    };
  }
  async save(progress: GuideProgress): Promise<void> {
    const next = progressValue(progress, this.scope);
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    if (!this.memory) {
      await privateDirectory(this.directory);
      await writePrivate(this.path, contents, this.previous);
      this.previous = contents;
    }
    this.progress = next;
  }
}
