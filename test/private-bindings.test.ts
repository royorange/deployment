import assert from "node:assert/strict";
import test from "node:test";
import { guideStageBindings } from "../src/deployment-guide-bindings.ts";
import { fixture } from "./guide-fixture.ts";
import { values } from "../src/wizard.ts";
test("private target and exact callbacks invalidate their own evidence", async () => {
  const f = await fixture([], true);
  try {
    const base = guideStageBindings(
      f.ctx.config,
      values(f.ctx),
      undefined,
      undefined,
      {},
    );
    values(f.ctx).privateOrigin = "https://private.example.test";
    const moved = guideStageBindings(
      f.ctx.config,
      values(f.ctx),
      undefined,
      undefined,
      {},
    );
    assert.notEqual(moved.tunnel, base.tunnel);
    assert.notEqual(moved.configuration, base.configuration);
    assert.equal(moved.supabase, base.supabase);
    f.ctx.config.setup!.authCallbacks = ["/auth/confirm"];
    const callbacks = guideStageBindings(
      f.ctx.config,
      values(f.ctx),
      undefined,
      undefined,
      {},
    );
    assert.notEqual(callbacks.auth, moved.auth);
    assert.equal(callbacks.supabase, moved.supabase);
  } finally {
    await f.cleanup();
  }
});
