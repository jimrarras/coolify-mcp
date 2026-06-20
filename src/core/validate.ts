// src/core/validate.ts
import { CoolifyError } from "./errors.js";

// Coolify UUIDs are NOT RFC-4122; they are purely alphanumeric.
export const COOLIFY_UUID_RE: RegExp = /^[A-Za-z0-9]+$/;

export function assertCoolifyUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !COOLIFY_UUID_RE.test(value)) {
    throw new CoolifyError(
      "invalid_input",
      `Field "${field}" must be a non-empty alphanumeric Coolify UUID; got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// A server reference may be a Coolify UUID OR a human server NAME (ssh_exec/docker_op
// document and the resolver supports "UUID or name"). Names commonly contain '-', '_',
// or '.', so the strict alphanumeric UUID rule wrongly rejects them. Allow those while
// still refusing anything URL-/shell-unsafe: must start with an alnum/underscore, no
// path traversal ('..'), and no metacharacters/whitespace/slashes. The value is
// encodeURIComponent'd in the API path and never reaches a shell, so this is purely a
// usability widening, not a relaxation of a load-bearing guard.
export const COOLIFY_SERVER_REF_RE: RegExp = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
export function assertCoolifyServerRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !COOLIFY_SERVER_REF_RE.test(value) || value.includes("..")) {
    throw new CoolifyError(
      "invalid_input",
      `Field "${field}" must be a Coolify server UUID or name ` +
        `(letters, digits, '.', '-', '_'; no '..' or leading dot/dash); got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// A Coolify API token is "<id>|<secret>": an integer id, a pipe, then a non-empty
// secret. Shared by the env-fallback path and the config-file path so a malformed
// token fails fast at load time on both, rather than as a late opaque 401.
export function assertCoolifyTokenFormat(token: string, label = "token"): void {
  const pipeIdx = token.indexOf("|");
  if (pipeIdx <= 0 || pipeIdx === token.length - 1 || !/^\d+$/.test(token.slice(0, pipeIdx))) {
    throw new CoolifyError(
      "invalid_input",
      `${label} must be "<id>|<secret>" where <id> is an integer`,
    );
  }
}
