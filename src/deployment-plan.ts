import { isIP } from "node:net";
import { run, type Runner } from "./process.ts";

export type DeploymentCheck = {
  id: string;
  status: "ready" | "missing" | "unknown";
  message: string;
};
export type DeploymentPlan = {
  project: string;
  environment: string;
  runtime: "aws-tunnel";
  /** Configuration readiness only; this does not establish deployment health. */
  ready: boolean;
  checks: DeploymentCheck[];
  publicValues: Record<string, string>;
};

function sshTarget(value: string): boolean {
  if (value.length > 286) return false;
  const parts = value.split("@");
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(parts[0]!))
    return false;
  const host = parts.at(-1)!;
  return (
    host.length <= 253 &&
    host
      .split(".")
      .every((part) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/.test(part),
      )
  );
}

function directory(value: string): boolean {
  // Restrict deployments to explicit application directories, never system roots.
  return (
    /^\/(?:opt|srv)\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(value) &&
    value.length <= 256
  );
}

function origin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      !isIP(url.hostname) &&
      url.hostname.includes(".") &&
      /^[a-z0-9.-]+$/.test(url.hostname) &&
      url.hostname
        .split(".")
        .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|workers\.dev|pages\.dev)$/.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

export function deploymentPlan(
  project: string,
  environment: string | undefined,
  values: Readonly<Record<string, string>>,
): DeploymentPlan {
  const checks: DeploymentCheck[] = [];
  const publicValues: Record<string, string> = {};
  const check = (id: string, valid: boolean, message: string) => {
    checks.push({
      id,
      status: valid ? "ready" : "missing",
      message: valid ? "已提供有效配置。" : message,
    });
    return valid;
  };
  const publicField = (
    id: string,
    valid: boolean,
    message: string,
    value = values[id] ?? "",
  ) => {
    if (check(id, valid, message)) publicValues[id] = value;
  };
  const nameValid = check(
    "project",
    /^[a-z][a-z0-9-]{0,62}$/.test(project),
    "项目名称需为小写字母、数字与横杠。",
  );
  const selected = environment ?? "staging";
  const environmentValid = check(
    "environment",
    selected === "staging" || selected === "production",
    "请明确选择 staging 或 production 环境。",
  );
  publicField(
    "deploymentRuntime",
    values.deploymentRuntime === "aws-tunnel",
    "请选择 AWS 主机与 Cloudflare Tunnel 运行方式。",
  );
  publicField(
    "sshTarget",
    sshTarget(values.sshTarget ?? ""),
    "请提供安全的 SSH 别名或 user@hostname。",
  );
  publicField(
    "remoteDirectory",
    directory(values.remoteDirectory ?? ""),
    "远端目录需为 /opt 或 /srv 下包含项目与环境的独立绝对目录。",
  );
  publicField(
    "deploymentImage",
    /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/.test(
      values.deploymentImage ?? "",
    ),
    "应用镜像需为 GHCR 的不可变 SHA256 摘要引用。",
  );
  publicField(
    "tunnelImage",
    /^cloudflare\/cloudflared@sha256:[a-f0-9]{64}$/.test(
      values.tunnelImage ?? "",
    ),
    "Tunnel 镜像需固定官方 cloudflare/cloudflared 的 SHA256 摘要。",
  );
  publicField(
    "appOrigin",
    origin(values.appOrigin ?? ""),
    "应用 Origin 需为 HTTPS 自定义域名，不能包含路径、凭据或查询参数。",
  );
  for (const field of ["cloudflareAccountId", "cloudflareZoneId"])
    publicField(
      field,
      /^[a-f0-9]{32}$/.test(values[field] ?? ""),
      "请配置有效的 Cloudflare 账号与 Zone ID。",
    );
  publicField(
    "cloudflareTunnelId",
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
      values.cloudflareTunnelId ?? "",
    ),
    "请配置有效的 Cloudflare Tunnel ID。",
  );
  const refValid = /^[a-z]{20}$/.test(values.supabaseProjectRef ?? "");
  publicField(
    "supabaseProjectRef",
    refValid,
    "请配置已核验的 Supabase Project Ref。",
  );
  publicField(
    "supabaseUrl",
    refValid &&
      values.supabaseUrl === `https://${values.supabaseProjectRef}.supabase.co`,
    "Supabase URL 必须与 Project Ref 完全匹配。",
  );
  for (const field of ["supabasePublishableKey", "cloudflareTunnelToken"])
    check(
      field,
      Boolean(values[field]?.trim()),
      "此凭据尚未载入；仅检查是否存在，不回显内容。",
    );
  const synthetic = values.syntheticFilesEnabled ?? "false";
  publicField(
    "syntheticFilesEnabled",
    synthetic === "false" || synthetic === "true",
    "合成文件开关只能是 true 或 false。",
    synthetic,
  );
  const cleanup = values.cleanupEnabled ?? "false";
  publicField(
    "cleanupEnabled",
    (cleanup === "false" || cleanup === "true") &&
      (synthetic !== "true" || cleanup === "true"),
    "清理调度开关只能是 true 或 false；开启合成文件时必须明确开启清理调度。",
    cleanup,
  );
  if (synthetic === "true" || cleanup === "true")
    check(
      "supabaseCleanupKey",
      Boolean(values.supabaseCleanupKey?.trim()),
      "启用合成文件功能需要独立清理凭据。",
    );
  const ready = checks.every((item) => item.status === "ready");
  checks.push({
    id: "remoteDeployment",
    status: "unknown",
    message:
      "本计划仅检查本地配置；主机、DNS、Tunnel 路由、数据库迁移和应用健康仍需单独验证，未执行部署。",
  });
  return {
    project: nameValid ? project : "invalid-project",
    environment: environmentValid ? selected : "invalid-environment",
    runtime: "aws-tunnel",
    ready,
    checks,
    publicValues,
  };
}

