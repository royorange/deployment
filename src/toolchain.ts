import {
  ensureSupabaseCli,
  inspectSupabaseCli,
  type SupabaseCliInspection,
} from "./managed-cli.ts";
import {
  WRANGLER_VERSION,
  ensureWrangler,
  resolveWrangler,
} from "./managed-wrangler.ts";
import { CommandUnavailableError, run, type Runner } from "./process.ts";

type ToolOptions = {
  runner?: Runner;
  ui: {
    confirm(message: string): Promise<boolean>;
    log(message: string): void;
  };
  inspect?: typeof inspectSupabaseCli;
  ensure?: typeof ensureSupabaseCli;
  ensureWranglerCli?: typeof ensureWrangler;
};

export function createToolchain(options: ToolOptions): {
  runner: Runner;
  ensureSupabaseCli: () => Promise<boolean>;
  ensureWrangler: (root: string) => Promise<boolean>;
} {
  const raw = options.runner ?? run;
  let command: string | undefined;
  return {
    runner: (async (name, args, settings) => {
      if (name !== "supabase") return raw(name, args, settings);
      if (!command) {
        const result = await (options.inspect ?? inspectSupabaseCli)({
          runner: raw,
        });
        command = result.command;
      }
      if (!command) throw new CommandUnavailableError("supabase");
      return raw(command, args, settings);
    }) satisfies Runner,
    ensureSupabaseCli: async (): Promise<boolean> => {
      command = await (options.ensure ?? ensureSupabaseCli)({
        runner: raw,
        ui: options.ui,
      });
      return command !== undefined;
    },
    ensureWrangler: (root: string) =>
      (options.ensureWranglerCli ?? ensureWrangler)({
        root,
        runner: raw,
        ui: options.ui,
      }),
  };
}

async function toolLine(
  name: string,
  version: () => Promise<string>,
  found?: string,
  absent = "未能执行；使用对应服务的官方登录时需要安装。",
): Promise<string> {
  try {
    const output = await version();
    const number = /\b\d+\.\d+\.\d+\b/.exec(output)?.[0];
    const where = found ? `（${found}）` : "";
    return `${name}：${number ? `可用 ${number}` : "可执行，版本未识别"}${where}`;
  } catch {
    return `${name}：${absent}`;
  }
}
async function wranglerLine(
  root: string,
  runner: Runner,
  base?: string,
): Promise<string> {
  let wrangler;
  try {
    wrangler = await resolveWrangler(root, process.cwd(), base);
  } catch (error) {
    return `wrangler：${error instanceof Error ? error.message : "私有缓存检查失败"}`;
  }
  const where = {
    project: `项目依赖：${wrangler.location}`,
    managed: `setup 私有缓存：${wrangler.location}`,
    global: "系统 PATH",
  }[wrangler.source];
  const checked = [...new Set([root, process.cwd()])].join("、");
  return toolLine(
    "wrangler",
    () =>
      runner(wrangler.command, [...wrangler.prefix, "--version"], {
        cwd: root,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      }),
    where,
    wrangler.source === "global"
      ? `未找到（已检查 ${checked} 的项目依赖、setup 私有缓存和系统 PATH）；连接 Cloudflare 时可确认安装固定版本 ${WRANGLER_VERSION}。`
      : `无法运行（${where}）；请重新安装对应依赖后重试。`,
  );
}
export async function dependencyReport(
  root: string,
  runner: Runner = run,
  inspect: (options: {
    runner: Runner;
  }) => Promise<SupabaseCliInspection> = inspectSupabaseCli,
  wranglerBase?: string,
): Promise<string[]> {
  const lines = [
    "Supabase API：内置，无需 Supabase CLI；连接仍需管理 PAT 授权。",
  ];
  lines.push(
    await toolLine("gh", () => runner("gh", ["--version"], { cwd: root })),
  );
  lines.push(await wranglerLine(root, runner, wranglerBase));
  const supabase = await inspect({ runner });
  lines.push(
    `Supabase CLI（仅迁移或显式官方登录需要）：${supabase.kind === "existing" || supabase.kind === "cached" ? `可用 ${supabase.version ?? ""}${supabase.kind === "cached" ? "（托管缓存）" : ""}` : supabase.kind === "unsupported" ? "当前平台不支持托管安装" : "未安装兼容版本，可在需要时按需安装固定官方版本"}。`,
  );
  return lines;
}
