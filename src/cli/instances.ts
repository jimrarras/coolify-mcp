// src/cli/instances.ts
import { homedir } from "node:os";
import { resolveConfigPath } from "../core/config/path.js";
import { readRawConfig, writeRawConfig, type RawConfig } from "./config-file.js";
import { CoolifyError } from "../core/errors.js";
import { parseFieldValue, setField, unsetField, redactValue, SECRET_FIELDS } from "./fields.js";
import { makeVerifier, type VerifyFn } from "./verify.js";

type Out = (line: string) => void;
type MaskedIO = { promptMasked(q: string): Promise<string>; close?(): void };

function flag(v: unknown): string { return v === true ? "on" : "off"; }

function requireFile(raw: RawConfig | null): RawConfig {
  if (!raw) throw new CoolifyError("invalid_input", "No config file to edit. Run 'coolify-mcp init' to create one.");
  return raw;
}
function instancesOf(raw: RawConfig): Record<string, unknown> {
  return (raw.instances && typeof raw.instances === "object" && !Array.isArray(raw.instances) ? raw.instances : {}) as Record<string, unknown>;
}
function requireKnown(instances: Record<string, unknown>, name: string | undefined): string {
  if (!name) throw new CoolifyError("invalid_input", "An instance name is required.");
  if (instances[name] === undefined) {
    throw new CoolifyError("invalid_input", `Unknown instance '${name}'; known: ${Object.keys(instances).join(", ") || "(none)"}`);
  }
  return name;
}

function removeInstance(path: string, raw: RawConfig | null, name: string | undefined, out: Out): number {
  const cfg = requireFile(raw);
  const instances = instancesOf(cfg);
  const target = requireKnown(instances, name);
  const names = Object.keys(instances);
  if (names.length === 1) {
    out("error: cannot remove the only instance — a config must define at least one.");
    return 1;
  }
  const isDefault = cfg.defaultInstance === target;
  const remaining = names.filter((n) => n !== target);
  if (isDefault && remaining.length > 1) {
    out(`error: '${target}' is the default; set a new default first: coolify-mcp instances default <name>`);
    out(`       remaining: ${remaining.join(", ")}`);
    return 1;   // no write — file unchanged
  }
  const next = { ...instances };
  delete next[target];
  cfg.instances = next;
  let note = "";
  if (isDefault) { cfg.defaultInstance = remaining[0]; note = ` (default is now '${remaining[0]}')`; }
  writeRawConfig(path, cfg);
  out(`✓ removed instance '${target}'${note}`);
  return 0;
}

function setDefault(path: string, raw: RawConfig | null, name: string | undefined, out: Out): number {
  const cfg = requireFile(raw);
  const instances = instancesOf(cfg);
  const target = requireKnown(instances, name);
  cfg.defaultInstance = target;
  writeRawConfig(path, cfg);
  out(`✓ default instance is now '${target}'`);
  return 0;
}

/** Does any string field of this (raw, unexpanded) instance use a ${ENV} reference? */
function usesEnvRefs(v: unknown): boolean {
  if (typeof v === "string") return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v);
  if (Array.isArray(v)) return v.some(usesEnvRefs);
  if (v !== null && typeof v === "object") return Object.values(v).some(usesEnvRefs);
  return false;
}

function listInstances(path: string, raw: RawConfig | null, env: Record<string, string | undefined>, out: Out): number {
  if (!raw) {
    if (env.COOLIFY_BASE_URL) {
      out("No config file — using environment variables (single 'default' instance):");
      out(`  * default  ${env.COOLIFY_BASE_URL}`);
    } else {
      out("No config file and COOLIFY_BASE_URL is not set. Run 'coolify-mcp init'.");
    }
    return 0;
  }
  const instances = instancesOf(raw);
  const def = typeof raw.defaultInstance === "string" ? raw.defaultInstance : undefined;
  const names = Object.keys(instances);
  if (names.length === 0) { out("Config file has no instances."); return 0; }
  out(`config: ${path}`);
  out("instances (* = default):");
  const nameW = Math.max(...names.map((n) => n.length));
  const urlW = Math.max(...names.map((n) => String((instances[n] as Record<string, unknown>).baseUrl ?? "").length));
  for (const name of names) {
    const i = instances[name] as Record<string, unknown>;
    const mark = name === def ? "*" : " ";
    const cols = [
      `${mark} ${name.padEnd(nameW)}`,
      String(i.baseUrl ?? "").padEnd(urlW),
      `host-ops:${flag(i.enableHostOps)}`,
      `destructive:${flag(i.allowDestructive)}`,
      `ssh:${i.ssh ? "✓" : "—"}`,
      `db:${i.db ? "✓" : "—"}`,
    ];
    if (usesEnvRefs(i)) cols.push("env-refs:✓");
    out(`  ${cols.join("  ")}`);
  }
  return 0;
}

