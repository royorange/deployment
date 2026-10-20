import assert from "node:assert/strict";
import { test } from "node:test";
import { Cloudflare, Supabase, Api, supabaseHealth } from "../src/providers.ts";
import { githubSync, type Runner } from "../src/process.ts";

test("Cloudflare only offers Pages creation after a real 404, and never leaks error bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const cf = new Cloudflare("sensitive-token", async () => {
      calls++;
      return new Response(
        JSON.stringify({ errors: [{ message: "sensitive-token" }] }),
        { status },
      );
    });
    await assert.rejects(
      cf.pagesProject("a".repeat(32), "example"),
      (e: Error) =>
        !e.message.includes("sensitive-token") &&
        e.message.includes(String(status)),
    );
    assert.equal(calls, 1);
  }
  const cf = new Cloudflare(
    "test",
    async () => new Response("{}", { status: 404 }),
  );
  assert.equal(await cf.pagesProject("a".repeat(32), "example"), null);
});

test("provider requests pin host, reject redirects, and bound pagination", async () => {
  const api = new Api(
    "https://api.cloudflare.com/client/v4",
    "test",
    async (url, init) => {
      assert.equal(new URL(String(url)).host, "api.cloudflare.com");
      assert.equal(init?.redirect, "error");
      return Response.json({ success: true, result: [] });
    },
  );
  await assert.rejects(api.request("//attacker.example"), /路径/);
  await assert.rejects(api.request("https://attacker.example"), /路径/);
  await api.request("/accounts");
  let pages = 0;
  const cf = new Cloudflare("fixture", async () => {
    pages++;
    return Response.json({
      success: true,
      result: [],
      result_info: { total_pages: 21 },
    });
  });
  await assert.rejects(cf.accounts(), /分页超过限制/);
  assert.equal(pages, 20);
});

test("Supabase gateway quota errors are distinguished from an ACTIVE_HEALTHY management status", async () => {
  await assert.rejects(
    supabaseHealth("a".repeat(20), "sb_publishable_test", async (url, init) => {
      assert.equal(
        String(url),
        `https://${"a".repeat(20)}.supabase.co/auth/v1/health`,
      );
      assert.equal(init?.redirect, "error");
      return new Response("do not echo", { status: 402 });
    }),
    /402.*额度/,
  );
});

test("Supabase retrieves only publishable credentials, never exports service-role/secret keys", async () => {
  const sb = new Supabase("management-test", async () =>
    Response.json([
      { name: "service_role", api_key: "service-sensitive", type: "legacy" },
      { name: "secret", api_key: "sb_secret_sensitive", type: "secret" },
      {
        name: "default",
        api_key: "sb_publishable_public",
        type: "publishable",
      },
    ]),
  );
  assert.equal(
    await sb.publishableKey("a".repeat(20)),
    "sb_publishable_public",
  );
});

test("GitHub uses stdin for values, correct environment and reports partial writes without exposing values", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: Runner = async (_command, args, options) => {
    calls.push({ args, input: options?.input });
    if (args.includes("BROKEN")) throw new Error("sensitive-token");
    return "";
  };
  await assert.rejects(
    githubSync(
      "royorange/fulcord",
      "staging",
      [
        {
          field: "cloudflareToken",
          name: "TOKEN",
          value: "sensitive-token",
          secret: true,
        },
        {
          field: "appOrigin",
          name: "BROKEN",
          value: "https://test.example",
          secret: false,
        },
      ],
      runner,
    ),
    (e: Error) =>
      e.message.includes("TOKEN") && !e.message.includes("sensitive-token"),
  );
  assert.ok(calls[0]?.args.includes("staging"));
  assert.ok(!calls[0]?.args.includes("sensitive-token"));
  assert.equal(calls[0]?.input, "sensitive-token");
});
