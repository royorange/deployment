import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKey, validateConfig } from "../src/config.ts";
import { modules, type Context } from "../src/wizard.ts";

const account = "a".repeat(32),
  zone = "b".repeat(32),
  token = "fixture-private-tunnel-management-token";
for (const denied of [false, true])
  for (const hasOrigin of [false, true])
    test(`dedicated Tunnel management token ${denied ? "rolls back on DNS denial" : "preserves official and CI credentials"}`, async () => {
      const logs: string[] = [];
      const profile = {
        cloudflareAccountId: account,
        cloudflareZoneId: zone,
        ...(hasOrigin ? { appOrigin: "https://app-staging.example.org" } : {}),
        "@cloudflareSource": "wrangler",
        "@cloudflareProfile": "work",
        "@cloudflareIdentity": "fixture@example.org",
        "@cloudflareDeploy": "cloudflare/ci",
      };
      const ctx: Context = {
        root: "/fixture",
        config: validateConfig({
          version: 1,
          project: "fixture",
          environments: ["staging"],
          variables: { cloudflareAccountId: "CF_ACCOUNT_ID" },
        }),
        env: "staging",
        storageMode: "vault",
        data: {
          credentials: { "cloudflare/ci": "fixture-ci-token" },
          profiles: { [projectKey("fixture", "staging")]: { ...profile } },
        },
        save: async () => {},
        runner: async () => "",
        ui: {
          select: async () => "new",
          input: async (_m, o) => (o?.secret ? token : (o?.value ?? "")),
          confirm: async () => true,
          check: async () => [],
          log: (m) => logs.push(m),
        },
        fetcher: async (url) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith(`/zones/${zone}`))
            return Response.json({
              success: true,
              result: {
                id: zone,
                name: "example.org",
                status: "active",
                account: { id: account },
              },
            });
          if (path.endsWith("/dns_records") && denied)
            return new Response("private-error-body", { status: 403 });
          return Response.json({ success: true, result: [] });
        },
      };
      const action = modules
        .find((m) => m.id === "deployment")!
        .actions.find((a) => a.id === "management-token")!;
      if (denied) {
        await assert.rejects(action.execute(ctx), /403/);
        assert.deepEqual(
          ctx.data.profiles[projectKey("fixture", "staging")],
          profile,
        );
        assert.deepEqual(ctx.data.credentials, {
          "cloudflare/ci": "fixture-ci-token",
        });
      } else {
        await action.execute(ctx);
        const saved = ctx.data.profiles[projectKey("fixture", "staging")]!;
        assert.deepEqual(
          { ...saved, "@cloudflareTunnelManagement": undefined },
          { ...profile, "@cloudflareTunnelManagement": undefined },
        );
        assert.equal(
          ctx.data.credentials[saved["@cloudflareTunnelManagement"]!],
          token,
        );
      }
      assert.ok(!logs.join("\n").includes(token));
      assert.ok(!logs.join("\n").includes("private-error-body"));
    });
