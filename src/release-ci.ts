import { run, type Runner } from "./process.ts";

export type ReleaseCiEvidence = {
  state: "passed" | "pending" | "failed" | "missing" | "unknown";
  sha: string;
  runId?: number;
  url?: string;
  branch?: string;
};

export type ReleaseCiOptions = {
  repository: string;
  workflow: string;
  sha: string;
  runner?: Runner;
};

type RunRecord = {
  id: number;
  created: number;
  number: number;
  attempt: number;
  workflowId?: number;
  state: ReleaseCiEvidence["state"];
  branch?: string;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function branchName(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
    ? value
    : undefined;
}

function runRecord(
  value: unknown,
  options: ReleaseCiOptions,
): RunRecord | undefined {
  const entry = object(value);
  if (!entry) return undefined;
  const head = object(entry.head_repository);
  if (
    !head ||
    typeof head.full_name !== "string" ||
    head.full_name.toLowerCase() !== options.repository.toLowerCase() ||
    ("fork" in head && head.fork !== false) ||
    entry.head_sha !== options.sha ||
    !positive(entry.id) ||
    !positive(entry.run_number) ||
    (entry.run_attempt !== undefined && !positive(entry.run_attempt)) ||
    typeof entry.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      entry.created_at,
    ) ||
    !Number.isFinite(Date.parse(entry.created_at)) ||
    typeof entry.path !== "string" ||
    !["push", "pull_request", "workflow_dispatch"].includes(String(entry.event))
  )
    return undefined;
  const [path, ref, extra] = entry.path.split("@");
  if (
    path !== `.github/workflows/${options.workflow}` ||
    extra !== undefined ||
    (ref !== undefined && !branchName(ref)) ||
    (entry.workflow_id !== undefined && !positive(entry.workflow_id))
  )
    return undefined;
  if (entry.workflow_url !== undefined) {
    const expected = `https://api.github.com/repos/${options.repository}/actions/workflows/${entry.workflow_id ?? options.workflow}`;
    if (entry.workflow_url !== expected) return undefined;
  }
  let state: RunRecord["state"] = "unknown";
  if (
    ["queued", "in_progress", "waiting", "requested", "pending"].includes(
      String(entry.status),
    )
  )
    state = "pending";
  else if (entry.status === "completed") {
    if (entry.conclusion === "success") state = "passed";
    else if (
      [
        "failure",
        "cancelled",
        "timed_out",
        "skipped",
        "neutral",
        "action_required",
        "stale",
        "startup_failure",
      ].includes(String(entry.conclusion))
    )
      state = "failed";
  }
  const branch = branchName(entry.head_branch);
  return {
    id: entry.id,
    created: Date.parse(entry.created_at),
    number: entry.run_number,
    attempt: (entry.run_attempt as number | undefined) ?? 1,
    ...(positive(entry.workflow_id) ? { workflowId: entry.workflow_id } : {}),
    state,
    ...(branch ? { branch } : {}),
  };
}

/** Only exact-commit workflow metadata is evidence; no artifacts or PR titles are trusted. */
export async function readReleaseCi(
  options: ReleaseCiOptions,
): Promise<ReleaseCiEvidence> {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(
      options.repository,
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.ya?ml$/.test(options.workflow) ||
    !/^[a-f0-9]{40}$/i.test(options.sha)
  )
    throw new Error(
      "CI 核验需要合法的 GitHub owner/repo、工作流文件名和完整 40 位提交 SHA。",
    );
  const sha = options.sha.toLowerCase();
  const result = (state: ReleaseCiEvidence["state"]): ReleaseCiEvidence => ({
    state,
    sha,
  });
  try {
    const response: unknown = JSON.parse(
      await (options.runner ?? run)("gh", [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        `repos/${options.repository}/actions/workflows/${options.workflow}/runs?head_sha=${sha}&per_page=100&page=1`,
      ]),
    );
    const body = object(response);
    if (
      !body ||
      !Array.isArray(body.workflow_runs) ||
      !Number.isSafeInteger(body.total_count) ||
      (body.total_count as number) < 0 ||
      body.total_count !== body.workflow_runs.length ||
      body.workflow_runs.length > 100
    )
      return result("unknown");
    if (!body.workflow_runs.length) return result("missing");
    const records = body.workflow_runs.map((entry: unknown) =>
      runRecord(entry, { ...options, sha }),
    );
    if (records.some((entry) => !entry)) return result("unknown");
    const runs = records as RunRecord[];
    const ids = new Set(
      runs.flatMap((entry) =>
        entry.workflowId === undefined ? [] : [entry.workflowId],
      ),
    );
    if (ids.size > 1) return result("unknown");
    runs.sort(
      (left, right) =>
        right.created - left.created ||
        right.number - left.number ||
        right.attempt - left.attempt,
    );
    const latest = runs[0]!;
    // Ambiguous duplicate records cannot inherit a successful result by array order.
    if (
      runs.some(
        (entry) =>
          entry.created === latest.created &&
          entry.number === latest.number &&
          entry.attempt === latest.attempt &&
          (entry.id !== latest.id || entry.state !== latest.state),
      )
    )
      return result("unknown");
    return {
      ...result(latest.state),
      runId: latest.id,
      url: `https://github.com/${options.repository}/actions/runs/${latest.id}`,
      ...(latest.branch ? { branch: latest.branch } : {}),
    };
  } catch {
    return result("unknown");
  }
}

export async function assertReleaseCi(
  options: ReleaseCiOptions,
): Promise<ReleaseCiEvidence & { state: "passed" }> {
  const evidence = await readReleaseCi(options);
  if (evidence.state !== "passed")
    throw new Error(
      "CI 尚未确认目标提交的最新工作流成功；请完成可信的同仓库 CI 后重新核验。",
    );
  return { ...evidence, state: "passed" };
}