export type HostFacts = {
  architecture: string;
  memoryMiB: number;
  diskMiB: number;
  dockerAvailable: boolean;
  composeAvailable: boolean;
  runningContainers: number;
  listeningPorts: number[];
};
export type HostPreflight = {
  reachable: boolean;
  checks: DeploymentCheck[];
  facts?: HostFacts;
};

const hostScript = `set -eu
architecture=$(uname -m)
memory=$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo)
disk=$(df -Pk / | awk 'NR == 2 {printf "%d", $4 / 1024}')
docker_available=0
compose_available=0
containers=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker_available=1
  if docker compose version >/dev/null 2>&1; then compose_available=1; fi
  container_ids=$(docker ps -q)
  if [ -n "$container_ids" ]; then containers=$(printf '%s\\n' "$container_ids" | wc -l | tr -d ' '); fi
fi
socket_rows=$(ss -H -lnt)
ports=$(printf '%s\\n' "$socket_rows" | awk 'NF {n=split($4,a,":"); print a[n]}' | sort -nu | paste -sd, -)
printf 'PROJECT_SETUP_PREFLIGHT=1\\narchitecture=%s\\nmemoryMiB=%s\\ndiskMiB=%s\\ndockerAvailable=%s\\ncomposeAvailable=%s\\nrunningContainers=%s\\nlisteningPorts=%s\\n' "$architecture" "$memory" "$disk" "$docker_available" "$compose_available" "$containers" "$ports"
`;

