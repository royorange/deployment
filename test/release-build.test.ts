import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runLocalBuild } from "../src/release-build.ts";
import { run } from "../src/process.ts";
import { values, type Context } from "../src/wizard.ts";

const sha = "a".repeat(40);
const image = `ghcr.io/owner/fixture@sha256:${"b".repeat(64)}`;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-build-")));
  await mkdir(join(root, "deploy"));
  await writeFile(
    join(root, "deploy/build.mts"),
    "// synthetic build adapter\n",
  );
  const calls: Array<{
    cmd: string;
    args: string[];
    input?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  const logs: string[] = [];
  let saved = 0;
  const ctx: Context = {
    root,
    env: "staging",
    config: {
      version: 1,
      project: "fixture",
      repository: "owner/fixture",
      environments: ["staging"],
      variables: {
        appOrigin: "APP_ORIGIN",
        deploymentImage: "IMAGE",
        supabasePublishableKey: "PUBLISHABLE",
      },
      release: {
        adapter: "deploy/release.mts",
        ciWorkflow: "ci.yml",
        environments: ["staging"],
        publicFields: ["appOrigin", "deploymentImage"],
        localBuild: {
          adapter: "deploy/build.mts",
          environments: ["staging"],
          outputFields: ["deploymentImage"],
        },
        components: [
          {
            id: "application",
            label: "App",
            kind: "application",
            requiresDevice: false,
            migrations: "none",
          },
        ],
      },
    },
    data: {
      credentials: { fixture: "private-synthetic-token" },
      profiles: {
        '["fixture","staging"]': {
          appOrigin: "https://app.example.com",
          supabasePublishableKey: "sb_publishable_fixture",
        },
      },
    },
    storageMode: "memory",
    save: async () => {
      saved++;
    },
    ui: {
      select: async () => "",
      input: async () => "",
      check: async () => [],
      confirm: async () => true,
      log: (line) => logs.push(line),
    },
    runner: async (cmd, args, options) => {
      calls.push({ cmd, args, input: options?.input, env: options?.env });
      if (cmd === "git") {
        if (args.includes("status")) return "";
        if (args.includes("get-url")) return "git@github.com:owner/fixture.git";
        if (args.includes("rev-parse")) return sha;
        if (args.includes("-v")) return "H deploy/build.mts\0";
        return "deploy/build.mts";
      }
      assert.equal(cmd, process.execPath);
      return JSON.stringify({
        version: 1,
        project: "fixture",
        environment: "staging",
        repository: "owner/fixture",
        sourceCommit: sha,
        ready: true,
        summary: ["build synthetic artifact"],
        missing: [],
        effects: ["may push image; does not deploy"],
        outputs: args.at(-1) === "build" ? { deploymentImage: image } : {},
      });
    },
  };
  return {
    ctx,
    calls,
    logs,
    saved: () => saved,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("local build uses trusted plan/build, freezes public input, excludes secrets and never claims CI", async () => {
  const f = await fixture();
  const previous = process.env.SUPABASE_ACCESS_TOKEN;
  process.env.SUPABASE_ACCESS_TOKEN = "environment-secret";
  try {
    const receipt = await runLocalBuild(f.ctx);
    assert.equal(receipt.state, "adopted");
    assert.equal(receipt.provider, "local");
    assert.equal(receipt.sourceCommit, sha);
    assert.deepEqual(receipt.outputs, { deploymentImage: image });
    assert.equal(values(f.ctx).deploymentImage, image);
    assert.equal(f.saved(), 1);
    assert.ok(!("ciRunId" in receipt));
    assert.ok(!f.calls.some((call) => call.cmd === "gh"));
    const adapters = f.calls.filter((call) => call.cmd === process.execPath);
    assert.deepEqual(
      adapters.map((call) => call.args.at(-1)),
      ["plan", "build"],
    );
    assert.equal(adapters[0]!.input, adapters[1]!.input);
    assert.deepEqual(JSON.parse(adapters[0]!.input!), {
      version: 1,
      project: "fixture",
      environment: "staging",
      repository: "owner/fixture",
      sourceCommit: sha,
      publicValues: { appOrigin: "https://app.example.com" },
    });
    assert.ok(
      adapters.every(
        (call) =>
          !call.input!.includes("private-synthetic-token") &&
          !call.input!.includes("sb_publishable_fixture"),
      ),
    );
    assert.ok(
      adapters.every((call) => !("SUPABASE_ACCESS_TOKEN" in call.env!)),
    );
    assert.ok(f.logs.some((line) => line.includes("不代表 CI")));
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
    else process.env.SUPABASE_ACCESS_TOKEN = previous;
    await f.close();
  }
});

test("declining trust, execution or adoption cannot silently change values", async () => {
  for (const refused of [1, 2, 3]) {
    const f = await fixture();
    let confirms = 0;
    try {
      f.ctx.ui.confirm = async () => ++confirms !== refused;
      const receipt = await runLocalBuild(f.ctx);
      assert.equal(receipt.state, refused === 3 ? "built" : "cancelled");
      assert.equal(values(f.ctx).deploymentImage, undefined);
      assert.equal(f.saved(), 0);
      assert.equal(
        f.calls.filter((call) => call.cmd === process.execPath).length,
        refused - 1,
      );
    } finally {
      await f.close();
    }
  }
});

test("build output rejects mismatched source/environment, unknown fields, secrets and invalid image digest", async () => {
  for (const mutation of [
    { sourceCommit: "c".repeat(40) },
    { environment: "production" },
    { repository: "other/repository" },
    { project: "other" },
    { outputs: { deploymentImage: "ghcr.io/owner/fixture:latest" } },
    { outputs: { supabasePublishableKey: "sb_publishable_hidden" } },
    { outputs: { unrecognized: "anything" } },
    { outputs: {} },
    { arbitrary: "extra" },
  ]) {
    const f = await fixture();
    try {
      const original = f.ctx.runner;
      f.ctx.runner = async (cmd, args, options) => {
        const output = await original(cmd, args, options);
        return cmd === process.execPath && args.at(-1) === "build"
          ? JSON.stringify({ ...JSON.parse(output), ...mutation })
          : output;
      };
      assert.equal((await runLocalBuild(f.ctx)).state, "failed");
      assert.equal(values(f.ctx).deploymentImage, undefined);
      assert.equal(f.saved(), 0);
    } finally {
      await f.close();
    }
  }
});

test("plan cannot return adoptable outputs or execute build after missing prerequisites", async () => {
  for (const mutation of [
    { outputs: { deploymentImage: image } },
    { ready: false, missing: ["builder unavailable"] },
  ]) {
    const f = await fixture();
    try {
      const original = f.ctx.runner;
      f.ctx.runner = async (cmd, args, options) => {
        const output = await original(cmd, args, options);
        return cmd === process.execPath
          ? JSON.stringify({ ...JSON.parse(output), ...mutation })
          : output;
      };
      assert.equal((await runLocalBuild(f.ctx)).state, "failed");
      assert.equal(
        f.calls.filter((call) => call.cmd === process.execPath).length,
        1,
      );
      assert.equal(f.saved(), 0);
    } finally {
      await f.close();
    }
  }
});

test("changed source after build rejects outputs and does not save", async () => {
  const f = await fixture();
  let built = false;
  try {
    const original = f.ctx.runner;
    f.ctx.runner = async (cmd, args, options) => {
      const output = await original(cmd, args, options);
      if (cmd === process.execPath && args.at(-1) === "build") built = true;
      return cmd === "git" && args.includes("rev-parse") && built
        ? "c".repeat(40)
        : output;
    };
    assert.equal((await runLocalBuild(f.ctx)).state, "failed");
    assert.equal(f.saved(), 0);
  } finally {
    await f.close();
  }
});

test("changed build target/configuration during confirmation cannot build or overwrite", async () => {
  for (const point of [2, 3]) {
    const f = await fixture();
    let confirms = 0;
    try {
      f.ctx.ui.confirm = async () => {
        if (++confirms === point)
          values(f.ctx).appOrigin = "https://changed.example.com";
        return true;
      };
      assert.equal((await runLocalBuild(f.ctx)).state, "failed");
      assert.equal(f.saved(), 0);
      assert.equal(values(f.ctx).deploymentImage, undefined);
    } finally {
      await f.close();
    }
  }
});

test("save failure restores output fields without altering other configuration", async () => {
  const f = await fixture();
  try {
    const oldImage = `ghcr.io/owner/fixture@sha256:${"d".repeat(64)}`;
    values(f.ctx).deploymentImage = oldImage;
    f.ctx.save = async () => {
      throw new Error("synthetic failure private-synthetic-token");
    };
    assert.equal((await runLocalBuild(f.ctx)).state, "failed");
    assert.equal(values(f.ctx).deploymentImage, oldImage);
    assert.equal(values(f.ctx).appOrigin, "https://app.example.com");
    assert.ok(!f.logs.join(" ").includes("private-synthetic-token"));
  } finally {
    await f.close();
  }
});

test("untracked or symlinked build adapters cannot run", async () => {
  for (const mode of ["untracked", "symlink"]) {
    const f = await fixture();
    try {
      if (mode === "symlink") {
        await rm(join(f.ctx.root, "deploy/build.mts"));
        await writeFile(join(f.ctx.root, "outside.mts"), "// fixture");
        await symlink(
          join(f.ctx.root, "outside.mts"),
          join(f.ctx.root, "deploy/build.mts"),
        );
      } else {
        const original = f.ctx.runner;
        f.ctx.runner = async (cmd, args, options) =>
          args.includes("--error-unmatch") ? "" : original(cmd, args, options);
      }
      assert.equal((await runLocalBuild(f.ctx)).state, "failed");
      assert.ok(!f.calls.some((call) => call.cmd === process.execPath));
    } finally {
      await f.close();
    }
  }
});

test("unsupported environments and malformed protocol never run or expose raw adapter output", async () => {
  const f = await fixture();
  try {
    f.ctx.env = "production";
    assert.equal((await runLocalBuild(f.ctx)).state, "failed");
    assert.equal(f.calls.length, 0);
    f.ctx.env = "staging";
    const original = f.ctx.runner;
    f.ctx.runner = async (cmd, args, options) =>
      cmd === process.execPath
        ? "private-synthetic-token not JSON"
        : original(cmd, args, options);
    assert.equal((await runLocalBuild(f.ctx)).state, "failed");
    assert.ok(!f.logs.join(" ").includes("private-synthetic-token"));
  } finally {
    await f.close();
  }
});

test("real committed adapter runs through stdin and returns adopted immutable output", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.ctx.root, "deploy/build.mts"),
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const request = JSON.parse(readFileSync(0, "utf8"));',
        'if (request.runtimeValues || request.credentials || process.env.SUPABASE_ACCESS_TOKEN) throw new Error("unexpected credentials");',
        'const build = process.argv.at(-1) === "build";',
        'if (build) writeFileSync("synthetic-build.txt", "synthetic artifact");',
        `process.stdout.write(JSON.stringify({version:1, project:request.project, environment:request.environment, repository:request.repository, sourceCommit:request.sourceCommit, ready:true, summary:[], missing:[], effects:[], outputs:build ? {deploymentImage:${JSON.stringify(image)}} : {}}));`,
      ].join("\n"),
    );
    await writeFile(join(f.ctx.root, ".gitignore"), "synthetic-build.txt\n");
    const git = (args: string[]) => run("git", args, { cwd: f.ctx.root });
    await git(["init", "--quiet"]);
    await git([
      "remote",
      "add",
      "origin",
      "https://github.com/owner/fixture.git",
    ]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "test: synthetic build adapter",
    ]);
    const committed = (await git(["rev-parse", "HEAD"])).trim();
    f.ctx.runner = run;
    const receipt = await runLocalBuild(f.ctx);
    assert.equal(receipt.state, "adopted", f.logs.join("\n"));
    assert.equal(receipt.sourceCommit, committed);
    assert.equal(values(f.ctx).deploymentImage, image);
    assert.equal((await git(["status", "--porcelain"])).trim(), "");
  } finally {
    await f.close();
  }
});

