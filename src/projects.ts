import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validateConfig, type Config } from "./config.ts";
import {
  missing,
  noSymlinks,
  readPrivate,
  singleLine,
  writePrivate,
} from "./files.ts";

export type ProjectRecord = { version: 1; root: string; config: Config };

export function projectDirectory(base: string, root: string): string {
  const absolute = resolve(root);
  const label =
    absolute
      .replace(/[^a-zA-Z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-80) || "project";
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
  return join(base, "project-setup", "projects", `${label}-${hash}`);
}

// Save only the declarative mapping, never unrecognized imported properties.
function mapping(input: unknown): Config {
  const config = validateConfig(input);
  return {
    version: config.version,
    project: config.project,
    environments: config.environments,
    variables: config.variables,
    ...(config.setup !== undefined ? { setup: config.setup } : {}),
    ...(config.migrationStrategy !== undefined
      ? { migrationStrategy: config.migrationStrategy }
      : {}),
    ...(config.deploymentTopology !== undefined
      ? { deploymentTopology: config.deploymentTopology }
      : {}),
    ...(config.repository !== undefined
      ? { repository: config.repository }
      : {}),
    ...(config.defaults !== undefined ? { defaults: config.defaults } : {}),
    ...(config.extraFields !== undefined
      ? { extraFields: config.extraFields }
      : {}),
    ...(config.jsonExport !== undefined
      ? { jsonExport: config.jsonExport }
      : {}),
    ...(config.githubSecrets !== undefined
      ? { githubSecrets: config.githubSecrets }
      : {}),
    ...(config.envExports !== undefined
      ? { envExports: config.envExports }
      : {}),
  };
}

export class ProjectStore {
  private readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  private async record(path: string): Promise<ProjectRecord | undefined> {
    const raw = await readPrivate(path);
    if (raw === undefined) return undefined;
    let record: ProjectRecord;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error("本地项目映射不是有效 JSON；未覆盖。");
    }
    if (
      !record ||
      record.version !== 1 ||
      typeof record.root !== "string" ||
      !isAbsolute(record.root) ||
      resolve(record.root) !== record.root
    )
      throw new Error("本地项目映射版本或路径不合法。");
    singleLine(record.root);
    if (dirname(path) !== projectDirectory(this.base, record.root))
      throw new Error("本地项目映射路径不匹配；未覆盖。");
    return { version: 1, root: record.root, config: mapping(record.config) };
  }

  async read(root: string): Promise<ProjectRecord | undefined> {
    return this.record(join(projectDirectory(this.base, root), "project.json"));
  }

  async list(
    warn: (message: string) => void = () => {},
  ): Promise<ProjectRecord[]> {
    const path = join(this.base, "project-setup", "projects");
    await noSymlinks(path);
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const result: ProjectRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const record = await this.record(
          join(path, entry.name, "project.json"),
        );
        if (record) result.push(record);
      } catch {
        warn(
          `已跳过无法安全读取的本地项目记录：${join(path, entry.name)}。请检查权限或文件完整性。`,
        );
      }
    }
    return result.sort((a, b) => a.root.localeCompare(b.root));
  }

  async save(root: string, config: Config): Promise<void> {
    const absolute = resolve(root);
    singleLine(absolute);
    const path = join(projectDirectory(this.base, absolute), "project.json");
    const previous = await readPrivate(path);
    if (previous !== undefined) await this.record(path);
    const contents = `${JSON.stringify({ version: 1, root: absolute, config: mapping(config) }, null, 2)}\n`;
    if (previous !== contents)
      await writePrivate(path, contents, previous ?? null);
  }
}
