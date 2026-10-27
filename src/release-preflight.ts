import { lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { noSymlinks } from "./files.ts";
import type { Context } from "./wizard.ts";

export async function releaseCheckout(
  ctx: Context,
  adapter = ctx.config.release!.adapter,
): Promise<string> {
  const git = (args: string[]) =>
    ctx.runner("git", ["--no-replace-objects", ...args], { cwd: ctx.root });
  const sha = (await git(["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("无法核验本地完整提交 SHA。");
  if (
    (await git(["status", "--porcelain=v1", "--untracked-files=normal"])).trim()
  )
    throw new Error("部署要求干净的已提交工作区，请先保存并提交项目改动。");
  const rawIndex = await git(["ls-files", "-v", "-z"]);
  if (!rawIndex.endsWith("\0")) throw new Error("无法核验完整Git索引。");
  const indexed = rawIndex.split("\0").filter(Boolean);
  if (!indexed.length || indexed.some((entry) => !entry.startsWith("H ")))
    throw new Error(
      "Git索引包含隐藏变更或稀疏检出标记；请使用完整、可核验的工作区发布。",
    );
  const remote = (await git(["remote", "get-url", "origin"])).trim();
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote,
    );
  if (
    !match ||
    match[1]!.toLowerCase() !== ctx.config.repository?.toLowerCase()
  )
    throw new Error("本地origin与声明的GitHub仓库不一致。");
  await noSymlinks(resolve(ctx.root, adapter));
  const root = await realpath(ctx.root),
    path = await realpath(resolve(root, adapter));
  const child = relative(root, path);
  if (
    child.startsWith("..") ||
    isAbsolute(child) ||
    !(await lstat(path)).isFile()
  )
    throw new Error("发布适配器必须是项目内普通文件。");
  const tracked = (
    await git(["ls-files", "--error-unmatch", "--", adapter])
  ).trim();
  if (tracked !== adapter) throw new Error("发布适配器尚未被Git跟踪。");
  return sha;
}
export function releaseProcessEnvironment(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TMP",
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
    LANG: "C",
    LC_ALL: "C",
    ...extra,
  };
}
export type AdapterOutput = {
  ready: boolean;
  summary: string[];
  missing: string[];
  effects: string[];
};
export function adapterOutput(raw: string): AdapterOutput {
  let value: AdapterOutput;
  try {
    value = JSON.parse(raw) as AdapterOutput;
  } catch {
    throw new Error("发布适配器未返回合法JSON结果。");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["ready", "summary", "missing", "effects"].includes(key),
    ) ||
    typeof value.ready !== "boolean" ||
    [value.summary, value.missing, value.effects].some(
      (list) =>
        !Array.isArray(list) ||
        list.length > 50 ||
        list.some(
          (line) =>
            typeof line !== "string" ||
            line.length > 1000 ||
            /[\x00-\x1f\x7f-\x9f]/.test(line),
        ),
    )
  )
    throw new Error("发布适配器结果不符合受限协议。");
  return value;
}
