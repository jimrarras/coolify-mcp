// Shared sub-client resolver for the resource tools. The applications, databases,
// and services API sub-clients implement a common surface (get/update/control/
// delete + storage/env/scheduled-task ops), so a single typed union resolver
// replaces the near-identical pick*Client helpers that used to live in each tool.
import { err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import type { ToolResult } from "../../core/errors.js";
import type { CoolifyApiClient } from "../../core/api/client.js";

export type ResourceSubClient =
  | CoolifyApiClient["applications"]
  | CoolifyApiClient["databases"]
  | CoolifyApiClient["services"];

// Narrower union for tools that exclude databases (e.g. scheduled tasks, which
// only applications and services support).
export type AppOrServiceSubClient =
  | CoolifyApiClient["applications"]
  | CoolifyApiClient["services"];

const RESOURCE_TYPES = ["applications", "databases", "services"] as const;

/**
 * Picks the applications/databases/services sub-client for a `type` discriminator.
 * Returns null when the type is not one of the three.
 */
export function pickResourceClient(api: CoolifyApiClient, type: string): ResourceSubClient | null {
  if (type === "applications") return api.applications;
  if (type === "databases") return api.databases;
  if (type === "services") return api.services;
  return null;
}

export interface ResolvedResource<T extends ResourceSubClient = ResourceSubClient> {
  type: string;
  uuid: string;
  sub: T;
}

/**
 * Resolves the {type, uuid, sub-client} triple shared by every resource handler.
 * Validates that `type` is a string in `allowed` and `uuid` is a Coolify UUID,
 * returning an error ToolResult (kind invalid_input) on any failure. Pass a
 * narrower `allowed` set (e.g. ["applications","services"]) for tools that only
 * support some resource types, and the matching sub-client type as `T` (the
 * `allowed` set must correspond to `T`). Discriminate the result with `"status" in r`.
 */
export function resolveTypedResource<T extends ResourceSubClient = ResourceSubClient>(
  api: CoolifyApiClient,
  args: Record<string, unknown>,
  allowed: readonly string[] = RESOURCE_TYPES,
): ResolvedResource<T> | ToolResult {
  const type = args.type;
  if (typeof type !== "string") {
    return err("invalid_input", `\`type\` must be a string: ${allowed.join(" | ")}`);
  }
  let uuid: string;
  try {
    uuid = assertCoolifyUuid(args.uuid, "uuid");
  } catch (e) {
    return toErrorResult(e);
  }
  const sub = allowed.includes(type) ? pickResourceClient(api, type) : null;
  if (!sub) {
    return err("invalid_input", `Unknown resource type "${type}". Must be one of: ${allowed.join(", ")}`);
  }
  // Safe by construction: `allowed` (caller-supplied) constrains `type`, and the
  // caller declares the corresponding `T`. pickResourceClient returns the wide union.
  return { type, uuid, sub: sub as T };
}

/**
 * Builds a request body from a handler's args, dropping the fencing-only fields
 * (confirm/dry_run) plus the named discriminators — Coolify's create/update
 * endpoints reject unknown fields with HTTP 422.
 */
export function bodyWithout(args: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const drop = new Set<string>(["confirm", "dry_run", ...keys]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!drop.has(k)) out[k] = v;
  }
  return out;
}
