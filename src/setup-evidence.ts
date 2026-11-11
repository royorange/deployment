import type { Config } from "./config.ts";
import type { PagesDeploymentStatus } from "./pages-status.ts";
import type { SetupCheck } from "./setup-model.ts";
import type { Values } from "./vault.ts";

export type PagesEvidence = {
  account: string;
  project: string;
  projectField: string;
  branch: string;
  status: PagesDeploymentStatus["status"];
  message: string;
  checkedAt: string;
};
/** Session-scoped API snapshots apply only to matching public bindings. */
export function withPagesEvidence(
  config: Config,
  values: Values,
  checks: SetupCheck[],
  evidence: PagesEvidence[] = [],
): SetupCheck[] {
  return checks.map((check) => {
    const component = config.setup?.components?.find(
      (item) =>
        item.hosting === "pages" &&
        check.id === `component.${item.id}.deployment`,
    );
    const projectField =
      component?.projectField ??
      (check.id === "cloudflare.pages.deployment" ? "pagesProject" : undefined);
    if (!projectField) return check;
    const snapshot = evidence.find(
      (item) =>
        item.account === values.cloudflareAccountId &&
        item.projectField === projectField &&
        item.project === values[projectField] &&
        (!component?.branchField ||
          item.branch === values[component.branchField]),
    );
    if (!snapshot) return check;
    return {
      ...check,
      state:
        snapshot.status === "deployed"
          ? "published"
          : [
                "failed",
                "empty",
                "missing-deployment",
                "missing-project",
              ].includes(snapshot.status)
            ? "missing"
            : "unknown",
      instructions: `API 检查记录：${snapshot.checkedAt}；分支 ${snapshot.branch}；${snapshot.message}。这是检查时的资源证据，实际访问和业务仍待验证。 ${check.instructions}`,
    };
  });
}
