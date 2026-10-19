#!/usr/bin/env node
import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readPrivate } from "./files.ts";
import { Vault, type VaultData } from "./vault.ts";
import { StateStore, vaultProfileKey, legacyVaultProfileKey } from "./state.ts";
import { prepareProject } from "./startup.ts";
import { projectKey } from "./config.ts";
import { defaultRunner, safeMessage, wizard, type UI } from "./wizard.ts";
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
function argumentsFor(argv: string[]): {
  root?: string;
  manifest?: string;
  memory: boolean;
  vault: boolean;
  help: boolean;
  init: boolean;
  doctor: boolean;
} {
  let root: string | undefined;
  let manifest: string | undefined;
  let memory = false;
  let vault = false;
  let help = false;
  let init = false;
  let doctor = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--memory") memory = true;
    else if (arg === "--vault") vault = true;
    else if (arg === "--init") init = true;
    else if (arg === "--doctor") doctor = true;
    else if (arg === "--root" || arg === "--config") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("参数缺少路径。");
      if (arg === "--root") root = resolve(value);
      else manifest = value;
    } else
      throw new Error(
        "未知参数；请运行 project-setup --help。不要通过命令行参数传递凭据。",
      );
  }
  if (memory && vault) throw new Error("--memory 与 --vault 不能同时使用。");
  return { root, manifest, memory, vault, help, init, doctor };
}
async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2));
  if (args.help) {
    ui.log(
      "project-setup [--root 项目目录] [--config infra.setup.json] [--memory | --vault] [--init] [--doctor]\n\n无需指定 --root：识别当前项目，也可选择已记录的项目或输入其他目录。\n首次运行可选择 zoncord 模板、通用映射或导入 JSON；默认保存到用户隐藏目录。\nSupabase 默认用 Management API / PAT，无需 CLI；Cloudflare/GitHub 复用官方登录。无需新建保险库口令。\n默认仅保存公开项目映射与账号绑定，Token/项目 Key 不落盘。\n--vault 主动启用可选加密保险库，保存手动输入的 Token/Key；不会复制官方登录凭据。\n--memory 不读取本地项目记录、不保存本次配置；--init 初始化用户目录映射，配合 --config 则创建指定文件。\n优先级：--config > 项目 infra.setup.json > 用户目录项目映射。\n本地存储：$XDG_CONFIG_HOME/project-setup（未设置时 ~/.config）。\n--doctor 检查可选依赖，不登录或自动下载。\nToken 页面：https://supabase.com/dashboard/account/tokens\n需要 Node >=22.18；GitHub/Cloudflare 官方登录需要 gh/Wrangler。Supabase CLI 仅迁移或显式官方登录需要，缺少时可确认安装校验过的固定版。\n本工具不发布业务代码或升级套餐；CI 使用项目现有部署脚本和 CI Secrets。",
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
  let vault: Vault | undefined;
  const state = args.memory
    ? undefined
    : await StateStore.open(base, root, config, ui.confirm);
  let data: VaultData = state?.data ?? { credentials: {}, profiles: {} };
  if (args.vault) {
    const path = join(base, "project-setup", "vault.json");
    const exists = (await readPrivate(path)) !== undefined;
    ui.log(
      `本机保险库：${path}。scrypt + AES-256-GCM；忘记口令无法恢复。口令不会保存。`,
    );
    const passphrase = await ui.input(
      exists ? "解锁保险库口令" : "新建保险库口令（至少 12 字符）",
      { secret: true },
    );
    if (
      !exists &&
      passphrase !== (await ui.input("再次输入保险库口令", { secret: true }))
    )
      throw new Error("两次口令不一致，未创建保险库。");
    vault = await Vault.open(path, passphrase);
    const profiles = { ...data.profiles };
    for (const targetEnv of config.environments) {
      const key = projectKey(config.project, targetEnv);
      let stored =
        vault.data.profiles[vaultProfileKey(root, config, targetEnv)];
      const legacy =
        vault.data.profiles[legacyVaultProfileKey(root, config, targetEnv)] ??
        vault.data.profiles[key];
      if (!stored && legacy) {
        if (
          (!legacy["@repository"] ||
            legacy["@repository"] === config.repository) &&
          (await ui.confirm(
            `旧保险库 ${config.project}/${targetEnv} 未绑定本地路径；确认复制导入到 ${root}？`,
          ))
        )
          stored = legacy;
        else
          ui.log(
            `未导入旧保险库 ${config.project}/${targetEnv}：仓库不匹配或未确认。旧记录保持原样。`,
          );
      }
      if (stored) profiles[key] = { ...stored, ...profiles[key] };
    }
    data = { credentials: { ...vault.data.credentials }, profiles };
  } else if (args.memory)
    ui.log("内存模式：退出后不保留凭据与配置；显式选择导出仍会写入所选目标。");
  else
    ui.log(
      "默认模式：Supabase 用 API/PAT；官方 CLI 登录可选。只保存公开配置与账号绑定。临时 Token/Key 仅留本次内存；使用 --vault 才加密保存。",
    );
  try {
    const tools = createToolchain({ runner: defaultRunner, ui });
    await wizard({
      root,
      config,
      env,
      data,
      storageMode: args.vault ? "vault" : args.memory ? "memory" : "metadata",
      vaultReferences: vault?.data.profiles,
      ui,
      runner: tools.runner,
      ensureSupabaseCli: tools.ensureSupabaseCli,
      save: async () => {
        if (vault) {
          vault.data.credentials = data.credentials;
          for (const targetEnv of config.environments) {
            const profile =
              data.profiles[projectKey(config.project, targetEnv)];
            if (profile)
              vault.data.profiles[vaultProfileKey(root, config, targetEnv)] =
                profile;
          }
          await vault.save();
        }
        await state?.save(data);
      },
    });
  } finally {
    vault?.close();
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
