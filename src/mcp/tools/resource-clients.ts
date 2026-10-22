// Shared sub-client resolver for the resource tools. The applications, databases,
// and services API sub-clients implement a common surface (get/update/control/
// delete + storage/env/scheduled-task ops), so a single typed union resolver
// replaces the near-identical pick*Client helpers that used to live in each tool.
import { err, toErrorResult } from '../../core/errors.js';
import { assertCoolifyUuid } from '../../core/validate.js';
import type { ToolResult } from '../../core/errors.js';
import type { CoolifyApiClient } from '../../core/api/client.js';

export type ResourceSubClient =
  | CoolifyApiClient['applications']
  | CoolifyApiClient['databases']
  | CoolifyApiClient['services'];

// Narrower union for tools that exclude databases (e.g. scheduled tasks, which
// only applications and services support).
export type AppOrServiceSubClient = CoolifyApiClient['applications'] | CoolifyApiClient['services'];

const RESOURCE_TYPES = ['applications', 'databases', 'services'] as const;

/**
 * Picks the applications/databases/services sub-client for a `type` discriminator.
 * Returns null when the type is not one of the three.
 */
export function pickResourceClient(api: CoolifyApiClient, type: string): ResourceSubClient | null {
  if (type === 'applications') return api.applications;
  if (type === 'databases') return api.databases;
  if (type === 'services') return api.services;
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
  if (typeof type !== 'string') {
    return err('invalid_input', `\`type\` must be a string: ${allowed.join(' | ')}`);
  }
  let uuid: string;
  try {
    uuid = assertCoolifyUuid(args.uuid, 'uuid');
  } catch (e) {
    return toErrorResult(e);
  }
  const sub = allowed.includes(type) ? pickResourceClient(api, type) : null;
  if (!sub) {
    return err(
      'invalid_input',
      `Unknown resource type "${type}". Must be one of: ${allowed.join(', ')}`,
    );
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
export function bodyWithout(
  args: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  const drop = new Set<string>(['confirm', 'dry_run', ...keys]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!drop.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Builds a request body for tools with a declared pass-through channel. Strict MCP
 * clients rewrite open inputSchemas to additionalProperties:false and silently strip
 * undeclared TOP-LEVEL args, so body fields must travel inside a declared property:
 * `fields` (an object, kept by strict clients because it is declared) or `fields_json`
 * (a JSON-encoded string, immune even to clients that recursively empty nested open
 * objects). The two are mutually exclusive. Top-level extras (minus confirm/dry_run
 * and the named discriminators) still work on permissive clients; the pass-through
 * wins on a key conflict. Returns an invalid_input ToolResult when the pass-through
 * is malformed — discriminate with `"body" in r`.
 */
export function buildFieldsBody(
  args: Record<string, unknown>,
  ...keys: string[]
): { body: Record<string, unknown> } | ToolResult {
  const { fields, fields_json } = args;
  if (fields !== undefined && fields_json !== undefined) {
    return err(
      'invalid_input',
      '`fields` and `fields_json` are mutually exclusive — provide exactly one.',
    );
  }
  let passthrough: Record<string, unknown> | undefined;
  if (fields !== undefined) {
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      return err('invalid_input', '`fields` must be an object mapping field names to new values.');
    }
    passthrough = fields as Record<string, unknown>;
  } else if (fields_json !== undefined) {
    if (typeof fields_json !== 'string') {
      return err('invalid_input', '`fields_json` must be a JSON-encoded object string.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields_json);
    } catch {
      return err('invalid_input', '`fields_json` is not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err(
        'invalid_input',
        '`fields_json` must encode a JSON object, e.g. \'{"name":"new-name"}\'.',
      );
    }
    passthrough = parsed as Record<string, unknown>;
  }
  return { body: { ...bodyWithout(args, 'fields', 'fields_json', ...keys), ...passthrough } };
}

/**
 * The schema properties for the `fields`/`fields_json` pass-through channel.
 * `what` describes the payload for the property descriptions (e.g. "storage fields").
 */
export function fieldsPassthroughProps(what: string): Record<string, unknown> {
  return {
    fields: {
      type: 'object',
      description: `${what}, sent verbatim as the request body — any field the Coolify endpoint accepts is allowed.`,
      additionalProperties: true,
    },
    fields_json: {
      type: 'string',
      description: `JSON-encoded alternative to \`fields\` (mutually exclusive) for clients whose strict schema handling strips free-form object contents.`,
    },
  };
}
