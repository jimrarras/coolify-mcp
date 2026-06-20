// src/core/redact.ts

// Matches object keys that likely contain secrets.
// Case-insensitive via .test() with the /i flag.
// Notes:
//   - \benv\b matches the standalone word "env" but NOT "environment", "env_id",
//     "environment_name", "envs", etc. (word-boundary anchors prevent over-matching).
//   - Buffer values under sensitive keys are also redacted (not just strings).
export const SENSITIVE_KEY_RE: RegExp =
  /passphrase|password|\bpass\b|_pass\b|secret|token|api.?key|private.?key|access.?key|encryption.?key|dsn|connection|\benv\b|app.?key|authorization|bearer|database.?url|credential/i;

const REDACTED = "***REDACTED***";

/**
 * Best-effort masking of credentials embedded inline in a shell command string
 * (passwords, bearer tokens, PG/connection passwords). This is NOT exhaustive —
 * arbitrary credential forms cannot all be detected — so it is used only to
 * reduce exposure in the ssh_exec audit line and dry-run preview; callers should
 * still avoid putting secrets in command strings. Returns the command with
 * matched secret substrings replaced by ***.
 */
export function scrubInlineSecrets(command: string, opts?: { shortPasswordFlag?: boolean }): string {
  let out = command
    .replace(/(PGPASSWORD=)\S+/gi, "$1***")
    .replace(/(MYSQL_PWD=)\S+/gi, "$1***")
    .replace(/(--password[=\s]+)\S+/gi, "$1***");
  // The bare `-p<value>` (mysql-style) rule over-matches benign tokens such as
  // `-platform`, `-progress`, or `-p8080:80`, so it is only applied to known
  // shell-command contexts (the ssh_exec/docker_op audit line), NOT to free-text
  // error messages where it would corrupt diagnostics. Default on for back-compat.
  if (opts?.shortPasswordFlag !== false) {
    out = out.replace(/(?<![\w-])(-p)([^\s-]\S*)/g, "$1***");
  }
  return out
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1***")
    .replace(/((?:api[_-]?key|token|secret|access[_-]?key|passphrase|password)\s*[=:]\s*)\S+/gi, "$1***");
}

/**
 * Deep-clones `value`, replacing string and Buffer values under sensitive keys
 * with REDACTED. Never throws — any error during cloning returns the value as-is.
 */
export function redact(value: unknown): unknown {
  try {
    return _redact(value);
  } catch {
    return value;
  }
}

function isSensitiveValue(v: unknown): boolean {
  if (typeof v === "string") return true;
  // Buffer (Node.js) — check via duck-typing so this works in ESM without importing 'buffer'
  if (v instanceof Uint8Array) return true;
  return false;
}

function _redact(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => _redact(item));
  }
  if (typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k) && isSensitiveValue(v)) {
        copy[k] = REDACTED;
      } else {
        copy[k] = _redact(v);
      }
    }
    return copy;
  }
  // Primitive (string, number, boolean, etc.)
  return value;
}
