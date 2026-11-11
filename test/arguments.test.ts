import assert from "node:assert/strict";
import { test } from "node:test";
import { argumentsFor } from "../src/arguments.ts";

test("encrypted storage is the default and the old vault flag stays compatible", () => {
  assert.equal(argumentsFor([]).mode, "vault");
  assert.equal(argumentsFor([]).memory, false);
  assert.equal(argumentsFor(["--vault"]).mode, "vault");
  assert.equal(argumentsFor(["--no-vault"]).mode, "metadata");
  assert.equal(argumentsFor(["--memory"]).mode, "memory");
  assert.equal(argumentsFor(["--memory"]).memory, true);
});

test("explicit storage modes cannot silently override one another", () => {
  for (const flags of [
    ["--memory", "--vault"],
    ["--vault", "--memory"],
    ["--no-vault", "--vault"],
    ["--vault", "--no-vault"],
    ["--no-vault", "--memory"],
    ["--memory", "--no-vault"],
  ])
    assert.throws(() => argumentsFor(flags), /不能同时使用/);
});

test("help, doctor and project arguments retain their validation", () => {
  assert.equal(argumentsFor(["--help"]).help, true);
  assert.equal(argumentsFor(["-h"]).help, true);
  assert.equal(argumentsFor(["--doctor"]).doctor, true);
  assert.equal(argumentsFor(["--init"]).init, true);
  const args = argumentsFor(["--root", "/fixture", "--config", "infra.json"]);
  assert.equal(args.root, "/fixture");
  assert.equal(args.manifest, "infra.json");
  assert.throws(() => argumentsFor(["--root"]), /缺少路径/);
  assert.throws(() => argumentsFor(["--config", "--memory"]), /缺少路径/);
  assert.throws(() => argumentsFor(["--token", "synthetic"]), /未知参数/);
});
