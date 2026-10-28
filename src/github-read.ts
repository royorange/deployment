export type GithubReadMetadata = {
  httpStatus?: number;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
};

function headers(raw: string) {
  const end = /\r?\n\r?\n/.exec(raw);
  if (!end || end.index > 16_384) return;
  const lines = raw.slice(0, end.index).split(/\r?\n/);
  const status = /^HTTP\/\d(?:\.\d)? ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(
    lines.shift() ?? "",
  );
  if (!status || lines.length > 100) return;
  const values = new Map<string, string[]>();
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match) return;
    const key = match[1]!.toLowerCase();
    if (
      ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"].includes(
        key,
      )
    )
      values.set(key, [...(values.get(key) ?? []), match[2]!.trim()]);
  }
  const one = (key: string) => {
    const list = values.get(key);
    return list?.length === 1 ? list[0] : undefined;
  };
  return {
    status: Number(status[1]),
    one,
    bodyStart: end.index + end[0].length,
  };
}

/** Parse only public HTTP facts from one fixed, read-only GitHub CLI operation. */
export function githubReadMetadata(
  command: string,
  args: string[],
  raw: string,
  now = Date.now(),
): GithubReadMetadata | undefined {
  if (
    command !== "gh" ||
    args.length !== 7 ||
    JSON.stringify(args.slice(0, 6)) !==
      JSON.stringify([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
      ])
  )
    return;
  if (
    !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/workflows\/[A-Za-z0-9_.-]+\.ya?ml\/runs\?head_sha=[a-f0-9]{40}&per_page=100&page=1$/.test(
      args.at(-1) ?? "",
    )
  )
    return;
  const parsed = headers(raw);
  if (!parsed) return;
  const remaining = parsed.one("x-ratelimit-remaining");
  const retry = parsed.one("retry-after");
  const limited =
    parsed.status === 429 ||
    (parsed.status === 403 &&
      (remaining === "0" || (retry !== undefined && /^\d{1,15}$/.test(retry))));
  let seconds: number | undefined;
  if (retry && /^\d{1,15}$/.test(retry)) seconds = Number(retry);
  else if (
    retry &&
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      retry,
    ) &&
    Number.isFinite(Date.parse(retry))
  )
    seconds = Math.max(0, Math.ceil((Date.parse(retry) - now) / 1000));
  else if (!retry && limited) {
    const reset = parsed.one("x-ratelimit-reset");
    if (reset && /^\d{1,13}$/.test(reset))
      seconds = Math.max(0, Math.ceil(Number(reset) - now / 1000));
  }
  return {
    httpStatus: parsed.status,
    ...(limited ? { rateLimited: true } : {}),
    ...(seconds !== undefined && Number.isSafeInteger(seconds)
      ? { retryAfterSeconds: Math.min(seconds, 86_400) }
      : {}),
  };
}

export function githubReadBody(raw: string): string {
  // Injectable runners may return already decoded JSON. The real CLI uses --include.
  if (!raw.startsWith("HTTP/")) return raw;
  const parsed = headers(raw);
  if (!parsed || parsed.status !== 200)
    throw new Error("GitHub CI 响应头或 HTTP 状态无法核验。");
  return raw.slice(parsed.bodyStart);
}
