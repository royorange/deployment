import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.ts";
import { authCallbacks } from "../src/auth-callbacks.ts";

const base = {
  version: 1 as const,
  project: "example",
  environments: ["staging"],
  variables: { appOrigin: "APP_ORIGIN" },
};
test("explicit callbacks are exact same-origin paths; legacy configuration remains compatible", () => {
  const config = validateConfig({
    ...base,
    setup: { auth: "supabase", authCallbacks: ["/auth/confirm"] },
  });
  assert.deepEqual(authCallbacks(config, "https://staging.example.com"), [
    "https://staging.example.com/auth/confirm",
  ]);
  assert.deepEqual(authCallbacks(base, "https://staging.example.com"), [
    "https://staging.example.com/**",
  ]);
});
test("callback declarations reject external, ambiguous, wildcard and duplicate paths", () => {
  for (const paths of [
    ["//evil.example"],
    ["https://evil.example"],
    ["/a/../b"],
    ["/auth?next=x"],
    ["/auth#x"],
    ["/**"],
    ["/%2f/evil"],
    ["/a", "/a"],
    [],
  ]) {
    assert.throws(() =>
      validateConfig({
        ...base,
        setup: { auth: "supabase", authCallbacks: paths },
      }),
    );
  }
});
