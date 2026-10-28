import { CommandExecutionError, run, type Runner } from "./process.ts";
import { githubReadBody } from "./github-read.ts";

export type ReleaseCiReason =
  | "rate-limited"
  | "service-unavailable"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "malformed"
  | "unavailable";
export type ReleaseCiTransientReason = Extract<
  ReleaseCiReason,
  "rate-limited" | "service-unavailable" | "timeout"
>;
export function transientCiReason(
  reason?: ReleaseCiReason,
): reason is ReleaseCiTransientReason {
  return (
    reason === "rate-limited" ||
    reason === "service-unavailable" ||
    reason === "timeout"
  );
}

export type ReleaseCiEvidence = {
  state: "passed" | "pending" | "failed" | "missing" | "unknown";
  sha: string;
  runId?: number;
  runAttempt?: number;
  reason?: ReleaseCiReason;
  retryAfterSeconds?: number;
  url?: string;
  branch?: string;
};

export type ReleaseCiOptions = {
  repository: string;
  workflow: string;
  sha: string;
  runner?: Runner;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
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
    !positive(entry.run_attempt) ||
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
    attempt: entry.run_attempt,
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
  let raw: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = await (options.runner ?? run)(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "GET",
          "--include",
          `repos/${options.repository}/actions/workflows/${options.workflow}/runs?head_sha=${sha}&per_page=100&page=1`,
        ],
        { timeout: 15_000 },
      );
      break;
    } catch (error) {
      let reason: ReleaseCiReason = "unavailable";
      let retryAfterSeconds: number | undefined;
      if (error instanceof CommandExecutionError) {
        retryAfterSeconds = error.retryAfterSeconds;
        // A timer never overrides a received denial or an unverified partial response.
        if (error.httpStatus === 401) reason = "unauthorized";
        else if (error.httpStatus === 403 && !error.rateLimited)
          reason = "forbidden";
        else if (error.httpStatus === 404) reason = "not-found";
        else if (
          error.outputTruncated ||
          (error.responseStarted && error.httpStatus === undefined)
        )
          reason = "malformed";
        else if (
          error.httpStatus === 429 ||
          (error.httpStatus === 403 && error.rateLimited)
        )
          reason = "rate-limited";
        else if (error.httpStatus !== undefined && error.httpStatus >= 500)
          reason = "service-unavailable";
        else if (error.httpStatus !== undefined) reason = "malformed";
        else if (error.timedOut && !error.responseStarted) reason = "timeout";
      }
      // GitHub requires at least a minute for rate limits without a usable reset hint.
      if (reason === "rate-limited" && retryAfterSeconds === undefined)
        retryAfterSeconds = 60;
      const failure: ReleaseCiEvidence = {
        ...result("unknown"),
        reason,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
      if (
        !transientCiReason(reason) ||
        attempt === 2 ||
        (retryAfterSeconds ?? 0) > 5
      )
        return failure;
      const delay = Math.max(
        1000 * (attempt + 1),
        (retryAfterSeconds ?? 0) * 1000,
      );
      await (
        options.sleep ??
        ((ms) => new Promise<void>((done) => setTimeout(done, ms)))
      )(delay);
    }
  }
  try {
    const response: unknown = JSON.parse(githubReadBody(raw ?? ""));
    const body = object(response);
    if (
      !body ||
      !Array.isArray(body.workflow_runs) ||
      !Number.isSafeInteger(body.total_count) ||
      (body.total_count as number) < 0 ||
      body.total_count !== body.workflow_runs.length ||
      body.workflow_runs.length > 100
    )
      return { ...result("unknown"), reason: "malformed" };
    if (!body.workflow_runs.length) return result("missing");
    const records = body.workflow_runs.map((entry: unknown) =>
      runRecord(entry, { ...options, sha }),
    );
    if (records.some((entry) => !entry))
      return { ...result("unknown"), reason: "malformed" };
    const runs = records as RunRecord[];
    const ids = new Set(
      runs.flatMap((entry) =>
        entry.workflowId === undefined ? [] : [entry.workflowId],
      ),
    );
    if (ids.size > 1) return { ...result("unknown"), reason: "malformed" };
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
      return { ...result("unknown"), reason: "malformed" };
    return {
      ...result(latest.state),
      runId: latest.id,
      runAttempt: latest.attempt,
      url: `https://github.com/${options.repository}/actions/runs/${latest.id}`,
      ...(latest.branch ? { branch: latest.branch } : {}),
    };
  } catch {
    return { ...result("unknown"), reason: "malformed" };
  }
}

export async function assertReleaseCi(
  options: ReleaseCiOptions,
): Promise<ReleaseCiEvidence & { state: "passed" }> {
  const evidence = await readReleaseCi(options);
  if (evidence.state !== "passed")
    throw new Error(
      `CI 尚未确认目标提交的最新工作流成功（${evidence.reason ?? evidence.state}）${evidence.retryAfterSeconds ? `；服务要求至少等待 ${evidence.retryAfterSeconds} 秒` : ""}；请重新核验。`,
    );
  return { ...evidence, state: "passed" };
}
