import type { UI } from "./wizard.ts";

export function unifiedEnvPath(environment: string): string {
  return `.project-setup/${environment}/.env`;
}

export async function resolveEnvConflicts(
  current: Record<string, string>,
  incoming: Record<string, string>,
  ui: UI,
): Promise<Record<string, string>> {
  const conflicts = Object.keys(incoming).filter(
    (name) => current[name] !== undefined && current[name] !== incoming[name],
  );
  if (!conflicts.length) return incoming;
  ui.log(`以下同名配置与当前值不同（不显示值）：${conflicts.join(", ")}`);
  const choice = await ui.select("如何处理同名配置冲突？", [
    { name: "保留已有值，仅添加缺失或相同配置", value: "keep" },
    { name: "用所选来源替换以上配置", value: "replace" },
  ]);
  return choice === "replace"
    ? incoming
    : Object.fromEntries(
        Object.entries(incoming).filter(([name]) => !conflicts.includes(name)),
      );
}
