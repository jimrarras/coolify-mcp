import { ok, err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import type { ToolDef, ToolHandler } from "./types.js";

// Characters that would redirect a REST path or corrupt a URL.
const UNSAFE_ENV_RE = /[/?#%\s]/;
// Dot-segment guard: '.' and '..' survive encodeURIComponent but new URL() normalises
// them into path traversal (e.g. /projects/uuid/environments/../servers).
const DOT_SEGMENT_RE = /^\.+$/;

function assertSafeEnvironmentName(value: unknown, field: string): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "environment (name or uuid) is required";
  }
  const trimmed = value.trim();
  if (UNSAFE_ENV_RE.test(trimmed)) {
    return `${field} must not contain '/', '?', '#', '%', or whitespace (path-injection guard)`;
  }
  if (DOT_SEGMENT_RE.test(trimmed)) {
    return `${field} must not be '.' or '..' (dot-segment traversal guard)`;
  }
  return null; // valid
}

const manageProjects: ToolHandler = async (args, ctx) => {
  const action = args.action as string | undefined;

  try {
    switch (action) {
      case "list": {
        const projects = await ctx.api.projects.list();
        return ok({ projects });
      }

      case "get": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const project = await ctx.api.projects.get(uuid);
        return ok({ project });
      }

      case "create": {
        if (typeof args.name !== "string" || !args.name.trim()) {
          return err("invalid_input", "name is required and must be a non-empty string");
        }
        const body: { name: string; description?: string } = { name: args.name.trim() };
        if (typeof args.description === "string") {
          body.description = args.description;
        }
        const result = await ctx.api.projects.create(body);
        return ok({ uuid: result.uuid });
      }

      case "update": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const body: { name?: string; description?: string } = {};
        if (typeof args.name === "string") body.name = args.name;
        if (typeof args.description === "string") body.description = args.description;
        const project = await ctx.api.projects.update(uuid, body);
        return ok({ project });
      }

      case "delete": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const fenced = await checkFences(ctx.config, {
          destructive: true,
          args: destructiveArgs(args),
          preview: async () => ({ action: "delete", resource: "project", uuid }),
        });
        if (fenced !== null) return fenced;
        const result = await ctx.api.projects.delete(uuid);
        return ok({ message: result.message });
      }

      case "list_environments": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const environments = await ctx.api.projects.listEnvironments(uuid);
        return ok({ environments });
      }

      case "create_environment": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        if (typeof args.name !== "string" || !args.name.trim()) {
          return err("invalid_input", "name is required for create_environment");
        }
        const environment = await ctx.api.projects.createEnvironment(uuid, { name: args.name.trim() });
        return ok({ environment });
      }

      case "get_environment": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const envValidationError = assertSafeEnvironmentName(args.environment, "environment");
        if (envValidationError !== null) {
          return err("invalid_input", envValidationError);
        }
        const environment = await ctx.api.projects.getEnvironment(uuid, (args.environment as string).trim());
        return ok({ environment });
      }

      case "delete_environment": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const envDeleteValidationError = assertSafeEnvironmentName(args.environment, "environment");
        if (envDeleteValidationError !== null) {
          return err("invalid_input", envDeleteValidationError);
        }
        const envName = (args.environment as string).trim();
        const fenced = await checkFences(ctx.config, {
          destructive: true,
          args: destructiveArgs(args),
          preview: async () => ({ action: "delete_environment", resource: "environment", project_uuid: uuid, environment: envName }),
        });
        if (fenced !== null) return fenced;
        const result = await ctx.api.projects.deleteEnvironment(uuid, envName);
        return ok({ result });
      }

      default:
        return err(
          "invalid_input",
          `Unknown action: ${String(action)}. Valid actions: list, get, create, update, delete, list_environments, create_environment, get_environment, delete_environment`,
        );
    }
  } catch (e) {
    return toErrorResult(e);
  }
};

export const TOOLS: ToolDef[] = [
  {
    name: "manage_projects",
    description:
      "Manage Coolify projects and their environments. Actions: list, get, create, update, delete (fenced), list_environments, create_environment, get_environment, delete_environment (fenced).",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list",
            "get",
            "create",
            "update",
            "delete",
            "list_environments",
            "create_environment",
            "get_environment",
            "delete_environment",
          ],
          description: "The operation to perform.",
        },
        uuid: {
          type: "string",
          description:
            "Project UUID (required for get, update, delete, list_environments, create_environment, get_environment, delete_environment).",
        },
        name: {
          type: "string",
          description:
            "Project name (required for create; optional for update) or environment name (required for create_environment).",
        },
        description: {
          type: "string",
          description: "Project description (optional for create/update).",
        },
        environment: {
          type: "string",
          description: "Environment name or UUID (required for get_environment, delete_environment).",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm destructive operations (delete, delete_environment).",
        },
        dry_run: {
          type: "boolean",
          description: "If true, show what would be deleted without performing the action (delete, delete_environment).",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      required: ["action"],
    },
    handler: manageProjects,
  },
];