test("prompt cancellation propagates and does not adopt output", async () => {
  const f = await fixture();
  try {
    f.ctx.ui.confirm = async () => {
      const error = new Error("cancelled");
      error.name = "ExitPromptError";
      throw error;
    };
    await assert.rejects(runLocalBuild(f.ctx), { name: "ExitPromptError" });
    assert.equal(f.saved(), 0);
  } finally {
    await f.close();
  }
});

test("failed build reports redacted details and cannot adopt a partial artifact", async () => {
  const f = await fixture();
  try {
    const original = f.ctx.runner;
    f.ctx.runner = async (cmd, args, options) => {
      if (cmd === process.execPath && args.at(-1) === "build")
        throw new Error("timeout private-synthetic-token");
      return original(cmd, args, options);
    };
    const result = await runLocalBuild(f.ctx);
    assert.equal(result.state, "failed");
    assert.deepEqual(result.outputs, {});
    assert.equal(f.saved(), 0);
    assert.ok(f.logs.some((line) => line.includes("timeout")));
    assert.ok(!f.logs.join(" ").includes("private-synthetic-token"));
  } finally {
    await f.close();
  }
});

test("unsafe output declarations are rejected before trusting or invoking project code", async () => {
  for (const fields of [
    [],
    ["deploymentImage", "deploymentImage"],
    ["supabasePublishableKey"],
    ["unknown"],
    ["siteOrigin"],
  ]) {
    const f = await fixture();
    try {
      f.ctx.config.release!.localBuild!.outputFields = fields;
      const receipt = await runLocalBuild(f.ctx);
      assert.equal(receipt.state, "failed");
      assert.equal(f.calls.length, 0);
      assert.equal(f.saved(), 0);
    } finally {
      await f.close();
    }
  }
});
