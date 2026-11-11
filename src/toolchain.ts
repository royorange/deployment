import {
  ensureSupabaseCli,
  inspectSupabaseCli,
  type SupabaseCliInspection,
} from "./managed-cli.ts";
import { wranglerRun } from "./official.ts";
import { CommandUnavailableError, run, type Runner } from "./process.ts";

type ToolOptions = {
  runner?: Runner;
  ui: {
    confirm(message: string): Promise<boolean>;
    log(message: string): void;
  };
  inspect?: typeof inspectSupabaseCli;
  ensure?: typeof ensureSupabaseCli;
};

export function createToolchain(options: ToolOptions): {
  runner: Runner;
  ensureSupabaseCli: () => Promise<boolean>;
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
  };
}

export async function dependencyReport(
  root: string,
  runner: Runner = run,
  inspect: (options: {
    runner: Runner;
  }) => Promise<SupabaseCliInspection> = inspectSupabaseCli,
): Promise<string[]> {
  const lines = [
    "Supabase API：内置，无需 Supabase CLI；连接仍需管理 PAT 授权。",
  ];
  for (const name of ["gh", "wrangler"]) {
    try {
      const output =
        name === "wrangler"
          ? await wranglerRun(root, ["--version"], runner)
          : await runner(name, ["--version"], { cwd: root });
      const version = /\b\d+\.\d+\.\d+\b/.exec(output)?.[0];
      lines.push(
        `${name}：${version ? `可用 ${version}` : "可执行，版本未识别"}`,
      );
    } catch {
      lines.push(`${name}：未能执行；使用对应服务的官方登录时需要安装。`);
    }
  }
  const supabase = await inspect({ runner });
  lines.push(
    `Supabase CLI（仅迁移或显式官方登录需要）：${supabase.kind === "existing" || supabase.kind === "cached" ? `可用 ${supabase.version ?? ""}${supabase.kind === "cached" ? "（托管缓存）" : ""}` : supabase.kind === "unsupported" ? "当前平台不支持托管安装" : "未安装兼容版本，可在需要时按需安装固定官方版本"}。`,
  );
  return lines;
}
