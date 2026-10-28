import { join } from "node:path";
import { projectKey, type Config } from "./config.ts";
import { readPrivate } from "./files.ts";
import { legacyVaultProfileKey, StateStore, vaultProfileKey } from "./state.ts";
import {
  MIN_VAULT_PASSPHRASE_LENGTH,
  Vault,
  type Values,
  type VaultData,
} from "./vault.ts";
import type { UI } from "./wizard.ts";

export type StorageMode = "vault" | "metadata" | "memory";
export type Storage = {
  data: VaultData;
  mode: StorageMode;
  vaultReferences?: Record<string, Values>;
  save(): Promise<void>;
  close(): void;
};
type StorageOptions = {
  base: string;
  root: string;
  config: Config;
  mode: StorageMode;
  ui: Pick<UI, "input" | "confirm" | "log">;
};

async function unlockVault({ base, ui }: StorageOptions): Promise<Vault> {
  const path = join(base, "project-setup", "vault.json");
  const exists = (await readPrivate(path)) !== undefined;
  ui.log(
    `本机保险库：${path}。scrypt + AES-256-GCM；忘记口令无法恢复。口令不会保存。`,
  );
  const passphrase = await ui.input(
    exists
      ? "解锁保险库口令"
      : `新建保险库口令（至少 ${MIN_VAULT_PASSPHRASE_LENGTH} 字符）`,
    { secret: true },
  );
  if (!exists) {
    if (passphrase.length < MIN_VAULT_PASSPHRASE_LENGTH)
      throw new Error(
        `保险库口令至少 ${MIN_VAULT_PASSPHRASE_LENGTH} 个字符，未创建保险库。`,
      );
    if (passphrase !== (await ui.input("再次输入保险库口令", { secret: true })))
      throw new Error("两次口令不一致，未创建保险库。");
  }
  return Vault.open(path, passphrase);
}

async function mergeProfiles(
  options: StorageOptions,
  data: VaultData,
  vault: Vault,
): Promise<VaultData> {
  const { root, config, ui } = options;
  const profiles = { ...data.profiles };
  for (const env of config.environments) {
    const key = projectKey(config.project, env);
    let stored = vault.data.profiles[vaultProfileKey(root, config, env)];
    const legacy =
      vault.data.profiles[legacyVaultProfileKey(root, config, env)] ??
      vault.data.profiles[key];
    if (!stored && legacy) {
      if (
        (!legacy["@repository"] ||
          legacy["@repository"] === config.repository) &&
        (await ui.confirm(
          `旧保险库 ${config.project}/${env} 未绑定本地路径；确认复制导入到 ${root}？`,
        ))
      )
        stored = legacy;
      else
        ui.log(
          `未导入旧保险库 ${config.project}/${env}：仓库不匹配或未确认。旧记录保持原样。`,
        );
    }
    if (stored) profiles[key] = { ...stored, ...profiles[key] };
  }
  return { credentials: { ...vault.data.credentials }, profiles };
}

export async function openStorage(options: StorageOptions): Promise<Storage> {
  const { base, root, config, mode, ui } = options;
  let vault: Vault | undefined;
  let state: StateStore | undefined;
  let data: VaultData = { credentials: {}, profiles: {} };
  try {
    // Unlock first so a failed or cancelled prompt cannot migrate public state.
    if (mode === "vault") vault = await unlockVault(options);
    if (mode !== "memory") {
      state = await StateStore.open(base, root, config, (message) =>
        ui.confirm(message),
      );
      data = state.data;
    }
    if (vault) data = await mergeProfiles(options, data, vault);
    ui.log(
      mode === "vault"
        ? "统一加密保险库已解锁；各服务手动 Token、项目 Key 和敏感配置将在操作成功后加密保存。官方 CLI 登录仍由官方工具管理。"
        : mode === "memory"
          ? "内存模式：退出后不保留凭据与配置；显式选择导出仍会写入所选目标。"
          : "仅保存公开配置与账号绑定；凭据仅本次使用，不读取或修改保险库。",
    );
  } catch (error) {
    vault?.close();
    throw error;
  }
  let closed = false;
  return {
    data,
    mode,
    vaultReferences: vault?.data.profiles,
    async save() {
      if (closed) throw new Error("本地存储已关闭，请重新打开后重试。");
      if (vault) {
        vault.data.credentials = data.credentials;
        for (const env of config.environments) {
          const profile = data.profiles[projectKey(config.project, env)];
          if (profile)
            vault.data.profiles[vaultProfileKey(root, config, env)] = profile;
        }
        await vault.save();
      }
      await state?.save(data);
    },
    close() {
      if (closed) return;
      closed = true;
      vault?.close();
    },
  };
}
