import type { Config } from "./config.ts";

export function authCallbacks(config: Config, origin: string): string[] {
  return (config.setup?.authCallbacks ?? ["/**"]).map(
    (path) => `${origin}${path}`,
  );
}
