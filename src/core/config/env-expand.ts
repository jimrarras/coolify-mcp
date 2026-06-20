import { CoolifyError } from "../errors.js";

export function expandEnvRefs(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, dflt?: string) => {
    const v = env[name];
    if (v !== undefined) return v;
    if (dflt !== undefined) return dflt;
    throw new CoolifyError(
      "invalid_input",
      `Config references environment variable ${name}, but it is not set. ` +
        `Set ${name} in your environment (or your MCP client's "env" block), ` +
        `or re-run 'coolify-mcp init' to store the value directly in the config.`,
    );
  });
}

export function expandHome(p: string, home: string | undefined): string {
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}
