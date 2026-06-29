// src/cli/instances.ts
import { homedir } from "node:os";
import { resolveConfigPath } from "../core/config/path.js";
import { readRawConfig, type RawConfig } from "./config-file.js";
import { CoolifyError } from "../core/errors.js";

type Out = (line: string) => void;

function flag(v: unknown): string { return v === true ? "on" : "off"; }

function listInstances(raw: RawConfig | null, env: Record<string, string | undefined>, out: Out): number {
  if (!raw) {
    if (env.COOLIFY_BASE_URL) {
      out("No config file — using environment variables (single 'default' instance):");
      out(`  * default  ${env.COOLIFY_BASE_URL}`);
    } else {
      out("No config file and COOLIFY_BASE_URL is not set. Run 'coolify-mcp init'.");
    }
    return 0;
  }
  const instances = (raw.instances ?? {}) as Record<string, Record<string, unknown>>;
  const def = typeof raw.defaultInstance === "string" ? raw.defaultInstance : undefined;
  const names = Object.keys(instances);
  if (names.length === 0) { out("Config file has no instances."); return 0; }
  out("instances (* = default):");
  for (const name of names) {
    const i = instances[name] ?? {};
    const mark = name === def ? "*" : " ";
    out(`  ${mark} ${name}  ${String(i.baseUrl ?? "")}  host-ops:${flag(i.enableHostOps)}  destructive:${flag(i.allowDestructive)}`);
  }
  return 0;
}

export async function runInstances(
  argv: string[],
  env: Record<string, string | undefined>,
  out: Out,
  deps: { home?: string } = {},
): Promise<number> {
  const home = deps.home ?? homedir();
  const path = resolveConfigPath(argv, env, home);
  const positional = argv.filter((a, idx) => !a.startsWith("--") && argv[idx - 1] !== "--config");
  const action = positional[0] ?? "list";
  try {
    const raw = readRawConfig(path);
    switch (action) {
      case "list":
        return listInstances(raw, env, out);
      default:
        out(`Unknown action '${action}'. Usage: coolify-mcp instances [list|default <name>|rm <name>]`);
        return 1;
    }
  } catch (e) {
    out(`error: ${e instanceof CoolifyError ? e.message : e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
