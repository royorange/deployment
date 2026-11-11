import { createHash } from "node:crypto";
import { databaseSourcePath } from "./release-config.ts";
import type { DatabaseSource } from "./project-database-protocol.ts";
import type { Runner } from "./process.ts";

/** Read SQL bytes from the verified commit, never mutable working files. */
export async function databaseSources(
  root: string,
  commit: string,
  paths: string[],
  runner: Runner,
): Promise<DatabaseSource[]> {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !paths.length ||
    !paths.every(databaseSourcePath)
  )
    throw new Error("数据库 SQL 来源声明无效。");
  const listing = await runner(
    "git",
    [
      "--no-replace-objects",
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      "--",
      ...paths,
    ],
    { cwd: root },
  );
  if (!listing || !listing.endsWith("\0"))
    throw new Error("数据库 SQL 提交快照为空或无法读取。");
  const sources: DatabaseSource[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of listing.split("\0").filter(Boolean)) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40})\t([^\x00-\x1f\x7f]+)$/.exec(entry);
    if (
      !match ||
      !databaseSourcePath(match[3]) ||
      !paths.some(
        (path) => match[3] === path || match[3]!.startsWith(`${path}/`),
      )
    )
      throw new Error("数据库 SQL 来源包含非普通文件或越界路径。");
    const path = match[3]!;
    if (!path.endsWith(".sql")) continue;
    if (seen.has(path) || sources.length >= 500)
      throw new Error("数据库 SQL 来源重复或超过数量限制。");
    seen.add(path);
    const sql = await runner(
      "git",
      ["--no-replace-objects", "show", `${commit}:${path}`],
      { cwd: root },
    );
    const size = Buffer.byteLength(sql);
    bytes += size;
    if (
      bytes > 20_000_000 ||
      createHash("sha1").update(`blob ${size}\0`).update(sql).digest("hex") !==
        match[2]
    )
      throw new Error("数据库 SQL 字节与提交不一致或超过大小限制。");
    sources.push({
      path,
      sha256: createHash("sha256").update(sql).digest("hex"),
      sql,
    });
  }
  if (
    !sources.length ||
    paths.some(
      (path) =>
        !sources.some(
          (source) =>
            source.path === path || source.path.startsWith(`${path}/`),
        ),
    )
  )
    throw new Error("声明的数据库来源缺少 SQL 文件。");
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}
