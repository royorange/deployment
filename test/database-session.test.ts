import assert from "node:assert/strict";
import test from "node:test";
import { temporaryDatabaseSession } from "../src/database-session.ts";
const ref = "b".repeat(20);
test("temporary DB session binds API-derived pooler and expiring role without resetting passwords", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push(`${options?.method ?? "GET"} ${new URL(String(url)).pathname}`);
    if (String(url).endsWith("/pooler"))
      return Response.json([
        {
          database_type: "PRIMARY",
          db_host: "aws-0-ap-northeast-1.pooler.supabase.com",
          db_port: 6543,
          db_user: `postgres.${ref}`,
          db_name: "postgres",
        },
      ]);
    if (String(url).endsWith("/login-role"))
      return Response.json({
        role: "cli_login_postgres",
        password: "fixture-only",
        ttl_seconds: 300,
      });
    return Response.json({
      id: ref,
      organization_id: "org",
      status: "ACTIVE_HEALTHY",
    });
  };
  const session = await temporaryDatabaseSession(
    "fixture-pat",
    ref,
    "org",
    fetcher,
  );
  const uri = new URL(session.uri);
  assert.equal(uri.username, `cli_login_postgres.${ref}`);
  assert.equal(uri.port, "6543");
  assert.equal(
    calls.some((c) => c.includes("/password")),
    false,
  );
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
});
test("unknown pooler or project scope stops before creating credentials", async () => {
  for (const host of ["evil.example", "aws-0.example.com"]) {
    let writes = 0;
    const fetcher: typeof fetch = async (url, o) => {
      if (o?.method === "POST") writes++;
      return Response.json(
        String(url).endsWith("/pooler")
          ? [
              {
                database_type: "PRIMARY",
                db_host: host,
                db_port: 6543,
                db_user: `postgres.${ref}`,
                db_name: "postgres",
              },
            ]
          : { id: ref, organization_id: "org", status: "ACTIVE_HEALTHY" },
      );
    };
    await assert.rejects(() =>
      temporaryDatabaseSession("fixture", ref, "org", fetcher),
    );
    assert.equal(writes, 0);
  }
});
