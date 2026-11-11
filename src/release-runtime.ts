import { allFields, validateField } from "./config.ts";
import type { ReleaseComponent } from "./release-config.ts";
import { releasePublishableKey, values, type Context } from "./wizard.ts";

// Call only after the operator trusts the checked-in project adapter.
export async function releaseRuntimeValues(
  ctx: Context,
  component: ReleaseComponent,
): Promise<Record<string, string> | undefined> {
  if (component.runtimeFields === undefined) return undefined;
  const declared = component.runtimeFields;
  for (const field of declared)
    if (
      !Object.hasOwn(ctx.config.variables, field) ||
      !allFields(ctx.config)[field]?.secret ||
      ["cloudflareToken", "supabaseCleanupKey"].includes(field)
    )
      throw new Error("运行配置声明包含不允许的敏感字段。");
  if (declared.includes("supabasePublishableKey"))
    await releasePublishableKey(ctx);
  const profile = values(ctx);
  const output: Record<string, string> = {};
  for (const field of declared) {
    if (profile[field])
      output[field] = validateField(ctx.config, field, profile[field]!);
  }
  return Object.freeze(output);
}
