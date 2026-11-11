import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import {
  compatibleSupabaseVersion,
  ensureSupabaseCli,
  inspectSupabaseCli,
  installSupabaseRelease,
} from "../src/managed-cli.ts";
import { supabaseRelease } from "../src/supabase-release.ts";
import type { Runner } from "../src/process.ts";

const unavailable: Runner = async () => {
  throw new Error("missing");
};
const yes = { log() {}, confirm: async () => true };
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function member(name: string, kind: string, contents: Buffer) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000700\0", 100);
  header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write(kind, 156);
  header.write("ustar\0", 257);
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([
    header,
    contents,
    Buffer.alloc((512 - (contents.length % 512)) % 512),
  ]);
}
function archive(
  name = "supabase",
  kind = "0",
  contents = Buffer.from("binary"),
) {
  return gzipSync(
    Buffer.concat([
      member(name, kind, contents),
      member("supabase-go", "0", Buffer.from("go binary")),
      Buffer.alloc(1024),
    ]),
  );
}
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "managed-cli-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}
function release(bytes: Buffer) {
  return { ...supabaseRelease("darwin", "arm64")!, sha256: digest(bytes) };
}
const fetchBytes =
  (bytes: Buffer): typeof fetch =>
  async () =>
    new Response(new Uint8Array(bytes).buffer);

