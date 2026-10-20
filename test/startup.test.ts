import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStore, projectDirectory } from "../src/projects.ts";
import { prepareProject } from "../src/startup.ts";
import { validateConfig } from "../src/config.ts";
import type { UI } from "../src/wizard.ts";

const config = validateConfig({
  version: 1,
  project: "fixture",
  environments: ["staging"],
  variables: { appOrigin: "APP_ORIGIN" },
});
function ui(
  selects: string[] = [],
  inputs: string[] = [],
  logs: string[] = [],
): UI {
  return {
    select: async (message, choices) => {
      const value = selects.shift();
      assert.ok(
        choices.some((choice) => choice.value === value),
        `${message}: ${value}`,
      );
      return value!;
    },
    input: async (_message, options) => inputs.shift() ?? options?.value ?? "",
    confirm: async () => false,
    check: async () => [],
    log: (message) => logs.push(message),
  };
}
async function fixture(
  run: (home: string, root: string, base: string) => Promise<void>,
) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "setup-startup-")));
  try {
    const root = join(temp, "work", "zoncord");
    await mkdir(join(root, ".git"), { recursive: true });
    const home = join(temp, "home");
    await mkdir(home);
    await run(home, root, join(home, ".config"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("path labels remain readable but colliding slugs have different identities", () => {
  const first = projectDirectory("/settings", "/a/b-c");
  assert.match(first, /a-b-c-[a-f0-9]{16}$/);
  assert.notEqual(first, projectDirectory("/settings", "/a-b/c"));
});

test("registered mappings persist privately, strip unknown properties and verify their root", async () => {
  await fixture(async (_home, root, base) => {
    const store = new ProjectStore(base);
    await store.save(root, {
      ...config,
      credentials: "do-not-persist",
    } as typeof config);
    assert.equal((await store.read(root))?.config.project, "fixture");
    assert.deepEqual(
      (await store.list()).map((record) => record.root),
      [root],
    );
    const path = join(projectDirectory(base, root), "project.json");
    const contents = await readFile(path, "utf8");
    assert.ok(!contents.includes("do-not-persist"));
    await writeFile(path, contents.replace(root, `${root}-other`), {
      mode: 0o600,
    });
    await assert.rejects(store.read(root), /路径|匹配/);
  });
});

test("from a project subdirectory, initialize zoncord once and recover without long arguments", async () => {
  await fixture(async (home, root, base) => {
    const cwd = join(root, "docs");
    await mkdir(cwd);
    const result = await prepareProject({
      cwd,
      home,
      base,
      ui: ui(["current", "zoncord"]),
    });
    assert.equal(result.root, root);
    assert.equal(result.config.repository, "royorange/zoncord");
    assert.equal(result.config.jsonExport?.publicOrigin, "appOrigin");
    await assert.rejects(readFile(join(root, "infra.setup.json")), {
      code: "ENOENT",
    });
    const reopened = await prepareProject({
      cwd,
      home,
      base,
      ui: ui(["current"]),
    });
    assert.deepEqual(reopened.config, result.config);
  });
});

test("starting in home selects a saved project, including its canonical root", async () => {
  await fixture(async (home, root, base) => {
    await new ProjectStore(base).save(root, config);
    const result = await prepareProject({
      cwd: home,
      home,
      base,
      ui: ui([`saved:${root}`]),
    });
    assert.equal(result.root, root);
    assert.equal(result.config.project, "fixture");
  });
});

test("registered directories without Git are recognized from nested folders", async () => {
  await fixture(async (home, root, base) => {
    await rm(join(root, ".git"), { recursive: true });
    const cwd = join(root, "nested");
    await mkdir(cwd);
    await new ProjectStore(base).save(root, config);
    const result = await prepareProject({
      cwd,
      home,
      base,
      ui: ui(["current"]),
    });
    assert.equal(result.root, root);
    assert.deepEqual(result.config, config);
  });
});

test("broken registrations are reported without blocking other project choices", async () => {
  await fixture(async (home, root, base) => {
    await new ProjectStore(base).save(root, config);
    const broken = join(
      projectDirectory(base, join(home, "broken")),
      "project.json",
    );
    await mkdir(join(broken, ".."), { recursive: true });
    await writeFile(broken, "not json", { mode: 0o600 });
    const logs: string[] = [];
    const result = await prepareProject({
      cwd: home,
      home,
      base,
      ui: ui([`saved:${root}`], [], logs),
    });
    assert.equal(result.root, root);
    assert.ok(logs.some((message) => message.includes("已跳过")));
  });
});

test("explicit init creates a requested mapping file and refuses to replace it", async () => {
  await fixture(async (home, root, base) => {
    await prepareProject({
      cwd: root,
      home,
      base,
      root,
      manifest: "team.json",
      init: true,
      ui: ui(["zoncord"]),
    });
    assert.equal(
      JSON.parse(await readFile(join(root, "team.json"), "utf8")).project,
      "zoncord",
    );
    await assert.rejects(
      prepareProject({
        cwd: root,
        home,
        base,
        root,
        manifest: "team.json",
        init: true,
        ui: ui(),
      }),
      /已存在/,
    );
  });
});

test("the Fulcord launcher can select a different project interactively", async () => {
  await fixture(async (home, root, base) => {
    const launcher = join(home, "fulcord");
    await mkdir(join(launcher, ".git"), { recursive: true });
    await writeFile(join(launcher, "infra.setup.json"), JSON.stringify(config));
    const result = await prepareProject({
      cwd: launcher,
      home,
      base,
      ui: ui(["new", "zoncord"], [root]),
    });
    assert.equal(result.root, root);
    assert.equal(result.config.project, "zoncord");
  });
});

test("explicit config and repository mappings take precedence over saved copies", async () => {
  await fixture(async (home, root, base) => {
    await new ProjectStore(base).save(root, config);
    const local = { ...config, project: "local-project" };
    await writeFile(join(root, "infra.setup.json"), JSON.stringify(local));
    const found = await prepareProject({
      cwd: home,
      home,
      base,
      root,
      ui: ui(),
    });
    assert.equal(found.config.project, "local-project");
    const explicit = join(home, "custom.json");
    await writeFile(
      explicit,
      JSON.stringify({ ...config, project: "explicit-project" }),
    );
    const chosen = await prepareProject({
      cwd: home,
      home,
      base,
      root,
      manifest: explicit,
      ui: ui(),
    });
    assert.equal(chosen.config.project, "explicit-project");
    await assert.rejects(
      prepareProject({
        cwd: home,
        home,
        base,
        root,
        manifest: "missing.json",
        ui: ui(),
      }),
      /配置.*不存在/,
    );
  });
});

test("first use in home prompts for a project directory and can generate a generic mapping", async () => {
  await fixture(async (home, root, base) => {
    const result = await prepareProject({
      cwd: home,
      home,
      base,
      ui: ui(
        ["new", "generic"],
        [root, "custom-project", "example/custom-project"],
      ),
    });
    assert.equal(result.root, root);
    assert.equal(result.config.project, "custom-project");
    assert.equal(result.config.repository, "example/custom-project");
  });
});

test("an explicit config without --root retains cwd-relative paths and its original project root", async () => {
  await fixture(async (home, root, base) => {
    const cwd = join(root, "scripts");
    await mkdir(cwd);
    await writeFile(join(cwd, "team.json"), JSON.stringify(config));
    await writeFile(
      join(root, "team.json"),
      JSON.stringify({ ...config, project: "wrong-project" }),
    );
    const result = await prepareProject({
      cwd,
      home,
      base,
      manifest: "team.json",
      ui: ui(),
    });
    assert.equal(result.root, cwd);
    assert.equal(result.config.project, "fixture");
  });
});

test("memory initialization writes no mapping, and explicit init never overwrites existing mappings", async () => {
  await fixture(async (home, root, base) => {
    await prepareProject({
      cwd: root,
      home,
      base,
      memory: true,
      ui: ui(["current", "zoncord"]),
    });
    assert.deepEqual(await new ProjectStore(base).list(), []);
    await writeFile(join(root, "infra.setup.json"), JSON.stringify(config));
    await assert.rejects(
      prepareProject({ cwd: root, home, base, root, init: true, ui: ui() }),
      /已存在/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "infra.setup.json"), "utf8")),
      config,
    );
  });
});

