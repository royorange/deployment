import {
  ApiError,
  type Cloudflare,
  type PagesDeployment,
} from "./providers.ts";

export type PagesDeploymentStatus = {
  status:
    | "missing-project"
    | "empty"
    | "missing-deployment"
    | "pending"
    | "failed"
    | "deployed"
    | "unknown";
  message: string;
  branch: string;
  applicationReachability: "unverified";
  deployment?: PagesDeployment;
};

function pagesUrl(value: string, project: string): string | undefined {
  try {
    const url = new URL(value);
    const domain = `${project}.pages.dev`;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      /[\x00-\x20\x7f]/.test(value)
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Read-only API evidence: deployment success never asserts business availability. */
export async function inspectPagesDeployment(
  cloudflare: Cloudflare,
  account: string,
  project: string,
  options: { branch: string; environment?: "preview" | "production" },
): Promise<PagesDeploymentStatus> {
  if (
    !options.branch ||
    options.branch.length > 255 ||
    /[\x00-\x1f\x7f]/.test(options.branch)
  )
    throw new Error("请明确指定待核验的 Pages 分支。");
  const result = (
    status: PagesDeploymentStatus["status"],
    message: string,
    deployment?: PagesDeployment,
  ): PagesDeploymentStatus => ({
    status,
    message,
    branch: options.branch,
    applicationReachability: "unverified",
    ...(deployment ? { deployment } : {}),
  });
  try {
    const resource = await cloudflare.pagesProject(account, project);
    if (!resource)
      return result("missing-project", "Pages 项目不存在；尚未创建资源。");
    const deployments = await cloudflare.pagesDeployments(
      account,
      project,
      options,
    );
    if (!deployments.length)
      return result("empty", "Pages 项目存在，但所查环境尚无部署记录。");
    const deployment = deployments
      .filter(
        (entry) =>
          entry.branch === options.branch &&
          (!options.environment || entry.environment === options.environment),
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_on) - Date.parse(left.created_on),
      )[0];
    if (!deployment)
      return result(
        "missing-deployment",
        "尚未找到目标分支的真实部署；不会推测分支地址。",
      );
    const url = pagesUrl(deployment.url, project);
    if (!url)
      return result(
        "unknown",
        "部署 URL 不符合目标项目的 Cloudflare HTTPS 域名，需人工核对。",
      );
    const evidence: PagesDeployment = {
      ...deployment,
      url,
      aliases: deployment.aliases.flatMap((alias) => {
        const validated = pagesUrl(alias, project);
        return validated ? [validated] : [];
      }),
    };
    const { name, status } = deployment.latest_stage;
    if (deployment.is_skipped || ["failure", "canceled"].includes(status))
      return result(
        "failed",
        "目标分支的最新部署已失败、取消或跳过。",
        evidence,
      );
    if (status === "success" && name === "deploy")
      return result(
        "deployed",
        "API 已确认目标分支发布成功；实际访问、Access 和业务功能尚未验收。",
        evidence,
      );
    if (["active", "idle", "success"].includes(status))
      return result("pending", "目标分支的最新部署尚未完成发布。", evidence);
    return result(
      "unknown",
      "部署状态无法识别；请在 Cloudflare 控制台核对。",
      evidence,
    );
  } catch (error) {
    return result(
      "unknown",
      error instanceof ApiError
        ? `无法核验 Pages 部署（HTTP ${error.status}）；请检查账号、Pages Read 权限与服务状态。`
        : "无法核验 Pages 部署；请检查网络、响应格式或分页范围后重试。",
    );
  }
}
