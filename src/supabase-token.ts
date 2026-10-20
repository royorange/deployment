import { ApiError, type Supabase, type SupabaseProject } from "./providers.ts";
import { openBrowser, type Runner } from "./process.ts";
import type { UI } from "./wizard.ts";

export const supabaseTokensUrl =
  "https://supabase.com/dashboard/account/tokens";
export class SupabaseTokenCancelled extends Error {}

export async function acquireSupabaseToken(
  ui: UI,
  runner: Runner,
  storageMode: "vault" | "metadata" | "memory" = "memory",
): Promise<string> {
  ui.log(supabaseTokensUrl);
  ui.log(
    `进入 Supabase Dashboard → 账号设置 → Access Tokens。创建限定组织/项目、有限有效期的 scoped PAT；不要选择全权限。PAT 不会导出到应用或 GitHub；${storageMode === "vault" ? "连接验证成功后加密保存到本机保险库，下次解锁复用" : "本次凭据仅留内存，退出后不保存"}。`,
  );
  ui.log(
    "列表选择需要 Organizations (Read) 和 Projects (account-wide) (Read)；范围受限时可手输 Project Ref，读取项目需要 Project Settings (Read)。读取 Key 当前需要 API Keys (Read) + API Key Secrets (Read)。仅配置 Auth 时另需 Auth Config (Read/Read-write) + Project Settings (Read-write)。权限详情：https://supabase.com/docs/guides/platform/personal-access-tokens",
  );
  while (true) {
    const choice = await ui.select("获取 Supabase Personal Access Token", [
      { name: "打开官方 Token 页面", value: "open" },
      { name: "已有 Token，继续隐藏输入", value: "input" },
      { name: "返回，保留原绑定", value: "back" },
    ]);
    if (choice === "back") throw new SupabaseTokenCancelled();
    if (choice === "input")
      return ui.input("SUPABASE_ACCESS_TOKEN（隐藏输入）", { secret: true });
    if (await openBrowser(supabaseTokensUrl, runner)) {
      ui.log("已请求打开官方页面。创建并复制 PAT 后，在下方隐藏输入中粘贴。");
      return ui.input("SUPABASE_ACCESS_TOKEN（隐藏输入）", { secret: true });
    }
    ui.log("未能自动打开浏览器，请手动打开上方官方链接，再选择隐藏输入。");
  }
}

export async function tokenIdentity(
  client: Supabase,
  token: string,
): Promise<{ id: string; email: string } | undefined> {
  try {
    return await client.identity();
  } catch (error) {
    // Scoped organization/project PATs cannot read /profile. Resource access is
    // verified independently; a 401 or a classic token must never downgrade.
    if (
      token.startsWith("sbp_fc") &&
      error instanceof ApiError &&
      error.status === 403
    )
      return undefined;
    throw error;
  }
}

export async function selectTokenProject(
  client: Pick<Supabase, "organizations" | "projects"> &
    Partial<Pick<Supabase, "project">>,
  ui: UI,
  clean: (value: string) => string,
): Promise<SupabaseProject> {
  try {
    const [organizations, projects] = await Promise.all([
      client.organizations(),
      client.projects(),
    ]);
    if (!projects.length)
      throw new Error("该 Token 没有可见项目，请检查资源范围或先创建项目。");
    const org = await ui.select(
      "选择 Supabase Organization（不要仅凭项目名称区分账号）",
      organizations.map((org) => ({
        name: `${clean(org.name)} (${clean(org.id)})`,
        value: org.id,
      })),
    );
    const candidates = projects.filter(
      (project) => project.organization_id === org,
    );
    if (!candidates.length) throw new Error("所选组织没有项目。");
    const ref = await ui.select(
      "选择项目：名称 / Ref / 区域 / 状态",
      candidates.map((project) => ({
        name: `${clean(project.name)} / ${clean(project.id)} / ${clean(project.region)} / ${clean(project.status)}`,
        value: project.id,
      })),
    );
    return candidates.find((project) => project.id === ref)!;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403 || !client.project)
      throw error;
    ui.log(
      "Token 没有组织或项目列表权限。可直接验证限定范围的 Project Ref，无需扩大到全权限。",
    );
    const choice = await ui.select("按限定项目继续？", [
      { name: "手动输入 Project Ref 并验证项目访问", value: "ref" },
      { name: "返回，保留原绑定", value: "back" },
    ]);
    if (choice === "back") throw new SupabaseTokenCancelled();
    return client.project(
      (await ui.input("Supabase Project Ref（20 位小写字母）")).trim(),
    );
  }
}