test("version check accepts supported stable CLI only", () => {
  for (const version of ["2.120.0", "2.121.1", "3.0.0"])
    assert.equal(compatibleSupabaseVersion(version), true);
  for (const version of [
    "2.119.9",
    "1.200.0",
    "2.120.0-beta.1",
    "latest",
    "2.120.0 extra",
  ])
    assert.equal(compatibleSupabaseVersion(version), false);
});
test("compatible existing CLI is reused without downloading or prompting", async () => {
  const runner: Runner = async (command, args) => {
    assert.equal(command, "supabase");
    assert.deepEqual(args, ["--version"]);
    return "2.120.0\n";
  };
  assert.equal(
    await ensureSupabaseCli({
      runner,
      ui: {
        ...yes,
        confirm: async () => {
          throw new Error("unexpected");
        },
      },
    }),
    "supabase",
  );
});
test("absent CLI exposes fixed official install information and can cancel", async (t) => {
  const base = await fixture(t);
  const state = await inspectSupabaseCli({
    base,
    runner: unavailable,
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(state.kind, "install");
  assert.equal(state.release?.version, "2.120.0");
  assert.match(
    state.release!.url,
    /^https:\/\/github.com\/supabase\/cli\/releases\/download\/v2\.120\.0\//,
  );
  let fetched = false;
  assert.equal(
    await ensureSupabaseCli({
      base,
      runner: unavailable,
      ui: { ...yes, confirm: async () => false },
      fetcher: async () => {
        fetched = true;
        throw new Error("no");
      },
    }),
    undefined,
  );
  assert.equal(fetched, false);
});
test("unsupported host explains manual installation", async (t) => {
  const logs: string[] = [];
  assert.equal(
    await ensureSupabaseCli({
      base: await fixture(t),
      runner: unavailable,
      ui: { ...yes, log: (value) => logs.push(value) },
      platform: "freebsd",
      arch: "x64",
    }),
    undefined,
  );
  assert.match(logs.join(""), /官方|支持/);
});
test("installer atomically installs verified bytes and revalidates cache", async (t) => {
  const base = await fixture(t),
    bytes = archive(),
    fixed = release(bytes);
  let downloads = 0;
  const fetcher: typeof fetch = async () => {
    downloads++;
    return new Response(new Uint8Array(bytes).buffer);
  };
  const path = await installSupabaseRelease({ base, release: fixed, fetcher });
  assert.equal((await readFile(path)).toString(), "binary");
  assert.equal(
    (await readFile(join(path, "..", "supabase-go"))).toString(),
    "go binary",
  );
  assert.equal(
    await installSupabaseRelease({ base, release: fixed, fetcher }),
    path,
  );
  assert.equal(downloads, 1);
  await writeFile(path, "tampered");
  await assert.rejects(
    installSupabaseRelease({ base, release: fixed, fetcher }),
    /完整性|校验/,
  );
});
test("installer rejects checksum mismatch before extraction", async (t) => {
  const bytes = archive();
  await assert.rejects(
    installSupabaseRelease({
      base: await fixture(t),
      release: { ...release(bytes), sha256: "0".repeat(64) },
      fetcher: fetchBytes(bytes),
    }),
    /SHA256/,
  );
});
test("installer rejects traversal and links in archives", async (t) => {
  const base = await fixture(t);
  for (const bytes of [archive("../supabase"), archive("supabase", "2")]) {
    await assert.rejects(
      installSupabaseRelease({
        base,
        release: release(bytes),
        fetcher: fetchBytes(bytes),
      }),
      /压缩包/,
    );
  }
});
test("installer rejects symlink cache roots", async (t) => {
  const base = await fixture(t),
    bytes = archive();
  await symlink(base, join(base, "linked"));
  await assert.rejects(
    installSupabaseRelease({
      base: join(base, "linked"),
      release: release(bytes),
      fetcher: fetchBytes(bytes),
    }),
    /符号链接/,
  );
});
test("concurrent installs fail with recoverable lock evidence", async (t) => {
  const base = await fixture(t),
    bytes = archive();
  let downloaded!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    downloaded = resolve;
  });
  const allowed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const first = installSupabaseRelease({
    base,
    release: release(bytes),
    fetcher: async () => {
      downloaded();
      await allowed;
      return new Response(new Uint8Array(bytes).buffer);
    },
  });
  await waiting;
  await assert.rejects(
    installSupabaseRelease({
      base,
      release: release(bytes),
      fetcher: fetchBytes(bytes),
    }),
    /lock|并发|另一进程/,
  );
  resume();
  await first;
});
test("download errors allow an explicit retry against the same pinned URL", async (t) => {
  const base = await fixture(t),
    bytes = archive();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    if (!calls++) throw new Error("network");
    return new Response(new Uint8Array(bytes).buffer);
  };
  await assert.rejects(
    installSupabaseRelease({ base, release: release(bytes), fetcher }),
    /下载/,
  );
  assert.equal(
    (
      await readFile(
        await installSupabaseRelease({
          base,
          release: release(bytes),
          fetcher,
        }),
      )
    ).toString(),
    "binary",
  );
});
test("private cache refuses broad permissions and symlink binaries", async (t) => {
  const { chmod, unlink } = await import("node:fs/promises");
  const base = await fixture(t),
    bytes = archive(),
    fixed = release(bytes);
  const path = await installSupabaseRelease({
    base,
    release: fixed,
    fetcher: fetchBytes(bytes),
  });
  await chmod(path, 0o755);
  await assert.rejects(
    installSupabaseRelease({
      base,
      release: fixed,
      fetcher: fetchBytes(bytes),
    }),
    /权限/,
  );
  await chmod(path, 0o700);
  await unlink(path);
  await symlink(join(path, "..", "supabase-go"), path);
  await assert.rejects(
    installSupabaseRelease({
      base,
      release: fixed,
      fetcher: fetchBytes(bytes),
    }),
    /符号链接/,
  );
});
test("malformed, missing companion and duplicate executables are rejected", async (t) => {
  const base = await fixture(t);
  const malformed = Buffer.from("not gzip");
  const missingCompanion = gzipSync(
    Buffer.concat([
      member("supabase", "0", Buffer.from("main")),
      Buffer.alloc(1024),
    ]),
  );
  const duplicate = gzipSync(
    Buffer.concat([
      member("supabase", "0", Buffer.from("main")),
      member("supabase", "0", Buffer.from("main2")),
      Buffer.alloc(1024),
    ]),
  );
  for (const bytes of [malformed, missingCompanion, duplicate])
    await assert.rejects(
      installSupabaseRelease({
        base,
        release: release(bytes),
        fetcher: fetchBytes(bytes),
      }),
      /压缩包/,
    );
});
test("unsafe release metadata is rejected before network or filesystem writes", async (t) => {
  const base = await fixture(t),
    bytes = archive(),
    fixed = release(bytes);
  for (const invalid of [
    { ...fixed, url: "https://evil.example/cli.tar.gz" },
    { ...fixed, version: "../latest" },
    { ...fixed, target: "../../escape" },
    { ...fixed, binary: "../supabase" },
  ])
    await assert.rejects(
      installSupabaseRelease({
        base,
        release: invalid,
        fetcher: async () => {
          throw new Error("unexpected network");
        },
      }),
      /发布信息/,
    );
});
test("oversized and HTTP failed downloads preserve the ability to retry", async (t) => {
  const base = await fixture(t),
    bytes = archive();
  for (const response of [
    new Response("bad", { status: 503 }),
    new Response("large", { headers: { "content-length": "100000001" } }),
  ])
    await assert.rejects(
      installSupabaseRelease({
        base,
        release: release(bytes),
        fetcher: async () => response,
      }),
      /下载/,
    );
  assert.ok(
    await installSupabaseRelease({
      base,
      release: release(bytes),
      fetcher: fetchBytes(bytes),
    }),
  );
});
test("old system CLI prompts for the fixed managed version", async (t) => {
  const base = await fixture(t),
    logs: string[] = [];
  const state = await inspectSupabaseCli({
    base,
    runner: async () => "2.119.0",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(state.kind, "install");
  await assert.rejects(
    ensureSupabaseCli({
      base,
      runner: unavailable,
      ui: { ...yes, log: (message) => logs.push(message) },
      platform: "darwin",
      arch: "arm64",
      fetcher: fetchBytes(archive()),
    }),
    /SHA256/,
  );
  assert.match(logs.join(""), /2\.120\.0/);
});
test("install lock reports work in progress before any cache directory is published", async (t) => {
  const { access, readdir } = await import("node:fs/promises");
  const base = await fixture(t),
    bytes = archive(),
    fixed = release(bytes);
  let started!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const allowed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const installation = installSupabaseRelease({
    base,
    release: fixed,
    fetcher: async () => {
      started();
      await allowed;
      return new Response(new Uint8Array(bytes).buffer);
    },
  });
  await waiting;
  try {
    await assert.rejects(access(join(base, fixed.version, fixed.target)), {
      code: "ENOENT",
    });
    await assert.rejects(
      inspectSupabaseCli({
        base,
        runner: unavailable,
        platform: "darwin",
        arch: "arm64",
      }),
      /安装中/,
    );
    assert.ok(
      (await readdir(join(base, fixed.version))).includes(
        `${fixed.target}.install.lock`,
      ),
    );
  } finally {
    resume();
    await installation;
  }
});
test("a mid-write disk failure never publishes a partial cache and can retry", async (t) => {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const base = await fixture(t),
    bytes = archive(),
    fixed = release(bytes);
  const rename = fs.rename;
  const fault = t.mock.method(
    fs,
    "rename",
    async (
      source: Parameters<typeof rename>[0],
      destination: Parameters<typeof rename>[1],
    ) => {
      if (String(destination).endsWith("/supabase-go"))
        throw Object.assign(new Error("synthetic disk failure"), {
          code: "ENOSPC",
        });
      return rename(source, destination);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      installSupabaseRelease({
        base,
        release: fixed,
        fetcher: fetchBytes(bytes),
      }),
      /synthetic disk failure/,
    );
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.access(join(base, fixed.version, fixed.target)), {
    code: "ENOENT",
  });
  assert.deepEqual(await fs.readdir(join(base, fixed.version)), []);
  assert.equal(
    (
      await readFile(
        await installSupabaseRelease({
          base,
          release: fixed,
          fetcher: fetchBytes(bytes),
        }),
      )
    ).toString(),
    "binary",
  );
});
test("stale sibling locks remain actionable and are never silently deleted", async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const base = await fixture(t),
    bytes = archive(),
    fixed = release(bytes);
  await mkdir(join(base, fixed.version), { mode: 0o700 });
  const lock = join(base, fixed.version, `${fixed.target}.install.lock`);
  await writeFile(lock, "stale", { mode: 0o600 });
  await assert.rejects(
    inspectSupabaseCli({
      base,
      runner: unavailable,
      platform: "darwin",
      arch: "arm64",
    }),
    /安装中.*异常退出/,
  );
  await assert.rejects(
    installSupabaseRelease({
      base,
      release: fixed,
      fetcher: fetchBytes(bytes),
    }),
    /另一进程/,
  );
  assert.equal(await readFile(lock, "utf8"), "stale");
});
