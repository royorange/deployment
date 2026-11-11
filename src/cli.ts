#!/usr/bin/env node
import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import { homedir } from "node:os";
import { join } from "node:path";
import { argumentsFor } from "./arguments.ts";
import { openStorage } from "./storage.ts";
import { prepareProject } from "./startup.ts";
import { defaultRunner, safeMessage, type UI } from "./wizard.ts";
import { guidedWizard } from "./guided-menu.ts";
import { createToolchain, dependencyReport } from "./toolchain.ts";

const ui: UI = {
  select: (message, choices) => select({ message, choices, pageSize: 12 }),
  input: (message, options) =>
    options?.secret
      ? password({ message, mask: "*" })
      : input({ message, default: options?.value }),
  confirm: (message) => confirm({ message, default: false }),
  check: (message, choices) => checkbox({ message, choices, pageSize: 14 }),
  log: (message) => process.stdout.write(`${message}\n`),
};
async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2));
  if (args.help) {
    ui.log(
      "project-setup [--root 项目目录] [--config infra.setup.json] [--memory | --no-vault | --vault] [--init] [--doctor]\n\n无需指定 --root：识别当前项目，也可选择已记录的项目或输入其他目录。\n首次运行可选择 AWS 整站、独立前后台/API、zoncord 模板或导入 JSON；默认保存到用户隐藏目录。\n进入后可选引导配置、账号与服务、查看状态、导入导出、项目与环境、保存退出。\nSupabase 默认用 Management API / PAT，无需 CLI；Cloudflare/GitHub 复用官方登录。\n默认加密保存各服务手动输入的 Token、项目 Key 和敏感配置；首次设置保险库口令，之后解锁复用。\n保险库使用 scrypt + AES-256-GCM；主口令至少 12 字符，不保存，忘记无法恢复。\n--vault 保留兼容，等同默认模式；不会复制官方 CLI 登录凭据。\n--no-vault 仅保存公开配置与账号绑定，凭据仅本次使用，不读取或修改保险库。\n--memory 不读取本地项目记录、不保存本次配置；显式选择导出仍可写入目标。\n--init 初始化用户目录映射，配合 --config 则创建指定文件。\n优先级：--config > 项目 infra.setup.json > 用户目录项目映射。\n本地存储：$XDG_CONFIG_HOME/project-setup（未设置时 ~/.config）。\n--doctor 检查可选依赖，不登录、解锁或自动下载。\nToken 页面：https://supabase.com/dashboard/account/tokens\n需要 Node >=22.18；GitHub/Cloudflare 官方登录需要 gh/Wrangler。Supabase CLI 仅迁移或显式官方登录需要，缺少时可确认安装校验过的固定版。\n本工具不发布业务代码或升级套餐；CI 使用项目现有部署脚本和 CI Secrets。",
    );
    return;
  }
  if (args.doctor) {
    for (const line of await dependencyReport(args.root ?? process.cwd()))
      ui.log(line);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("交互向导需要本机 TTY 终端；CI 请使用项目既有部署脚本。");
  process.umask(0o077);
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const { root, config } = await prepareProject({
    ...args,
    cwd: process.cwd(),
    home: homedir(),
    base,
    ui,
  });
  const env = await ui.select(
    "选择项目环境",
    config.environments.map((env) => ({ name: env, value: env })),
  );
  const storage = await openStorage({
    base,
    root,
    config,
    mode: args.mode,
    ui,
  });
  try {
    const tools = createToolchain({ runner: defaultRunner, ui });
    await guidedWizard({
      root,
      config,
      env,
      data: storage.data,
      storageMode: storage.mode,
      vaultReferences: storage.vaultReferences,
      ui,
      runner: tools.runner,
      ensureSupabaseCli: tools.ensureSupabaseCli,
      save: storage.save,
    });
  } finally {
    storage.close();
  }
}
main().catch((error: unknown) => {
  if (
    error instanceof Error &&
    (error.name === "ExitPromptError" || error.name === "AbortPromptError")
  ) {
    process.stdout.write("\n已取消；已完成的外部操作及先前保存的配置保留。\n");
    process.exitCode = 130;
  } else {
    process.stderr.write(`${safeMessage(error)}\n`);
    process.exitCode = 1;
  }
});
