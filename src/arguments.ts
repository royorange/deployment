import { resolve } from "node:path";

export function argumentsFor(argv: string[]): {
  root?: string;
  manifest?: string;
  memory: boolean;
  mode: "vault" | "metadata" | "memory";
  help: boolean;
  init: boolean;
  doctor: boolean;
} {
  let root: string | undefined;
  let manifest: string | undefined;
  let mode: "vault" | "metadata" | "memory" | undefined;
  let help = false;
  let init = false;
  let doctor = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (["--memory", "--vault", "--no-vault"].includes(arg!)) {
      const next =
        arg === "--memory"
          ? "memory"
          : arg === "--no-vault"
            ? "metadata"
            : "vault";
      if (mode && mode !== next)
        throw new Error("--memory、--vault 与 --no-vault 不能同时使用。");
      mode = next;
    } else if (arg === "--init") init = true;
    else if (arg === "--doctor") doctor = true;
    else if (arg === "--root" || arg === "--config") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("参数缺少路径。");
      if (arg === "--root") root = resolve(value);
      else manifest = value;
    } else
      throw new Error(
        "未知参数；请运行 project-setup --help。不要通过命令行参数传递凭据。",
      );
  }
  return {
    root,
    manifest,
    memory: mode === "memory",
    mode: mode ?? "vault",
    help,
    init,
    doctor,
  };
}
