import type { Config } from "./config.ts";

export type SetupComponent = {
  id: string;
  title: string;
  kind: "web" | "admin" | "api" | "job";
  hosting: "pages" | "worker" | "aws" | "external";
  originField?: string;
  projectField?: string;
  branchField?: string;
  instructions?: string;
  docs?: string;
};
export type SetupRequirement = {
  id: string;
  title: string;
  purpose: string;
  instructions: string;
  fields?: string[];
  docs?: string;
};
export type SetupConfig = {
  auth?: "supabase" | "firebase" | "external" | "none";
  components?: SetupComponent[];
  requirements?: SetupRequirement[];
};

type Definition = { secret: boolean; kind: string };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("项目引导声明必须是对象。");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("项目引导声明含未知字段；不支持执行命令或默认凭据。");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new Error("项目引导文字为空、过长或含控制字符。");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,49}$/.test(value))
    throw new Error("项目引导组件或要求的标识不合法。");
}
function docs(value: unknown): void {
  if (value === undefined) return;
  text(value, 400);
  if (value.startsWith("https://")) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /^(localhost|127\.|\[::1\])/.test(url.hostname)
    )
      throw new Error("项目引导文档 URL 不能包含凭据、参数或本机地址。");
    return;
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error("项目引导文档须为 HTTPS URL 或项目内相对路径。");
}
function list(value: unknown, maximum: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error("项目引导组件或要求数量超出限制。");
  return value;
}

export function validateSetup(
  config: Config,
  definitions: Record<string, Definition>,
): void {
  if (config.setup === undefined) return;
  const setup = object(config.setup, ["auth", "components", "requirements"]);
  if (
    setup.auth !== undefined &&
    !["supabase", "firebase", "external", "none"].includes(setup.auth as string)
  )
    throw new Error("项目引导认证方式不合法。");
  const reference = (value: unknown, kind?: string): void => {
    if (
      typeof value !== "string" ||
      !Object.hasOwn(config.variables, value) ||
      !Object.hasOwn(definitions, value) ||
      (kind !== undefined &&
        (definitions[value]!.secret ||
          (["origin", "text"].includes(kind) &&
            definitions[value]!.kind !== kind)))
    )
      throw new Error("项目引导引用了未知字段、凭据字段或错误的字段类型。");
  };
  const publicExtraText = (value: unknown): boolean =>
    typeof value === "string" &&
    Object.hasOwn(config.extraFields ?? {}, value) &&
    definitions[value]?.kind === "text" &&
    !definitions[value]?.secret;
  const componentIds = new Set<string>();
  for (const item of list(setup.components, 12)) {
    const component = object(item, [
      "id",
      "title",
      "kind",
      "hosting",
      "originField",
      "projectField",
      "branchField",
      "instructions",
      "docs",
    ]);
    identifier(component.id);
    if (componentIds.has(component.id))
      throw new Error("项目引导组件标识重复。");
    componentIds.add(component.id);
    text(component.title, 100);
    if (
      !["web", "admin", "api", "job"].includes(component.kind as string) ||
      !["pages", "worker", "aws", "external"].includes(
        component.hosting as string,
      )
    )
      throw new Error("项目引导组件类型或托管方式不合法。");
    if (component.originField !== undefined)
      reference(component.originField, "origin");
    if (component.projectField !== undefined)
      reference(component.projectField, "public");
    if (component.branchField !== undefined)
      reference(component.branchField, "text");
    const componentFields = [
      component.originField,
      component.projectField,
      component.branchField,
    ].filter((field) => field !== undefined);
    if (new Set(componentFields).size !== componentFields.length)
      throw new Error("项目引导组件的入口、资源和分支字段不能重复。");
    if (
      component.hosting === "pages" &&
      component.projectField !== undefined &&
      component.projectField !== "pagesProject" &&
      !publicExtraText(component.projectField)
    )
      throw new Error(
        "项目引导 Pages 资源字段只能使用 pagesProject 或公开文本扩展字段。",
      );
    if (
      component.branchField !== undefined &&
      !publicExtraText(component.branchField)
    )
      throw new Error("项目引导部署分支只能使用公开文本扩展字段。");
    if (component.instructions !== undefined)
      text(component.instructions, 2000);
    docs(component.docs);
  }
  const requirementIds = new Set<string>();
  for (const item of list(setup.requirements, 20)) {
    const requirement = object(item, [
      "id",
      "title",
      "purpose",
      "instructions",
      "fields",
      "docs",
    ]);
    identifier(requirement.id);
    if (requirementIds.has(requirement.id))
      throw new Error("项目引导要求标识重复。");
    requirementIds.add(requirement.id);
    text(requirement.title, 100);
    text(requirement.purpose, 400);
    text(requirement.instructions, 2000);
    if (requirement.fields !== undefined) {
      const references = list(requirement.fields, 20);
      if (!references.length || new Set(references).size !== references.length)
        throw new Error("项目引导要求的字段为空或重复。");
      for (const field of references) reference(field);
    }
    docs(requirement.docs);
  }
}
