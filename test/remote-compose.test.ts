import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployRemoteCompose,
  inspectRemoteCompose,
  remoteReleaseDirectory,
  remoteComposeScript,
  type RemoteComposeInput,
} from "../src/remote-compose.ts";

const revision = "a".repeat(40);
const image = `ghcr.io/example/app@sha256:${"b".repeat(64)}`;
const input: RemoteComposeInput = {
  device: {
    id: "fixture",
    label: "Fixture",
    host: "host.example",
    user: "deploy",
    port: 22,
  },
  project: "example",
  environment: "staging",
  remoteDirectory: "/opt/example/staging",
  revision,
  composeYaml: "services:\n  app:\n    image: ${APP_IMAGE}\n",
  publicEnv: { APP_IMAGE: image },
  imageDigests: { app: image },
  privateFiles: {
    "runtime.env": {
      content: "TOKEN=synthetic-secret\n",
      uid: 0,
      mode: "0600",
    },
  },
  expectedServices: ["app"],
  healthService: "app",
};

test("remote Compose rejects invalid scope, unpinned images and unsafe runtime paths before SSH", async () => {
  assert.equal(
    remoteReleaseDirectory(input),
    `/opt/example/staging/releases/${revision}`,
  );
  for (const patch of [
    { remoteDirectory: "/opt/other/staging" },
    { project: "../other" },
    { revision: "main" },
    { imageDigests: { app: "image:latest" } },
    {
      privateFiles: {
        "../escape": { content: "synthetic", uid: 0, mode: "0600" },
      },
    },
    { publicEnv: { PATH: "/untrusted" } },
    { expectedServices: ["app", "app"] },
  ]) {
    let called = false;
    await assert.rejects(
      deployRemoteCompose({ ...input, ...patch } as RemoteComposeInput, {
        runner: async () => {
          called = true;
          return "";
        },
      }),
      /配置/,
    );
    assert.equal(called, false);
  }
});

test("remote Compose uses strict SSH and private stdin, never arguments or ambient provider credentials", async () => {
  let script = "";
  const receipt = await deployRemoteCompose(input, {
    runner: async (command, args, options) => {
      assert.equal(command, "ssh");
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.ok(args.includes("ForwardAgent=no"));
      assert.ok(!args.join(" ").includes("synthetic-secret"));
      assert.equal(args.at(-1), "sudo -n python3 -");
      assert.equal(options?.env?.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(options?.captureStderr, false);
      script = options?.input ?? "";
      return JSON.stringify({
        version: 1,
        state: "deployed",
        revision,
        previous: null,
      });
    },
  });
  assert.equal(receipt.state, "deployed");
  assert.ok(script.includes("import base64"));
  assert.ok(!JSON.stringify(receipt).includes("synthetic-secret"));
});

test("inspection accepts only public scope, validates responses and suppresses raw command errors", async () => {
  const scope = {
    device: input.device,
    project: input.project,
    environment: input.environment,
    remoteDirectory: input.remoteDirectory,
  };
  const result = await inspectRemoteCompose(scope, {
    runner: async () =>
      JSON.stringify({
        version: 1,
        state: "absent",
        revision: null,
        previous: null,
      }),
  });
  assert.equal(result.state, "absent");
  await assert.rejects(
    deployRemoteCompose(input, {
      runner: async () => {
        throw new Error("synthetic-secret");
      },
    }),
    (error: Error) => !error.message.includes("synthetic-secret"),
  );
  await assert.rejects(
    inspectRemoteCompose(scope, {
      runner: async () =>
        JSON.stringify({
          version: 1,
          state: "absent",
          revision: null,
          previous: null,
          token: "synthetic-secret",
        }),
    }),
    /核验/,
  );
});

test("remote script carries fixed controller and separates payload without shell interpolation", () => {
  const script = remoteComposeScript(input, "deploy");
  assert.ok(!script.includes("TOKEN=synthetic-secret"));
  assert.ok(script.includes("subprocess.run"));
  assert.ok(script.includes('input=b""'));
});

test("explicit recovery carries only expected public versions and verifies the restored result", async () => {
  const { recoverRemoteCompose } = await import("../src/remote-compose.ts");
  const old = "d".repeat(40);
  let payload: Record<string, unknown> | undefined;
  const scope = {
    device: input.device,
    project: input.project,
    environment: input.environment,
    remoteDirectory: input.remoteDirectory,
    expectedCurrentRevision: revision,
    targetRevision: old,
  };
  const receipt = await recoverRemoteCompose(scope, {
    runner: async (_cmd, _args, o) => {
      const encoded = o?.input?.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
      payload = JSON.parse(Buffer.from(encoded!, "base64").toString());
      return JSON.stringify({
        version: 1,
        state: "deployed",
        revision: old,
        previous: revision,
      });
    },
  });
  assert.equal(receipt.revision, old);
  assert.equal(payload?.action, "recover");
  assert.equal(payload?.privateFiles, undefined);
  await assert.rejects(() =>
    recoverRemoteCompose({ ...scope, targetRevision: revision }),
  );
});
