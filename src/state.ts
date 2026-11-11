import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { allFields, projectKey, validateField, type Config } from "./config.ts";
import { readPrivate, singleLine, writePrivate } from "./files.ts";
import type { Values, VaultData } from "./vault.ts";

const bindings = new Set([
  "@cloudflare",
  "@cloudflareSource",
  "@cloudflareProfile",
  "@cloudflareIdentity",
  "@cloudflareDeploy",
  "@cloudflareTunnelManagement",
  "@supabase",
  "@supabaseSource",
  "@supabaseProfile",
  "@supabaseIdentity",
  "@supabaseEmail",
  "@supabaseIdentityMode",
  "@supabaseOrganization",
  "@repository",
  "@githubIdentity",
  "@githubLogin",
  "@releaseDeviceId",
]);
export function vaultProfileKey(
  root: string,
  config: Config,
  env: string,
): string {
  return JSON.stringify([...projectScope(root, config), env]);
}
export function legacyVaultProfileKey(
  root: string,
  config: Config,
  env: string,
): string {
  return JSON.stringify([
    config.project,
    config.repository ?? resolve(root),
    env,
  ]);
}
function projectScope(root: string, config: Config): string[] {
  return [config.project, config.repository ?? resolve(root), resolve(root)];
}
function statePath(base: string, scope: string): string {
  const hash = createHash("sha256").update(scope).digest("hex");
  return join(base, "project-setup", "state", `${hash}.json`);
}
function publicValues(config: Config, input: Values): Values {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("本地项目绑定必须为对象。");
  const result: Values = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") throw new Error("本地绑定信息不合法。");
    if (bindings.has(key)) {
      singleLine(value);
      if (value.length > 200) throw new Error("账号绑定信息过长。");
      result[key] = value;
    } else if (
      Object.hasOwn(allFields(config), key) &&
      !allFields(config)[key]!.secret
    )
      result[key] = validateField(config, key, value);
  }
  return result;
}
export class StateStore {
  readonly path: string;
  data: VaultData = { credentials: {}, profiles: {} };
  private previous: string | null = null;
  private config: Config;
  private scope: string;
  private constructor(base: string, root: string, config: Config) {
    this.config = config;
    this.scope = JSON.stringify(projectScope(root, config));
    this.path = statePath(base, this.scope);
  }
  static async open(
    base: string,
    root: string,
    config: Config,
    confirmLegacy?: (message: string) => Promise<boolean>,
  ): Promise<StateStore> {
    const store = new StateStore(base, root, config);
    store.previous = (await readPrivate(store.path)) ?? null;
    if (store.previous !== null) {
      store.data.profiles = store.profilesFrom(store.previous, store.scope);
      return store;
    }
    const legacyScope = JSON.stringify([
      config.project,
      config.repository ?? resolve(root),
    ]);
    const legacy = await readPrivate(statePath(base, legacyScope));
    if (legacy !== undefined) {
      const profiles = store.profilesFrom(legacy, legacyScope);
      if (
        await confirmLegacy?.(
          `发现 ${config.repository ?? config.project} 的旧共享项目绑定；确认复制到 ${resolve(root)}？旧记录保持原样。`,
        )
      )
        store.data.profiles = profiles;
      await store.save(store.data);
    }
    return store;
  }
  private profilesFrom(
    contents: string,
    scope: string,
  ): Record<string, Values> {
    let saved: {
      version: number;
      scope: string;
      profiles: Record<string, Values>;
    };
    try {
      saved = JSON.parse(contents);
    } catch {
      throw new Error("本地项目绑定文件损坏，未覆盖。");
    }
    if (
      !saved ||
      saved.version !== 1 ||
      saved.scope !== scope ||
      !saved.profiles ||
      typeof saved.profiles !== "object" ||
      Array.isArray(saved.profiles)
    )
      throw new Error("本地项目绑定版本或仓库不匹配。");
    const profiles: Record<string, Values> = {};
    for (const env of this.config.environments) {
      const key = projectKey(this.config.project, env);
      if (Object.hasOwn(saved.profiles, key))
        profiles[key] = publicValues(this.config, saved.profiles[key]!);
    }
    return profiles;
  }
  async save(data: VaultData): Promise<void> {
    const profiles: Record<string, Values> = {};
    for (const env of this.config.environments) {
      const key = projectKey(this.config.project, env);
      if (data.profiles[key])
        profiles[key] = publicValues(this.config, data.profiles[key]);
    }
    const contents = `${JSON.stringify({ version: 1, scope: this.scope, profiles }, null, 2)}\n`;
    await writePrivate(this.path, contents, this.previous);
    this.previous = contents;
  }
}