test("importing a mapping saves a snapshot so moving the source does not break startup", async () => {
  await fixture(async (home, root, base) => {
    const source = join(home, "source.json");
    await writeFile(source, JSON.stringify(config));
    await prepareProject({
      cwd: root,
      home,
      base,
      ui: ui(["current", "import"], [source]),
    });
    await rm(source);
    const result = await prepareProject({
      cwd: root,
      home,
      base,
      ui: ui(["current"]),
    });
    assert.deepEqual(result.config, config);
  });
});

test("invalid directories and corrupt or symlinked mappings do not trigger a fallback", async () => {
  await fixture(async (home, root, base) => {
    await assert.rejects(
      prepareProject({
        cwd: home,
        home,
        base,
        root: join(root, "missing"),
        ui: ui(),
      }),
      /项目目录/,
    );
    await writeFile(join(root, "infra.setup.json"), "bad json");
    await assert.rejects(
      prepareProject({ cwd: root, home, base, root, ui: ui() }),
      /JSON/,
    );
    await rm(join(root, "infra.setup.json"));
    const source = join(home, "source.json");
    await writeFile(source, JSON.stringify(config));
    await symlink(source, join(root, "infra.setup.json"));
    await assert.rejects(
      prepareProject({ cwd: root, home, base, root, ui: ui() }),
      /符号链接/,
    );
  });
});

