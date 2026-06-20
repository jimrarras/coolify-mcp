// src/mcp/tools/env.ts
import { ok, err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import { resolveTypedResource } from "./resource-clients.js";
import type { ToolDef, ToolHandler } from "./types.js";
import type { EnvVar } from "../../core/api/applications.js";

/**
 * Checks whether any env value in the list looks redacted or empty,
 * warranting a hint to the caller.
 *
 * "Looks redacted" means: empty string, or a value that is entirely
 * asterisks/REDACTED markers (Coolify and other tools use "***REDACTED***").
 */
function hasRedactedValues(envs: EnvVar[]): boolean {
  return envs.some((e) => {
    const v = e.value ?? "";
    return v === "" || /^\*+$/.test(v) || /redacted/i.test(v);
  });
}

const manageEnvHandler: ToolHandler = async (args, ctx) => {
  try {
    const resolved = resolveTypedResource(ctx.api, args);
    if ("status" in resolved) return resolved;
    const { type, uuid, sub } = resolved;
    const action = args.action as string | undefined;

    if (!action || !["list", "set", "delete"].includes(action)) {
      return err("invalid_input", "`action` must be one of: list, set, delete");
    }

    if (action === "list") {
      const envs = await sub.listEnvs(uuid);
      const envelope: Record<string, unknown> = { envs };
      if (hasRedactedValues(envs)) {
        envelope.redaction_hint = true;
      }
      return ok(envelope);
    }

    if (action === "set") {
      // Two calling conventions:
      //   1. Single var: { key, value }
      //   2. Bulk array: { vars: [{ key, value }, ...] }
      const key = args.key as string | undefined;
      const value = args.value as string | undefined;
      const vars = args.vars;

      let pairs: { key: string; value: string }[];

      if (vars !== undefined) {
        if (!Array.isArray(vars)) {
          return err("invalid_input", "`vars` must be an array of { key, value } objects when provided.");
        }
        // Validate each entry has key and value strings
        for (let i = 0; i < vars.length; i++) {
          const item = vars[i] as Record<string, unknown>;
          if (typeof item.key !== "string" || typeof item.value !== "string") {
            return err("invalid_input", `Each entry in \`vars\` must have string \`key\` and \`value\`. Entry ${i} is invalid.`);
          }
        }
        pairs = vars as { key: string; value: string }[];
      } else if (typeof key === "string" && typeof value === "string") {
        pairs = [{ key, value }];
      } else {
        return err(
          "invalid_input",
          "For action=set provide either { key, value } for a single var, or { vars: [{ key, value }, ...] } for bulk.",
        );
      }

      const result = await sub.upsertEnvsBulk(uuid, pairs);
      return ok({ result });
    }

    if (action === "delete") {
      const envUuid = args.env_uuid;
      if (typeof envUuid !== "string" || envUuid.trim() === "") {
        return err("invalid_input", "`env_uuid` is required for action=delete.");
      }
      // env_uuid comes from the Coolify API which returns standard UUIDs for envs;
      // we validate with assertCoolifyUuid so the constraint is consistent.
      const validatedEnvUuid = assertCoolifyUuid(envUuid, "env_uuid");
      const fenced = await checkFences(ctx.config, {
        destructive: true,
        args: destructiveArgs(args),
        preview: async () => ({ action: "delete_env", type, uuid, env_uuid: validatedEnvUuid }),
      });
      if (fenced !== null) return fenced;
      const result = await sub.deleteEnv(uuid, validatedEnvUuid);
      return ok({ result });
    }

    // Unreachable — the action check above covers all cases, but satisfies TypeScript.
    return err("invalid_input", "`action` must be one of: list, set, delete");
  } catch (e) {
    return toErrorResult(e);
  }
};

export const TOOLS: ToolDef[] = [
  {
    name: "manage_env",
    description:
      "Manage environment variables for a Coolify resource (application, database, or service). " +
      "action=list returns all vars with a redaction_hint when any value appears empty or masked. " +
      "action=set upserts one var ({ key, value }) or many ({ vars: [{key,value},...] }) via bulk API. " +
      "action=delete (fenced) removes a single var by its env_uuid (UUID returned from list); requires --allow-destructive and confirm:true.",
    inputSchema: {
      type: "object",
      required: ["type", "uuid", "action"],
      properties: {
        type: {
          type: "string",
          enum: ["applications", "databases", "services"],
          description: "The resource type.",
        },
        uuid: {
          type: "string",
          description: "The Coolify UUID of the resource.",
        },
        action: {
          type: "string",
          enum: ["list", "set", "delete"],
          description: "Operation to perform on environment variables.",
        },
        key: {
          type: "string",
          description: "Variable name. Required for action=set with a single var.",
        },
        value: {
          type: "string",
          description: "Variable value. Required for action=set with a single var.",
        },
        vars: {
          type: "array",
          description: "Array of { key, value } pairs for bulk set (action=set).",
          items: {
            type: "object",
            required: ["key", "value"],
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
          },
        },
        env_uuid: {
          type: "string",
          description: "UUID of the env var to delete. Required for action=delete.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm destructive operations (action=delete).",
        },
        dry_run: {
          type: "boolean",
          description: "If true, show what would be deleted without performing the action (action=delete).",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    handler: manageEnvHandler,
    tier: "api",
  },
];