/** After a successful write: report the change (redacted) and verify the instance still works. */
async function reportAndVerify(
  ctx: { path: string; name: string; verify: VerifyFn; noVerify: boolean; out: Out },
  instRaw: Record<string, unknown>,
  changeLine: string,
  sshChanged: boolean,
): Promise<number> {
  ctx.out(changeLine);
  if (ctx.noVerify) return 0;
  const r = await ctx.verify(ctx.name, instRaw, { sshChanged });
  if ("skipped" in r) {
    ctx.out(`verification skipped: ${r.skipped}`);
    return 0;
  }
  if (r.ok) {
    ctx.out(`✓ verified '${ctx.name}' — ${r.detail}`);
    return 0;
  }
  ctx.out(`⚠ verification failed: ${r.detail}`);
  ctx.out(`  The change was saved anyway. Previous config: ${ctx.path}.bak`);
  return 1;
}

function setInstanceField(
  ctx: { path: string; raw: RawConfig | null; verify: VerifyFn; noVerify: boolean; out: Out; io?: MaskedIO },
  name: string | undefined,
  field: string | undefined,
  rawValue: string | undefined,
): Promise<number> {
  const cfg = requireFile(ctx.raw);
  const instances = instancesOf(cfg);
  const target = requireKnown(instances, name);
  if (!field) throw new CoolifyError("invalid_input", "Usage: coolify-mcp instances set <name> <field> [value]");
  return (async () => {
    let value = rawValue;
    if (value === undefined) {
      if (!SECRET_FIELDS.includes(field) || !ctx.io) {
        throw new CoolifyError("invalid_input", `A value is required for '${field}'.`);
      }
      value = await ctx.io.promptMasked(`New value for ${target}.${field}`);
    }
    const parsed = parseFieldValue(field, value);
    const inst = instances[target] as Record<string, unknown>;
    const { old } = setField(inst, field, parsed);
    writeRawConfig(ctx.path, cfg);
    const line = `✓ ${target}.${field}: ${redactValue(field, old)} → ${redactValue(field, parsed)}`;
    return reportAndVerify({ ...ctx, name: target }, inst, line, field.startsWith("ssh."));
  })();
}

async function unsetInstanceField(
  ctx: { path: string; raw: RawConfig | null; verify: VerifyFn; noVerify: boolean; out: Out },
  name: string | undefined,
  field: string | undefined,
): Promise<number> {
  const cfg = requireFile(ctx.raw);
  const instances = instancesOf(cfg);
  const target = requireKnown(instances, name);
  if (!field) throw new CoolifyError("invalid_input", "Usage: coolify-mcp instances unset <name> <field>");
  const inst = instances[target] as Record<string, unknown>;
  const { old } = unsetField(inst, field);
  writeRawConfig(ctx.path, cfg);
  const line = `✓ ${target}.${field}: ${redactValue(field, old)} → (unset)`;
  return reportAndVerify({ ...ctx, name: target }, inst, line, field === "ssh" || field.startsWith("ssh."));
}

export async function runInstances(
  argv: string[],
  env: Record<string, string | undefined>,
  out: Out,
  deps: { home?: string; io?: MaskedIO; verify?: VerifyFn } = {},
): Promise<number> {
  const home = deps.home ?? homedir();
  const path = resolveConfigPath(argv, env, home);
  const positional = argv.filter((a, idx) => !a.startsWith("--") && argv[idx - 1] !== "--config");
  const action = positional[0] ?? "list";
  const noVerify = argv.includes("--no-verify");
  const verify = deps.verify ?? makeVerifier(env, home);
  try {
    const raw = readRawConfig(path);
    switch (action) {
      case "list":
        return listInstances(path, raw, env, out);
      case "default":
        return setDefault(path, raw, positional[1], out);
      case "rm":
      case "remove":
        return removeInstance(path, raw, positional[1], out);
      case "set":
        return await setInstanceField({ path, raw, verify, noVerify, out, io: deps.io }, positional[1], positional[2], positional[3]);
      case "unset":
        return await unsetInstanceField({ path, raw, verify, noVerify, out }, positional[1], positional[2]);
      case "edit": {
        const { editInstance } = await import("./edit.js");
        const { defaultIO } = await import("./io.js");
        const io = (deps.io as import("./io.js").IO | undefined) ?? defaultIO;
        try {
          return await editInstance(
            { path, raw, verify, noVerify, out, io, write: (cfg) => writeRawConfig(path, cfg) },
            positional[1],
          );
        } finally {
          io.close?.();
        }
      }
      default:
        out(`Unknown action '${action}'. Usage: coolify-mcp instances [list|default <name>|rm <name>|set <name> <field> [value]|unset <name> <field>|edit <name>]`);
        return 1;
    }
  } catch (e) {
    out(`error: ${e instanceof CoolifyError ? e.message : e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