test("unsafe permissions on saved records are rejected and cancellation leaves no record", async () => {
  await fixture(async (home, root, base) => {
    await assert.rejects(
      prepareProject({
        cwd: root,
        home,
        base,
        ui: {
          ...ui(["current"]),
          select: async (message, choices) => {
            if (message.includes("项目")) return choices[0]!.value;
            throw new Error("cancelled");
          },
          input: async () => {
            throw new Error("cancelled");
          },
        },
      }),
      /cancelled/,
    );
    assert.deepEqual(await new ProjectStore(base).list(), []);
    await new ProjectStore(base).save(root, config);
    if (process.platform !== "win32") {
      await chmod(join(projectDirectory(base, root), "project.json"), 0o644);
      await assert.rejects(new ProjectStore(base).read(root), /权限/);
    }
  });
});

test("new AWS template asks auth and configures no credentials or predicted endpoints", async () => {
  await fixture(async (home, root, base) => {
    const { config: generated } = await prepareProject({
      cwd: root,
      home,
      base,
      ui: ui(
        ["current", "aws-tunnel", "supabase"],
        ["new-service", "example/new-service"],
      ),
    });
    assert.equal(generated.project, "new-service");
    assert.equal(generated.repository, "example/new-service");
    assert.equal(generated.deploymentTopology, "aws-tunnel");
    assert.equal(generated.migrationStrategy, "supabase-cli");
    assert.equal(generated.setup?.auth, "supabase");
    assert.equal(generated.variables.workerName, undefined);
    assert.equal(generated.variables.cloudflareTunnelToken, "CF_TUNNEL_TOKEN");
    assert.equal(generated.defaults?.staging?.deploymentTarget, "staging");
    assert.ok(!JSON.stringify(generated.defaults).includes("https://"));
    assert.ok(!generated.defaults?.staging?.cloudflareAccountId);
    const restored = await prepareProject({
      cwd: root,
      home,
      base,
      ui: ui(["current"]),
    });
    assert.deepEqual(restored.config, generated);
  });
});

test("separate components template keeps frontend, admin and API settings independent", async () => {
  await fixture(async (home, root, base) => {
    const { config: generated } = await prepareProject({
      cwd: root,
      home,
      base,
      ui: ui(
        ["current", "separate-components", "firebase"],
        ["multi-service", ""],
      ),
    });
    assert.equal(generated.repository, undefined);
    assert.equal(generated.deploymentTopology, undefined);
    assert.equal(generated.migrationStrategy, "project-managed");
    assert.equal(generated.setup?.auth, "firebase");
    const components = generated.setup?.components;
    assert.equal(components?.length, 3);
    assert.deepEqual(
      components?.map((item) => item.id),
      ["web", "admin", "api"],
    );
    assert.equal(components?.[0]?.originField, "appOrigin");
    assert.equal(components?.[1]?.originField, "adminOrigin");
    assert.equal(components?.[0]?.projectField, "pagesProject");
    assert.equal(components?.[1]?.projectField, "adminPagesProject");
    assert.equal(components?.[0]?.branchField, "frontendBranch");
    assert.equal(components?.[1]?.branchField, "adminBranch");
    assert.equal(components?.[2]?.hosting, "external");
    assert.ok(components?.[2]?.instructions?.includes("项目已有"));
    assert.equal(generated.variables.cloudflareTunnelToken, undefined);
    assert.ok(!/https:\/\/[^" ]+\.pages\.dev/.test(JSON.stringify(generated)));
    assert.ok(!generated.defaults?.staging?.frontendBranch);
    assert.ok(
      generated.setup?.requirements?.some(
        (item) => item.id === "database-role",
      ),
    );
    assert.ok(
      !generated.setup?.requirements?.some((item) =>
        ["payments", "ai", "push"].includes(item.id),
      ),
    );
  });
});

test("new templates permit explicit external or no authentication and reject unknown auth", async () => {
  await fixture(async (home, root, base) => {
    for (const auth of ["external", "none"]) {
      const result = await prepareProject({
        cwd: root,
        home,
        base,
        memory: true,
        ui: ui(["current", "separate-components", auth], ["new-service", ""]),
      });
      assert.equal(result.config.setup?.auth, auth);
    }
    await assert.rejects(
      prepareProject({
        cwd: root,
        home,
        base,
        memory: true,
        ui: {
          ...ui(["current", "aws-tunnel"], ["new-service", ""]),
          select: async (message, choices) => {
            if (message.includes("认证")) return "invalid-auth";
            return message.includes("配置来源")
              ? "aws-tunnel"
              : choices[0]!.value;
          },
        },
      }),
      /认证/,
    );
  });
});
