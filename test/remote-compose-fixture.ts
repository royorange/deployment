import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { controller } from "../src/remote-compose-controller.ts";
import type {
  RemoteComposeInput,
  RemoteComposeReceipt,
} from "../src/remote-compose.ts";

const harness = String.raw`
OWNER_UID = os.getuid()
os.chown = lambda *args: None
real_regular = regular
real_write_bytes = write_bytes
written_files = 0
def write_bytes(path, data, uid=0, mode=0o600):
    global written_files
    real_write_bytes(path, data, uid, mode)
    written_files += 1
    if options.get("interruptCandidateWrite") and written_files == 1:
        raise RuntimeError("synthetic write interruption")
def regular(path, uid=0, mode=0o600):
    return real_regular(path, OWNER_UID if uid == 0 else uid, mode)

fixture = BASE.parent.parent / "fixture.json"
trace = BASE.parent.parent / "trace.json"
stored = json.loads(fixture.read_text()) if fixture.exists() else []
calls = []
def persist():
    fixture.write_text(json.dumps(stored))
    trace.write_text(json.dumps(calls))
persist()
def command(args, timeout=60):
    global stored
    if args[0] == "sudo":
        args = args[args.index("docker"):]
    require(args[0] == "docker")
    args = args[1:]
    calls.append(args)
    persist()
    if args[0] == "info":
        return "amd64" if "Architecture" in args[-1] else "fixture-daemon"
    if args[:2] == ["compose", "version"]:
        return "Docker Compose fixture"
    if args[0] == "ps":
        return "\n".join(entry["Id"] for entry in stored)
    if args[0] == "inspect":
        return json.dumps(stored)
    if args[0] == "pull":
        return ""
    if args[:2] == ["image", "inspect"]:
        return json.dumps([{"Architecture": "amd64", "Os": "linux", "Config": {"Labels": {"org.opencontainers.image.revision": "0" * 40 if options.get("wrongRevision") else request["revision"]}}}])
    require(args[0] == "compose")
    root = pathlib.Path(args[args.index("--project-directory") + 1])
    item = json.loads((root / "metadata.json").read_text())
    action = args[args.index("-f") + 2]
    if action == "config":
        return json.dumps({"services": {service: {"image": image, "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "mem_limit": "67108864", "cpus": 0.5, **({"privileged": True} if options.get("unsafeCompose") else {})} for service, image in item["images"].items()}, "networks": {"default": {"name": PROJECT + "_default"}}})
    if action == "up":
        require("--force-recreate" in args and "--no-build" in args and "never" in args)
        candidate = root.name == request.get("revision")
        failed = (candidate and options.get("failCandidate")) or (not candidate and options.get("failRecovery"))
        stored = [{"Id": str(index + 1) * 64, "Config": {"Image": image, "Labels": {"com.docker.compose.project": PROJECT, "com.docker.compose.service": service, "com.docker.compose.project.config_files": str(root / "compose.yml"), "com.docker.compose.project.working_dir": str(root)}}, "State": {"Status": "running", "Health": {"Status": "unhealthy" if failed else "healthy"}}} for index, (service, image) in enumerate(item["images"].items())]
        persist()
        if failed:
            raise RuntimeError("fixture-private-error")
        return ""
    if action == "stop":
        for entry in stored:
            entry["State"]["Status"] = "exited"
        persist()
        return ""
    if action == "down":
        stored = []
        persist()
        return ""
    raise RuntimeError("unexpected command")
if options.get("holdLock"):
    held = open(BASE / ".lock", "r+")
    fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
`;

export async function composeFixture() {
  const root = await mkdtemp(join(tmpdir(), "setup-compose-"));
  const opt = join(root, "opt");
  await mkdir(opt, { mode: 0o700 });
  const base = join(opt, "example", "staging");
  return {
    root,
    base,
    async run(
      input: RemoteComposeInput,
      action: "deploy" | "inspect" | "recover" = "deploy",
      options: Record<string, boolean> = {},
    ) {
      const request = { ...input, remoteDirectory: base, action };
      const script = `import base64, json\nrequest=json.loads(base64.b64decode("${Buffer.from(JSON.stringify(request)).toString("base64")}"))\noptions=json.loads('${JSON.stringify(options)}')\n${controller.replace("try:\n    main()", `${harness}\ntry:\n    main()`)}`;
      const result = spawnSync("python3", ["-"], {
        input: script,
        encoding: "utf8",
        timeout: 10000,
      });
      if (result.status !== 0)
        throw new Error(`Fixture controller did not execute: ${result.stderr}`);
      return JSON.parse(result.stdout) as RemoteComposeReceipt;
    },
    async state() {
      return JSON.parse(
        await readFile(join(base, "state.json"), "utf8"),
      ) as Record<string, string | null>;
    },
    async calls() {
      return JSON.parse(
        await readFile(join(opt, "trace.json"), "utf8"),
      ) as string[][];
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
