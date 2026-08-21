// Field-level editing rules for `instances set/unset`: the whitelist of dotted
// paths, per-field validation/coercion, secret redaction, and the block
// invariants (ssh needs keyPath, db needs readonlyUser) that keep an edited
// raw config loadable by the schema validator.
import { CoolifyError } from "../core/errors.js";
import { assertCoolifyTokenFormat } from "../core/validate.js";
import { isValidDbRoleName } from "./init.js";

type Kind = "string" | "secret" | "boolean" | "port" | "url" | "token" | "dbrole";

/** Settable dotted field -> value kind. Order is the order shown in help/errors. */
export const SETTABLE_FIELDS: Record<string, Kind> = {
  baseUrl: "url",
  token: "token",
  enableHostOps: "boolean",
  allowDestructive: "boolean",
  pinnedCoolifyVersion: "string",
  "ssh.keyPath": "string",
  "ssh.host": "string",
  "ssh.hostServer": "string",
  "ssh.user": "string",
  "ssh.port": "port",
  "ssh.fingerprint": "string",
  "ssh.knownHostsPath": "string",
  "ssh.passphrase": "secret",
  "db.readonlyUser": "dbrole",
  "db.readonlyPassword": "secret",
};

export const SECRET_FIELDS: readonly string[] = ["token", "ssh.passphrase", "db.readonlyPassword"];

/**
 * Unsettable fields: optional ones only. `ssh`/`db` remove the whole block.
 * Required members (ssh.keyPath, db.readonlyUser) are deliberately absent —
 * removing them would leave a block the schema rejects.
 */
export const UNSETTABLE_FIELDS: ReadonlySet<string> = new Set([
  "pinnedCoolifyVersion",
  "ssh", "ssh.host", "ssh.hostServer", "ssh.user", "ssh.port", "ssh.fingerprint", "ssh.knownHostsPath", "ssh.passphrase",
  "db", "db.readonlyPassword",
]);

export function isEnvRef(v: unknown): boolean {
  return typeof v === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
}

function bad(msg: string): never {
  throw new CoolifyError("invalid_input", msg);
}

export function parseFieldValue(field: string, raw: string): string | number | boolean {
  const kind = SETTABLE_FIELDS[field];
  if (!kind) bad(`Unknown field '${field}'. Settable fields: ${Object.keys(SETTABLE_FIELDS).join(", ")}`);
  switch (kind) {
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["true", "on", "1", "yes"].includes(v)) return true;
      if (["false", "off", "0", "no"].includes(v)) return false;
      bad(`'${field}' expects true/false (also accepts on/off, 1/0).`);
      break;
    }
    case "port": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) bad(`'${field}' expects a port number 1-65535.`);
      return n;
    }
    case "url": {
      let u: URL;
      try { u = new URL(raw); } catch { bad(`'${field}' expects an http(s) URL.`); }
      if (u.protocol !== "http:" && u.protocol !== "https:") bad(`'${field}' expects an http(s) URL.`);
      return raw.replace(/\/+$/, "");
    }
    case "token": {
      if (isEnvRef(raw)) return raw;
      assertCoolifyTokenFormat(raw, field);
      return raw;
    }
    case "dbrole": {
      if (!isValidDbRoleName(raw)) bad(`'${field}' must be a valid Postgres role name (letters, digits, underscores; not digit-led).`);
      return raw;
    }
    case "secret":
    case "string": {
      if (raw === "") bad(`'${field}' cannot be empty.`);
      return raw;
    }
  }
}

/** The parent block ("ssh"/"db") a dotted field lives in, or null for top-level. */
function blockOf(field: string): "ssh" | "db" | null {
  if (field.startsWith("ssh.")) return "ssh";
  if (field.startsWith("db.")) return "db";
  return null;
}

/** Fields allowed to CREATE their block (the block's schema-required member). */
const BLOCK_CREATORS: Record<string, string> = { ssh: "ssh.keyPath", db: "db.readonlyUser" };

export function setField(inst: Record<string, unknown>, field: string, value: unknown): { old: unknown } {
  if (!SETTABLE_FIELDS[field]) bad(`Unknown field '${field}'. Settable fields: ${Object.keys(SETTABLE_FIELDS).join(", ")}`);
  const block = blockOf(field);
  if (!block) {
    const old = inst[field];
    inst[field] = value;
    return { old };
  }
  const key = field.slice(block.length + 1);
  let obj = inst[block];
  if (obj === undefined || obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    if (BLOCK_CREATORS[block] !== field) {
      bad(`Instance has no '${block}' block yet — set ${BLOCK_CREATORS[block]} first.`);
    }
    obj = {};
    inst[block] = obj;
  }
  const rec = obj as Record<string, unknown>;
  const old = rec[key];
  rec[key] = value;
  return { old };
}

export function unsetField(inst: Record<string, unknown>, field: string): { old: unknown } {
  if (!UNSETTABLE_FIELDS.has(field)) {
    if (field === "ssh.keyPath" || field === "db.readonlyUser") {
      const block = blockOf(field)!;
      bad(`'${field}' is required while the block exists — unset the whole '${block}' block instead.`);
    }
    if (field in SETTABLE_FIELDS) bad(`Cannot unset required field '${field}'.`);
    bad(`Unknown or non-optional field '${field}'. Unsettable: ${[...UNSETTABLE_FIELDS].join(", ")}`);
  }
  const block = blockOf(field);
  if (!block) {
    const old = inst[field];
    delete inst[field];
    return { old };
  }
  const key = field.slice(block.length + 1);
  const obj = inst[block];
  if (obj === undefined || obj === null || typeof obj !== "object" || Array.isArray(obj)) return { old: undefined };
  const rec = obj as Record<string, unknown>;
  const old = rec[key];
  delete rec[key];
  return { old };
}

/** Display form of a field value: secrets redacted, ${ENV} refs verbatim. */
export function redactValue(field: string, value: unknown): string {
  if (value === undefined) return "(unset)";
  // Whole blocks (ssh/db) may hold secrets — never stringify them.
  if (value !== null && typeof value === "object") return "(configured)";
  const s = String(value);
  if (!SECRET_FIELDS.includes(field)) return s;
  if (isEnvRef(s)) return s;
  if (field === "token") {
    const pipe = s.indexOf("|");
    const id = pipe > 0 ? s.slice(0, pipe) : "?";
    return s.length - pipe - 1 > 8 ? `${id}|****${s.slice(-4)}` : `${id}|****`;
  }
  return s.length > 8 ? `****${s.slice(-4)}` : "****";
}
