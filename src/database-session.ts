import { Api, Supabase } from "./providers.ts";

/** PAT stays in setup; only a short-lived database login reaches the trusted DB adapter. */
export async function temporaryDatabaseSession(
  token: string,
  ref: string,
  organization: string,
  fetcher?: typeof fetch,
): Promise<{ uri: string; expiresAt: string }> {
  const client = new Supabase(token, fetcher),
    api = new Api("https://api.supabase.com/v1", token, fetcher);
  const project = await client.project(ref);
  if (
    project.organization_id !== organization ||
    project.status !== "ACTIVE_HEALTHY"
  )
    throw new Error("数据库临时连接要求已核验的活动项目和组织。");
  const poolers = await api.request<
    Array<{
      database_type: string;
      db_host: string;
      db_port: number;
      db_user: string;
      db_name: string;
    }>
  >(`/projects/${ref}/config/database/pooler`);
  if (!Array.isArray(poolers)) throw new Error("Supabase pooler 响应无效。");
  const primary = poolers.filter((p) => p.database_type === "PRIMARY");
  if (primary.length !== 1)
    throw new Error("不能唯一确认主数据库 pooler；请显式配置数据库 URI。");
  const p = primary[0]!;
  if (
    !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(p.db_host) ||
    ![5432, 6543].includes(p.db_port) ||
    p.db_user !== `postgres.${ref}` ||
    p.db_name !== "postgres"
  )
    throw new Error("数据库 pooler 身份与项目不匹配。");
  const role = await api.request<{
    role: string;
    password: string;
    ttl_seconds: number;
  }>(`/projects/${ref}/cli/login-role`, "POST", { read_only: false });
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(role.role) ||
    typeof role.password !== "string" ||
    !role.password ||
    /[\x00-\x1f]/.test(role.password) ||
    !Number.isSafeInteger(role.ttl_seconds) ||
    role.ttl_seconds < 120 ||
    role.ttl_seconds > 86400
  )
    throw new Error("临时数据库登录响应无效或有效期不足；未输出或持久化凭据。");
  const uri = new URL(`postgresql://${p.db_host}:${p.db_port}/postgres`);
  uri.username = `${role.role}.${ref}`;
  uri.password = role.password;
  uri.searchParams.set("sslmode", "verify-full");
  return {
    uri: uri.toString(),
    expiresAt: new Date(Date.now() + role.ttl_seconds * 1000).toISOString(),
  };
}
