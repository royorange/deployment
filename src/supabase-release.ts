// Verified against both the official release API and checksums.txt for v2.120.0.
// https://github.com/supabase/cli/releases/tag/v2.120.0
export const SUPABASE_CLI_VERSION = "2.120.0";
export type SupabaseRelease = {
  version: string;
  target: string;
  binary: string;
  url: string;
  sha256: string;
};
const checksums: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64":
    "3b8546cc61aeabab6fd1f68edc7f664ebdfa96bdd6a9b18d8d612708f430ae28",
  "darwin-amd64":
    "4c6fd79d3feaab3ba404f18044e6abee09d73c39376491476cb64880b3822f46",
  "linux-arm64":
    "f1747691843837be981fba9f92bf30bf1ddb8cee937ba3806454325af12a8ffc",
  "linux-amd64":
    "7074584113aa00495beeac661c41fb09f1ddd0a483cd7333894b0d080086dc6e",
  "windows-arm64":
    "5c99cd6b900ac2038163c9a5cf8c9e6d3d5686b151d264cce8b6173ddc50a62c",
  "windows-amd64":
    "53920013d24bc9e66180f35ceeea9ddc20e65a7afa883421e9c0ba60ad7457ee",
});
export function supabaseRelease(
  platform: string = process.platform,
  arch: string = process.arch,
): SupabaseRelease | undefined {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "amd64" : arch;
  const target = `${os}-${cpu}`;
  const sha256 = checksums[target];
  if (!sha256) return undefined;
  return Object.freeze({
    version: SUPABASE_CLI_VERSION,
    target,
    binary: os === "windows" ? "supabase.exe" : "supabase",
    url: `https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_${os}_${cpu}.tar.gz`,
    sha256,
  });
}
