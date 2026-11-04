import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCompose } from "../src/remote-compose-config.ts";
test("Compose is normalized to JSON before remote parsing and keeps interpolation literal", () => {
  const value = JSON.parse(
    normalizeCompose("services:\n  app:\n    image: ${IMAGE}\n"),
  );
  assert.equal(value.services.app.image, "${IMAGE}");
});
test("Compose rejects external references and ambiguous YAML before any process execution", () => {
  for (const yaml of [
    "services: {app: {image: fixture, provider: {type: /bin/sh}}}",
    "services: {}\nmodels: {model: fixture}",
    "services: {app: {image: fixture, label_file: /outside}}",
    "include: ../outside.yml\nservices: {}",
    "services: {app: {extends: {file: ../outside.yml, service: outside}}}",
    "services: &a {app: {}}\nx-other: *a",
    "services: {}\nservices: {}",
    "services: !unsafe {}",
    "---\nservices: {}\n---\nservices: {}",
  ])
    assert.throws(() => normalizeCompose(yaml));
});
