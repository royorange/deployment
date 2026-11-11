import { sshArguments, validateDevice, type Device } from "./devices.ts";
import { run, type Runner } from "./process.ts";
import { controller } from "./remote-compose-controller.ts";
import { normalizeCompose } from "./remote-compose-config.ts";

export type RemoteComposeScope = {
  device: Device;
  project: string;
  environment: string;
  remoteDirectory: string;
};
export type RemoteComposeInput = RemoteComposeScope & {
  revision: string;
  composeYaml: string;
  publicEnv: Readonly<Record<string, string>>;
  imageDigests: Readonly<Record<string, string>>;
  privateFiles: Readonly<
    Record<
      string,
      {
        content: string;
        uid: 0 | 1000;
        mode: "0400" | "0600";
      }
    >
  >;
  expectedServices: readonly string[];
  healthService: string;
};
export type RemoteComposeRecovery = RemoteComposeScope & {
  expectedCurrentRevision: string;
  targetRevision: string;
};
export type RemoteComposeReceipt = {
  version: 1;
  state:
    | "absent"
    | "deployed"
    | "degraded"
    | "blocked"
    | "recovered"
    | "recovery-required";
  revision: string | null;
  previous: string | null;
};
export class RemoteComposeError extends Error {
  readonly receipt?: RemoteComposeReceipt;
  constructor(receipt?: RemoteComposeReceipt) {
    super(
      receipt
        ? `远端 Compose 未完成发布（${receipt.state}）；请重新检查实际运行状态。`
        : "远端 Compose 结果未能核验；未重试变更，请检查连接和实际运行状态。",
    );
    this.receipt = receipt;
  }
}
const name = /^[a-z][a-z0-9-]{0,31}$/;
const sha = /^[a-f0-9]{40}$/;
const invalid = () =>
  new Error(
    "远端 Compose 配置不合法；检查目标作用域、固定镜像与私密文件声明。",
  );
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function scope(input: RemoteComposeScope): RemoteComposeScope {
  if (
    !object(input) ||
    typeof input.project !== "string" ||
    !name.test(input.project) ||
    typeof input.environment !== "string" ||
    !name.test(input.environment) ||
    input.remoteDirectory !== `/opt/${input.project}/${input.environment}`
  )
    throw invalid();
  return {
    device: validateDevice(input.device),
    project: input.project,
    environment: input.environment,
    remoteDirectory: input.remoteDirectory,
  };
}
export function remoteReleaseDirectory(
  input: RemoteComposeScope & { revision: string },
): string {
  const target = scope(input);
  if (!sha.test(input.revision)) throw invalid();
  return `${target.remoteDirectory}/releases/${input.revision}`;
}
function validated(input: RemoteComposeInput): RemoteComposeInput {
  const target = scope(input);
  remoteReleaseDirectory(input);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "device",
          "project",
          "environment",
          "remoteDirectory",
          "revision",
          "composeYaml",
          "publicEnv",
          "imageDigests",
          "privateFiles",
          "expectedServices",
          "healthService",
        ].includes(key),
    ) ||
    typeof input.composeYaml !== "string" ||
    !input.composeYaml ||
    Buffer.byteLength(input.composeYaml) > 64_000 ||
    input.composeYaml.includes("\0") ||
    !Array.isArray(input.expectedServices) ||
    !input.expectedServices.length ||
    input.expectedServices.length > 8 ||
    new Set(input.expectedServices).size !== input.expectedServices.length ||
    input.expectedServices.some((service) => !name.test(service)) ||
    !input.expectedServices.includes(input.healthService) ||
    !object(input.publicEnv) ||
    Object.keys(input.publicEnv).length > 64 ||
    Object.entries(input.publicEnv).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) ||
        /^(?:PATH|HOME|LD_|PYTHON|DOCKER_|COMPOSE_)/.test(key) ||
        typeof value !== "string" ||
        value.length > 4096 ||
        /[\x00-\x1f\x7f'\\]/.test(value),
    ) ||
    !object(input.imageDigests) ||
    Object.keys(input.imageDigests).sort().join() !==
      [...input.expectedServices].sort().join() ||
    Object.values(input.imageDigests).some(
      (value) =>
        typeof value !== "string" ||
        !/^[a-z0-9][a-z0-9./:_-]{1,240}@sha256:[a-f0-9]{64}$/.test(value),
    ) ||
    !object(input.privateFiles) ||
    Object.keys(input.privateFiles).length > 16 ||
    Object.entries(input.privateFiles).some(
      ([path, file]) =>
        !/^[a-z][a-z0-9_.-]{0,63}$/.test(path) ||
        ["compose.yml", "public.env", "metadata.json"].includes(path) ||
        !object(file) ||
        Object.keys(file).sort().join() !== "content,mode,uid" ||
        typeof file.content !== "string" ||
        Buffer.byteLength(file.content) > 64_000 ||
        file.content.includes("\0") ||
        ![0, 1000].includes(file.uid as number) ||
        !["0400", "0600"].includes(file.mode as string),
    )
  )
    throw invalid();
  if (Buffer.byteLength(JSON.stringify(input)) > 256_000) throw invalid();
  return JSON.parse(
    JSON.stringify({
      ...input,
      ...target,
      composeYaml: normalizeCompose(input.composeYaml),
    }),
  ) as RemoteComposeInput;
}
/** The fixed Python controller receives secrets through SSH stdin, never shell arguments. */
export function remoteComposeScript(
  input: RemoteComposeInput | RemoteComposeScope | RemoteComposeRecovery,
  action: "deploy" | "inspect" | "recover",
): string {
  const payload =
    action === "deploy"
      ? validated(input as RemoteComposeInput)
      : action === "recover"
        ? recovery(input as RemoteComposeRecovery)
        : scope(input);
  const encoded = Buffer.from(JSON.stringify({ ...payload, action })).toString(
    "base64",
  );
  return `import base64, json\nrequest = json.loads(base64.b64decode("${encoded}"))\n${controller}`;
}
function parse(raw: string): RemoteComposeReceipt {
  if (Buffer.byteLength(raw) > 2048) throw new RemoteComposeError();
  let result: unknown;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new RemoteComposeError();
  }
  if (
    !object(result) ||
    Object.keys(result).sort().join() !== "previous,revision,state,version" ||
    result.version !== 1 ||
    ![
      "absent",
      "deployed",
      "degraded",
      "blocked",
      "recovered",
      "recovery-required",
    ].includes(String(result.state)) ||
    (result.revision !== null &&
      (typeof result.revision !== "string" || !sha.test(result.revision))) ||
    (result.previous !== null &&
      (typeof result.previous !== "string" || !sha.test(result.previous))) ||
    (result.state === "deployed" && result.revision === null) ||
    (result.state === "absent" && result.revision !== null)
  )
    throw new RemoteComposeError();
  return result as RemoteComposeReceipt;
}
async function execute(
  input: RemoteComposeScope,
  script: string,
  runner: Runner,
): Promise<RemoteComposeReceipt> {
  const env = Object.fromEntries(
    ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  let raw: string;
  try {
    raw = await runner(
      "ssh",
      [
        "-o",
        "ConnectTimeout=10",
        ...sshArguments(input.device),
        "sudo -n python3 -",
      ],
      { input: script, env, timeout: 600_000, captureStderr: false },
    );
  } catch {
    throw new RemoteComposeError();
  }
  return parse(raw);
}
export async function deployRemoteCompose(
  input: RemoteComposeInput,
  dependencies: { runner?: Runner } = {},
): Promise<RemoteComposeReceipt> {
  const frozen = validated(input);
  const receipt = await execute(
    frozen,
    remoteComposeScript(frozen, "deploy"),
    dependencies.runner ?? run,
  );
  if (receipt.state !== "deployed" || receipt.revision !== frozen.revision)
    throw new RemoteComposeError(receipt);
  return receipt;
}
export async function inspectRemoteCompose(
  input: RemoteComposeScope,
  dependencies: { runner?: Runner } = {},
): Promise<RemoteComposeReceipt> {
  const frozen = scope(input);
  return execute(
    frozen,
    remoteComposeScript(frozen, "inspect"),
    dependencies.runner ?? run,
  );
}
function recovery(input: RemoteComposeRecovery): RemoteComposeRecovery {
  const target = scope(input);
  if (
    !sha.test(input.expectedCurrentRevision) ||
    !sha.test(input.targetRevision) ||
    input.expectedCurrentRevision === input.targetRevision
  )
    throw invalid();
  return {
    ...target,
    expectedCurrentRevision: input.expectedCurrentRevision,
    targetRevision: input.targetRevision,
  };
}
export async function recoverRemoteCompose(
  input: RemoteComposeRecovery,
  dependencies: { runner?: Runner } = {},
): Promise<RemoteComposeReceipt> {
  const frozen = recovery(input);
  const result = await execute(
    frozen,
    remoteComposeScript(frozen, "recover"),
    dependencies.runner ?? run,
  );
  if (
    result.state !== "deployed" ||
    result.revision !== frozen.targetRevision ||
    result.previous !== frozen.expectedCurrentRevision
  )
    throw new RemoteComposeError(result);
  return result;
}
