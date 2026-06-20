import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CoolifyError } from "../errors.js";
import { expandEnvRefs, expandHome } from "./env-expand.js";
import { validateAppConfig, type AppConfig } from "./schema.js";
import { assertCoolifyTokenFormat } from "../validate.js";

interface Flags { configPath?: string; enableHostOps: boolean; allowDestructive: boolean; extraHeaders: Record<string, string>; }

// Thrown when no config source exists at all (no file + no COOLIFY_BASE_URL). The
// CLI recognizes this to print actionable setup guidance instead of a stack trace.
export const MISSING_CONFIG_MESSAGE = "No config file found and COOLIFY_BASE_URL is not set";

/** True when the error is the "nothing is configured yet" case (vs a malformed config). */
export function isMissingConfigError(e: unknown): boolean {
  return e instanceof CoolifyError && e.message === MISSING_CONFIG_MESSAGE;
}

function parseFlags(argv: string[], env: Record<string, string | undefined>): Flags {
  const f: Flags = { enableHostOps: false, allowDestructive: false, extraHeaders: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--enable-host-ops") f.enableHostOps = true;
    else if (a === "--allow-destructive") f.allowDestructive = true;
    else if (a === "--config") { f.configPath = argv[++i]; }
    else if (a === "--header") {
      const raw = argv[++i];
      if (raw === undefined || raw.startsWith("--")) throw new CoolifyError("invalid_input", '--header requires a "Key: Value" value');
      const ci = raw.indexOf(":");
      if (ci === -1) throw new CoolifyError("invalid_input", `--header must be "Key: Value" (got: ${raw})`);
      const k = raw.slice(0, ci).trim(); const v = raw.slice(ci + 1).trim();
      if (k.toLowerCase() === "authorization" || k.toLowerCase() === "host") {
        throw new CoolifyError("invalid_input", `--header may not override "${k}"`);
      }
      f.extraHeaders[k] = v;
    }
  }
  if (!f.configPath && env.COOLIFY_CONFIG) f.configPath = env.COOLIFY_CONFIG;
  return f;
}

function deepExpand(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") return expandEnvRefs(value, env);
  if (Array.isArray(value)) return value.map((v) => deepExpand(v, env));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepExpand(v, env);
    return out;
  }
  return value;
}

function resolveSshPaths(cfg: AppConfig, home: string | undefined): void {
  for (const inst of Object.values(cfg.instances)) {
    if (inst.ssh) {
      inst.ssh.keyPath = expandHome(inst.ssh.keyPath, home);
      if (inst.ssh.knownHostsPath) inst.ssh.knownHostsPath = expandHome(inst.ssh.knownHostsPath, home);
    }
  }
}

function fromEnvFallback(flags: Flags, env: Record<string, string | undefined>): AppConfig {
  const baseUrl = env.COOLIFY_BASE_URL;
  if (!baseUrl) throw new CoolifyError("invalid_input", MISSING_CONFIG_MESSAGE);
  const token = env.COOLIFY_TOKEN;
  if (!token) throw new CoolifyError("invalid_input", "COOLIFY_TOKEN is required");
  const raw: Record<string, unknown> = {
    instances: { default: {
      baseUrl, token, extraHeaders: flags.extraHeaders,
      enableHostOps: flags.enableHostOps, allowDestructive: flags.allowDestructive,
      pinnedCoolifyVersion: env.COOLIFY_PINNED_VERSION,
    } as Record<string, unknown> },
  };
  const inst = (raw.instances as Record<string, Record<string, unknown>>).default;
  if (flags.enableHostOps && env.COOLIFY_SSH_KEY_PATH) {
    inst.ssh = {
      keyPath: env.COOLIFY_SSH_KEY_PATH,
      host: env.COOLIFY_SSH_HOST,
      user: env.COOLIFY_SSH_USER,
      port: env.COOLIFY_SSH_PORT ? parseInt(env.COOLIFY_SSH_PORT, 10) : undefined,
      fingerprint: env.COOLIFY_SSH_KNOWN_HOST_FINGERPRINT,
      knownHostsPath: env.COOLIFY_SSH_KNOWN_HOSTS_PATH,
      passphrase: env.COOLIFY_SSH_KEY_PASSPHRASE,
      hostServer: env.COOLIFY_SSH_HOST_SERVER,
    };
  }
  if (env.COOLIFY_DB_READONLY_USER) {
    inst.db = { readonlyUser: env.COOLIFY_DB_READONLY_USER, readonlyPassword: env.COOLIFY_DB_READONLY_PASSWORD };
  }
  // token format validation: "<id>|<secret>" where <id> is an integer.
  assertCoolifyTokenFormat(token, "COOLIFY_TOKEN");
  return validateAppConfig(raw);
}

// `opts.home` overrides the home directory used to auto-discover ~/.coolify-mcp/
// config.json and to expand `~` in ssh paths. Defaults to os.homedir(); injectable
// so tests are hermetic (not contaminated by a real user config) and for embedding.
export function loadConfig(argv: string[], env: Record<string, string | undefined>, opts?: { home?: string }): AppConfig {
  const flags = parseFlags(argv, env);
  const home = opts?.home ?? homedir();
  let path = flags.configPath;
  if (!path) {
    const candidate = join(home, ".coolify-mcp", "config.json");
    if (existsSync(candidate)) path = candidate;
  }
  if (path) {
    if (flags.enableHostOps || flags.allowDestructive) {
      process.stderr.write("[coolify-mcp] WARNING: per-instance gating comes from the config file; --enable-host-ops/--allow-destructive are ignored.\n");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new CoolifyError("invalid_input", `config: failed to read/parse ${path}: ${e instanceof Error ? e.message : String(e)}`); }
    const expanded = deepExpand(parsed, env);
    const cfg = validateAppConfig(expanded);
    resolveSshPaths(cfg, home);
    return cfg;
  }
  const cfg = fromEnvFallback(flags, env);
  resolveSshPaths(cfg, home);
  return cfg;
}
