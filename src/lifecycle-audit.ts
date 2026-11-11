import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { noSymlinks, writePrivate } from "./files.ts";
import { activeReleaseScopes } from "./release-lock.ts";
import type { Context } from "./wizard.ts";
import type { LifecycleOperation } from "./lifecycle-protocol.ts";
export function lifecycleScope(ctx: Context): string {
  return createHash("sha256")
    .update(JSON.stringify([ctx.root, ctx.config.project, ctx.env]))
    .digest("hex");
}
export async function lockLifecycle(
  ctx: Context,
): Promise<() => Promise<void>> {
  const scope = lifecycleScope(ctx);
  if (activeReleaseScopes.has(scope))
    throw new Error("当前项目环境已有发布或生命周期操作正在进行。");
  activeReleaseScopes.add(scope);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let path: string | undefined;
  try {
    if (ctx.releaseDirectory && ctx.storageMode !== "memory") {
      await noSymlinks(ctx.releaseDirectory);
      await mkdir(ctx.releaseDirectory, { recursive: true, mode: 0o700 });
      path = join(ctx.releaseDirectory, `${scope}.lock`);
      try {
        lock = await open(path, "wx", 0o600);
      } catch {
        throw new Error("此环境已有发布锁，请确认旧操作结束后重试。");
      }
    }
  } catch (error) {
    activeReleaseScopes.delete(scope);
    throw error;
  }
  return async () => {
    try {
      await lock?.close();
      if (path) await rm(path, { force: true });
    } finally {
      activeReleaseScopes.delete(scope);
    }
  };
}
export async function lifecycleAudit(
  ctx: Context,
  input: {
    operation: LifecycleOperation;
    component: string;
    deviceId: string;
    commit: string;
    result: string;
    current?: string;
    targetRevision?: string;
  },
): Promise<void> {
  if (!ctx.releaseDirectory || ctx.storageMode === "memory") return;
  await noSymlinks(ctx.releaseDirectory);
  await writePrivate(
    join(
      ctx.releaseDirectory,
      `${lifecycleScope(ctx)}-lifecycle-${randomUUID()}.json`,
    ),
    JSON.stringify({
      version: 1,
      project: ctx.config.project,
      environment: ctx.env,
      ...input,
      checkedAt: new Date().toISOString(),
    }),
  );
}
