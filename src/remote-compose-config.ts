import { parseDocument } from "yaml";

/** Canonical JSON prevents Compose from reading include/extends files on the host. */
export function normalizeCompose(source: string): string {
  try {
    if (Buffer.byteLength(source) > 64_000) throw new Error();
    const document = parseDocument(source, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("services" in value)
    )
      throw new Error();
    const inspect = (node: unknown, depth: number) => {
      if (depth > 30) throw new Error();
      if (node && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (
            [
              "include",
              "extends",
              "label_file",
              "provider",
              "models",
              "__proto__",
              "constructor",
              "prototype",
            ].includes(key)
          )
            throw new Error();
          inspect(child, depth + 1);
        }
      }
    };
    inspect(value, 0);
    return JSON.stringify(value);
  } catch {
    throw new Error(
      "Compose 配置必须是单一、无外部引用的 YAML/JSON；不支持 include、extends、别名或自定义标签。",
    );
  }
}