function parseFacts(output: string): HostFacts | undefined {
  if (output.length > 8192) return undefined;
  const fields = new Map<string, string>();
  for (const line of output.trimEnd().split("\n")) {
    const match = /^([A-Za-z_]+)=(.*)$/.exec(line);
    if (!match || fields.has(match[1]!)) return undefined;
    fields.set(match[1]!, match[2]!);
  }
  if (fields.size !== 8 || fields.get("PROJECT_SETUP_PREFLIGHT") !== "1")
    return undefined;
  const architecture = fields.get("architecture");
  if (
    !architecture ||
    !["aarch64", "arm64", "x86_64", "amd64"].includes(architecture)
  )
    return undefined;
  const numeric = ["memoryMiB", "diskMiB", "runningContainers"].map((key) =>
    fields.get(key),
  );
  if (numeric.some((value) => !value || !/^\d{1,12}$/.test(value)))
    return undefined;
  const [memoryMiB, diskMiB, runningContainers] = numeric.map(Number) as [
    number,
    number,
    number,
  ];
  if (memoryMiB === 0 || diskMiB === 0 || runningContainers > 100_000)
    return undefined;
  const docker = fields.get("dockerAvailable");
  const compose = fields.get("composeAvailable");
  const rawPorts = fields.get("listeningPorts");
  if (
    !/^[01]$/.test(docker ?? "") ||
    !/^[01]$/.test(compose ?? "") ||
    rawPorts === undefined ||
    !/^(?:\d{1,5}(?:,\d{1,5})*)?$/.test(rawPorts)
  )
    return undefined;
  const listeningPorts = rawPorts ? rawPorts.split(",").map(Number) : [];
  if (
    listeningPorts.some((port) => port < 1 || port > 65535) ||
    new Set(listeningPorts).size !== listeningPorts.length
  )
    return undefined;
  return {
    architecture,
    memoryMiB,
    diskMiB,
    runningContainers,
    dockerAvailable: docker === "1",
    composeAvailable: compose === "1",
    listeningPorts,
  };
}

export async function checkSshHost(
  target: string,
  runner: Runner = run,
): Promise<HostPreflight> {
  if (!sshTarget(target))
    return {
      reachable: false,
      checks: [
        {
          id: "ssh",
          status: "missing",
          message: "SSH 目标格式不合法，未连接主机。",
        },
      ],
    };
  let output: string;
  try {
    output = await runner(
      "ssh",
      [
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=yes",
        "-oConnectTimeout=10",
        "-oConnectionAttempts=1",
        "-oClearAllForwardings=yes",
        "-oForwardAgent=no",
        "-oPermitLocalCommand=no",
        "-T",
        "--",
        target,
        "sh",
        "-s",
      ],
      { input: hostScript, timeout: 30_000 },
    );
  } catch {
    return {
      reachable: false,
      checks: [
        {
          id: "ssh",
          status: "unknown",
          message:
            "SSH 只读检查失败；请检查主机密钥信任、已有登录权限与网络。未修改主机，已隐藏命令输出。",
        },
      ],
    };
  }
  const facts = parseFacts(output);
  if (!facts)
    return {
      reachable: true,
      checks: [
        {
          id: "host",
          status: "unknown",
          message:
            "SSH 返回的主机检查格式不兼容，无法确认环境；已隐藏原始输出。",
        },
      ],
    };
  return {
    reachable: true,
    facts,
    checks: [
      {
        id: "ssh",
        status: "ready",
        message: "SSH 只读连接成功，未修改服务器。",
      },
      {
        id: "docker",
        status: facts.dockerAvailable ? "ready" : "missing",
        message: facts.dockerAvailable
          ? "当前账号可访问 Docker。"
          : "Docker 不可用或当前账号无访问权限。",
      },
      {
        id: "compose",
        status: facts.composeAvailable ? "ready" : "missing",
        message: facts.composeAvailable
          ? "Docker Compose 可用。"
          : "Docker Compose 尚未验证可用。",
      },
      {
        id: "memory",
        status: facts.memoryMiB >= 512 ? "ready" : "unknown",
        message: `主机内存 ${facts.memoryMiB} MiB；实际应用容量需另行评估。`,
      },
      {
        id: "disk",
        status: facts.diskMiB >= 1024 ? "ready" : "unknown",
        message: `根文件系统可用 ${facts.diskMiB} MiB；目标目录空间需部署时核对。`,
      },
      {
        id: "coexistence",
        status: "unknown",
        message: `现有运行容器 ${facts.runningContainers} 个，TCP 监听端口 ${facts.listeningPorts.length} 个；需核对已有服务，未读取容器配置或修改端口。`,
      },
    ],
  };
}
