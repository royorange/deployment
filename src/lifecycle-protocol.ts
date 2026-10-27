import type { Device } from "./devices.ts";
export type LifecycleOperation = "status" | "stop" | "resume" | "rollback";
export type LifecycleRequest = {
  version: 1;
  project: string;
  environment: string;
  component: string;
  operation: LifecycleOperation;
  commit: string;
  device: Device;
  publicValues: Record<string, string>;
  expectedToken?: string;
  targetRevision?: string;
};
export type LifecycleSnapshot = {
  token: string;
  state: "absent" | "running" | "stopped" | "degraded" | "busy" | "unknown";
  current?: string;
  previous?: string;
  revisions?: Array<{ revision: string; compatible: boolean; reason: string }>;
};
export type LifecycleOutput = {
  ready: boolean;
  summary: string[];
  missing: string[];
  effects: string[];
  snapshot?: LifecycleSnapshot;
};
const failure = () =>
  new Error("生命周期适配器未返回受限状态协议；未确认操作成功。");
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw failure();
  return value as Record<string, unknown>;
}
function line(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 1000 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value)
  );
}
const revision = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
export function lifecycleOutput(raw: string): LifecycleOutput {
  if (Buffer.byteLength(raw) > 100_000) throw failure();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failure();
  }
  const value = object(parsed, [
    "ready",
    "summary",
    "missing",
    "effects",
    "snapshot",
  ]);
  if (typeof value.ready !== "boolean") throw failure();
  for (const field of ["summary", "missing", "effects"]) {
    const lines = value[field];
    if (!Array.isArray(lines) || lines.length > 50 || !lines.every(line))
      throw failure();
  }
  if (value.snapshot !== undefined) {
    const s = object(value.snapshot, [
      "token",
      "state",
      "current",
      "previous",
      "revisions",
    ]);
    if (
      typeof s.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(s.token) ||
      typeof s.state !== "string" ||
      !["absent", "running", "stopped", "degraded", "busy", "unknown"].includes(
        s.state,
      ) ||
      (s.current !== undefined && !revision(s.current)) ||
      (s.previous !== undefined && !revision(s.previous))
    )
      throw failure();
    if (s.revisions !== undefined) {
      if (!Array.isArray(s.revisions) || s.revisions.length > 30)
        throw failure();
      const seen = new Set<string>();
      for (const entry of s.revisions) {
        const r = object(entry, ["revision", "compatible", "reason"]);
        if (
          !revision(r.revision) ||
          seen.has(String(r.revision)) ||
          typeof r.compatible !== "boolean" ||
          !line(r.reason)
        )
          throw failure();
        seen.add(String(r.revision));
      }
    }
  }
  return value as LifecycleOutput;
}
