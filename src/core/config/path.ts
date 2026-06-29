import { join } from "node:path";

/**
 * Resolves the active config-file path that `init`/`instances` read and write.
 * Precedence: --config <path>  →  COOLIFY_CONFIG  →  <home>/.coolify-mcp/config.json.
 * (Unlike loadConfig, the home default is always returned as the write target,
 * even when the file does not yet exist. This also guards the --config value
 * against a following flag, where loadConfig consumes the next token
 * unconditionally — the divergence is intentional and only differs on the
 * degenerate `--config --something` input.)
 */
export function resolveConfigPath(
  argv: string[],
  env: Record<string, string | undefined>,
  home: string,
): string {
  const i = argv.indexOf("--config");
  if (i !== -1) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) return next;
  }
  if (env.COOLIFY_CONFIG) return env.COOLIFY_CONFIG;
  return join(home, ".coolify-mcp", "config.json");
}
