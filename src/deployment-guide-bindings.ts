import { createHash } from "node:crypto";
import { allFields, type Config } from "./config.ts";
import type { Device } from "./devices.ts";
import { guideStageIds, type GuideStageId } from "./deployment-guide-model.ts";
import type { Values } from "./vault.ts";

const cloudflare = [
  "@cloudflare",
  "@cloudflareSource",
  "@cloudflareProfile",
  "@cloudflareIdentity",
];
const supabase = [
  "@supabase",
  "@supabaseSource",
  "@supabaseProfile",
  "@supabaseIdentity",
  "@supabaseIdentityMode",
  "@supabaseOrganization",
];
const providerBindings = [
  ...cloudflare,
  ...supabase,
  "@cloudflareDeploy",
  "@cloudflareTunnelManagement",
  "@repository",
  "@githubIdentity",
  "@githubLogin",
];

/** Session-only dependency digests contain public targets and secret presence, never secret content. */
export function guideStageBindings(
  config: Config,
  values: Values,
  device: Device | undefined,
  commit: string | undefined,
  credentials: Record<string, string>,
): Record<GuideStageId, string> {
  const definitions = allFields(config);
  const selected = device
    ? {
        id: device.id,
        host: device.host,
        user: device.user,
        port: device.port,
      }
    : null;
  const pick = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        definitions[name]?.secret ? !!values[name] : (values[name] ?? null),
      ]),
    );
  const bindings = (names: string[]) => ({
    public: pick(names),
    credentialsPresent: Object.fromEntries(
      names.map((name) => [name, !!credentials[values[name] ?? ""]]),
    ),
  });
  const publicTargets = pick(Object.keys(config.variables).sort());
  const release = {
    targets: publicTargets,
    providers: bindings(providerBindings),
    device: selected,
    commit: commit ?? null,
    release: config.release ?? null,
    setup: config.setup ?? null,
    topology: config.deploymentTopology ?? null,
  };
  const targets = {
    import: {},
    cloudflare: {
      ...bindings(cloudflare),
      targets: pick(["cloudflareAccountId", "pagesProject", "workerName"]),
      setup: config.setup ?? null,
    },
    device: { device: selected, selected: values["@releaseDeviceId"] ?? null },
    configuration: pick([
      "deploymentRuntime",
      "deploymentTarget",
      "remoteDirectory",
      "deploymentImage",
      "tunnelImage",
      "appOrigin",
      "pagesProject",
      "siteOrigin",
      "sshTarget",
    ]),
    tunnel: {
      ...bindings(["@cloudflareTunnelManagement"]),
      targets: pick([
        "cloudflareAccountId",
        "cloudflareZoneId",
        "cloudflareTunnelId",
        "cloudflareTunnelToken",
        "appOrigin",
        "deploymentRuntime",
      ]),
      topology: config.deploymentTopology ?? null,
    },
    supabase: {
      ...bindings(supabase),
      targets: pick([
        "supabaseProjectRef",
        "supabaseUrl",
        "supabasePublishableKey",
      ]),
    },
    auth: {
      ...bindings(supabase),
      targets: pick(["supabaseProjectRef", "appOrigin", "siteOrigin"]),
      auth: config.setup?.auth ?? null,
    },
    application: release,
    pages: release,
    acceptance: release,
  };
  return Object.fromEntries(
    guideStageIds.map((stage) => [
      stage,
      createHash("sha256")
        .update(
          JSON.stringify({
            project: config.project,
            repository: config.repository ?? null,
            environments: config.environments,
            targets: targets[stage],
          }),
        )
        .digest("hex"),
    ]),
  ) as Record<GuideStageId, string>;
}
