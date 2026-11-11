export type DatabaseTarget = {
  provider: "supabase";
  projectRef: string;
  ledger: string;
};
export type DatabaseSource = { path: string; sha256: string; sql: string };
export type DatabaseIdentity = {
  version: 1;
  repository: string;
  project: string;
  environment: string;
  commit: string;
  target: DatabaseTarget;
  sourceDigest: string;
};
export type DatabaseRequest = DatabaseIdentity & {
  sources: DatabaseSource[];
  credentials: Record<string, string>;
  expectedToken?: string;
};
export type DatabaseSnapshot = {
  token: string;
  state: "pending" | "up-to-date" | "unknown";
  pending: string[];
  verification: "versions-only" | "checksums";
};
export type DatabaseOutput = DatabaseIdentity & {
  ready: boolean;
  summary: string[];
  missing: string[];
  effects: string[];
  snapshot: DatabaseSnapshot;
};
const invalid = () =>
  new Error("数据库适配器身份、快照或结果协议不匹配，未确认操作成功。");
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
function lines(value: unknown, max = 50): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(
      (line) =>
        typeof line === "string" &&
        line.length <= 1000 &&
        !/[\x00-\x1f\x7f-\x9f]/.test(line),
    )
  );
}
export function databaseOutput(
  raw: string,
  expected: DatabaseIdentity,
): DatabaseOutput {
  if (Buffer.byteLength(raw) > 100_000) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  const value = object(parsed, [
    "version",
    "repository",
    "project",
    "environment",
    "commit",
    "target",
    "sourceDigest",
    "ready",
    "summary",
    "missing",
    "effects",
    "snapshot",
  ]);
  for (const key of [
    "version",
    "repository",
    "project",
    "environment",
    "commit",
    "sourceDigest",
  ] as const)
    if (value[key] !== expected[key]) throw invalid();
  const target = object(value.target, ["provider", "projectRef", "ledger"]);
  if (
    target.provider !== expected.target.provider ||
    target.projectRef !== expected.target.projectRef ||
    target.ledger !== expected.target.ledger
  )
    throw invalid();
  if (
    typeof value.ready !== "boolean" ||
    !lines(value.summary) ||
    !lines(value.missing) ||
    !lines(value.effects)
  )
    throw invalid();
  const snapshot = object(value.snapshot, [
    "token",
    "state",
    "pending",
    "verification",
  ]);
  if (
    typeof snapshot.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.token) ||
    !["pending", "up-to-date", "unknown"].includes(String(snapshot.state)) ||
    !["versions-only", "checksums"].includes(String(snapshot.verification)) ||
    !lines(snapshot.pending, 500) ||
    new Set(snapshot.pending).size !== snapshot.pending.length ||
    (snapshot.state === "up-to-date" && snapshot.pending.length !== 0) ||
    (snapshot.state === "pending" && snapshot.pending.length === 0)
  )
    throw invalid();
  return value as DatabaseOutput;
}
