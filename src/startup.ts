import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig, type Config } from "./config.ts";
import { missing, readJson, singleLine, writePrivate } from "./files.ts";
import { ProjectStore, projectDirectory } from "./projects.ts";
import type { UI } from "./wizard.ts";

type Startup = {
  cwd: string;
  home: string;
  base: string;
  ui: UI;
  root?: string;
  manifest?: string;
  init?: boolean;
  memory?: boolean;
};

async function directory(path: string): Promise<string> {
  singleLine(path);
  try {
    const root = await realpath(path);
    if ((await stat(root)).isDirectory()) return root;
  } catch {
    /* Report the chosen path, never configuration contents. */
  }
  throw new Error(`项目目录不存在或不可访问：${path}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function discover(
  cwd: string,
  home: string,
  registered: string[] = [],
): Promise<string> {
  let candidate = cwd;
  while (true) {
    if (
      (await exists(join(candidate, "infra.setup.json"))) ||
      (await exists(join(candidate, ".git"))) ||
      registered.includes(candidate)
    )
      return candidate;
    const parent = dirname(candidate);
    if (candidate === home || parent === candidate) return cwd;
    candidate = parent;
  }
}

async function chooseRoot(
  options: Startup,
  store: ProjectStore,
): Promise<string> {
  const cwd = await directory(options.cwd);
  const home = await directory(options.home);
  if (options.root !== undefined) return directory(resolve(cwd, options.root));
  // Explicit config paths retain the original cwd semantics unless --root is set.
  if (options.manifest !== undefined) return cwd;
  const saved = options.memory ? [] : await store.list(options.ui.log);
  const current = await discover(
    cwd,
    home,
    saved.map((record) => record.root),
  );
  const choices = [
    ...(current !== home
      ? [{ name: `当前项目：${current}`, value: "current" }]
      : []),
    ...saved
      .filter((record) => record.root !== current)
      .map((record) => ({
        name: `${record.config.project} — ${record.root}`,
        value: `saved:${record.root}`,
      })),
    { name: "选择其他项目目录", value: "new" },
  ];
  const selected = await options.ui.select("选择要配置的项目", choices);
  if (selected === "current") return current;
  if (selected.startsWith("saved:")) return directory(selected.slice(6));
  if (selected !== "new") throw new Error("未知项目选择。");
  const input = await options.ui.input(
    "项目目录（支持绝对路径、相对当前目录或 ~/）",
  );
  if (!input.trim()) throw new Error("项目目录不能为空。");
  return directory(
    input === "~"
      ? home
      : input.startsWith("~/")
        ? resolve(home, input.slice(2))
        : resolve(cwd, input),
  );
}

async function initialize(root: string, options: Startup): Promise<Config> {
  const source = await options.ui.select("选择配置来源", [
    { name: "zoncord 模板", value: "zoncord" },
    { name: "通用项目映射", value: "generic" },
    { name: "导入已有映射 JSON", value: "import" },
  ]);
  if (source === "zoncord")
    return validateConfig(
      await readJson(
        fileURLToPath(new URL("../examples/zoncord.json", import.meta.url)),
      ),
    );
  if (source === "import") {
    const path = await options.ui.input("已有映射 JSON 路径");
    if (!path.trim()) throw new Error("配置路径不能为空。");
    const expanded = path.startsWith("~/")
      ? resolve(options.home, path.slice(2))
      : resolve(options.cwd, path);
    return validateConfig(await readJson(expanded));
  }
  if (source !== "generic") throw new Error("未知配置来源。");
  const project = await options.ui.input("项目名称（小写字母、数字、连字符）", {
    value: basename(root),
  });
  const repository = await options.ui.input("GitHub 仓库 owner/repo（可留空）");
  return validateConfig({
    version: 1,
    project,
    ...(repository ? { repository } : {}),
    environments: ["staging", "production"],
    variables: {
      cloudflareAccountId: "CF_ACCOUNT_ID",
      cloudflareToken: "CLOUDFLARE_API_TOKEN",
      pagesProject: "CF_PAGES_PROJECT",
      workerName: "CF_WORKER_NAME",
      siteOrigin: "SITE_ORIGIN",
      appOrigin: "APP_ORIGIN",
      supabaseUrl: "SUPABASE_URL",
      supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
    },
  });
}

export async function prepareProject(
  options: Startup,
): Promise<{ root: string; config: Config }> {
  const store = new ProjectStore(options.base);
  const root = await chooseRoot(options, store);
  const explicit = options.manifest !== undefined;
  const path = resolve(root, options.manifest ?? "infra.setup.json");
  const local = await exists(path);
  const saved =
    !explicit && !local && !options.memory ? await store.read(root) : undefined;
  if (options.init && (local || saved))
    throw new Error("项目配置已存在，不会覆盖。");
  let config: Config;
  if (options.init) {
    config = await initialize(root, options);
    if (explicit)
      await writePrivate(path, `${JSON.stringify(config, null, 2)}\n`, null);
  } else if (explicit || local) {
    if (!local) throw new Error(`指定的配置文件不存在：${path}`);
    config = validateConfig(await readJson(path));
  } else config = saved?.config ?? (await initialize(root, options));
  if (!options.memory) await store.save(root, config);
  options.ui.log(
    `当前项目：${config.project}\n项目目录：${root}\n配置映射：${explicit || local ? path : options.memory ? "本次内存" : join(projectDirectory(options.base, root), "project.json")}`,
  );
  return { root, config };
}
