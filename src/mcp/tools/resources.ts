import { ok, err, toErrorResult } from "../../core/errors.js";
import {
  projectList,
  APP_SUMMARY_FIELDS,
  DB_SUMMARY_FIELDS,
  SERVICE_SUMMARY_FIELDS,
} from "../../core/projection.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import { resolveTypedResource, bodyWithout } from "./resource-clients.js";
import type { ToolDef, ToolHandler } from "./types.js";
import type { DbEngine } from "../../core/api/databases.js";
import type { ControlResult } from "../../core/api/applications.js";

// Summary fields to use when projecting items from the /resources endpoint.
// The resource endpoint returns a mixed array; we project a superset of all three.
const RESOURCE_LIST_FIELDS = [
  ...new Set([...APP_SUMMARY_FIELDS, ...DB_SUMMARY_FIELDS, ...SERVICE_SUMMARY_FIELDS, "type"]),
];

const DB_ENGINES: DbEngine[] = [
  "postgresql", "mysql", "mariadb", "mongodb", "redis", "keydb", "dragonfly", "clickhouse",
];

const listResourcesHandler: ToolHandler = async (args, ctx) => {
  try {
    const raw = await ctx.api.resources();
    const typeFilter = typeof args.type === "string" ? args.type : undefined;
    const filtered = typeFilter
      ? raw.filter((r) => (r as Record<string, unknown>).type === typeFilter)
      : raw;
    const projected = projectList(
      filtered as Record<string, unknown>[],
      RESOURCE_LIST_FIELDS,
    );
    return ok({ resources: projected, total: projected.length });
  } catch (e) {
    return toErrorResult(e);
  }
};

const getResourceHandler: ToolHandler = async (args, ctx) => {
  try {
    const resolved = resolveTypedResource(ctx.api, args);
    if ("status" in resolved) return resolved;
    const { sub, uuid } = resolved;
    const resource = await sub.get(uuid);
    return ok({ resource });
  } catch (e) {
    return toErrorResult(e);
  }
};

const createResourceHandler: ToolHandler = async (args, ctx) => {
  try {
    const fenced = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({ action: "create_resource", kind: args.kind }),
    });
    if (fenced !== null) return fenced;

    const kind = args.kind;
    if (typeof kind !== "string") {
      return err("invalid_input", "`kind` is required: application | database | service");
    }

    if (kind === "application") {
      const source = args.source;
      if (typeof source !== "string") {
        return err(
          "invalid_input",
          "`source` is required for application: public | private-github-app | private-deploy-key | dockerfile | dockerimage",
        );
      }

      // Strip the discriminators AND the fencing-only fields — Coolify's create
      // endpoints reject unknown fields with HTTP 422 ("This field is not allowed.").
      const body = bodyWithout(args, "kind", "source");

      if (source === "public") {
        const r = await ctx.api.applications.createPublic(body);
        return ok({ uuid: r.uuid });
      }
      if (source === "private-github-app") {
        const r = await ctx.api.applications.createPrivateGithubApp(body);
        return ok({ uuid: r.uuid });
      }
      if (source === "private-deploy-key") {
        const r = await ctx.api.applications.createPrivateDeployKey(body);
        return ok({ uuid: r.uuid });
      }
      if (source === "dockerfile") {
        const r = await ctx.api.applications.createDockerfile(body);
        return ok({ uuid: r.uuid });
      }
      if (source === "dockerimage") {
        const r = await ctx.api.applications.createDockerimage(body);
        return ok({ uuid: r.uuid });
      }
      return err(
        "invalid_input",
        `Unknown application source "${source}". Must be one of: public, private-github-app, private-deploy-key, dockerfile, dockerimage`,
      );
    }

    if (kind === "database") {
      const engine = args.engine as string | undefined;
      if (!engine || !DB_ENGINES.includes(engine as DbEngine)) {
        return err(
          "invalid_input",
          `\`engine\` is required for database and must be one of: ${DB_ENGINES.join(", ")}`,
        );
      }
      const body = bodyWithout(args, "kind", "engine");
      const r = await ctx.api.databases.create(engine as DbEngine, body);
      return ok({ uuid: r.uuid });
    }

    if (kind === "service") {
      const serviceType = args.service_type as string | undefined;
      const dockerComposeRaw = args.docker_compose_raw as string | undefined;

      if (serviceType && dockerComposeRaw) {
        return err(
          "invalid_input",
          "`service_type` and `docker_compose_raw` are mutually exclusive — provide exactly one.",
        );
      }
      if (!serviceType && !dockerComposeRaw) {
        return err(
          "invalid_input",
          "Either `service_type` or `docker_compose_raw` (base64-encoded) is required for service.",
        );
      }

      const body = bodyWithout(args, "kind", "service_type", "docker_compose_raw");
      if (serviceType) {
        body.type = serviceType;
      } else {
        body.docker_compose_raw = dockerComposeRaw;
      }

      const r = await ctx.api.services.create(body);
      return ok({ uuid: r.uuid });
    }

    return err("invalid_input", `Unknown kind "${kind}". Must be one of: application, database, service`);
  } catch (e) {
    return toErrorResult(e);
  }
};

const VALID_CONTROL_ACTIONS = ["start", "stop", "restart"] as const;
type ControlAction = (typeof VALID_CONTROL_ACTIONS)[number];

const updateResourceHandler: ToolHandler = async (args, ctx) => {
  try {
    const resolved = resolveTypedResource(ctx.api, args);
    if ("status" in resolved) return resolved;
    const { sub, uuid } = resolved;
    const body = bodyWithout(args, "type", "uuid");
    const resource = await sub.update(uuid, body);
    return ok({ resource });
  } catch (e) {
    return toErrorResult(e);
  }
};

const controlResourceHandler: ToolHandler = async (args, ctx) => {
  try {
    const resolved = resolveTypedResource(ctx.api, args);
    if ("status" in resolved) return resolved;
    const { type, uuid, sub } = resolved;
    const action = args.action as string | undefined;
    if (!action || !VALID_CONTROL_ACTIONS.includes(action as ControlAction)) {
      return err(
        "invalid_input",
        `\`action\` must be one of: ${VALID_CONTROL_ACTIONS.join(", ")}`,
      );
    }

    const typedAction = action as ControlAction;

    // stop and restart are destructive (they interrupt running workloads); fence them.
    if (typedAction === "stop" || typedAction === "restart") {
      const fenced = await checkFences(ctx.config, {
        destructive: true,
        args: destructiveArgs(args),
        preview: async () => ({ action: typedAction, type, uuid }),
      });
      if (fenced !== null) return fenced;
    }

    let result: ControlResult;

    // Applications support instant_deploy; databases and services do not
    if (type === "applications") {
      const instantDeploy = args.instant_deploy as boolean | undefined;
      result = await ctx.api.applications.control(uuid, typedAction, { instant_deploy: instantDeploy });
    } else {
      result = await sub.control(uuid, typedAction);
    }

    const envelope: Record<string, unknown> = { message: result.message };
    if (result.deployment_uuid !== undefined) {
      envelope.deployment_uuid = result.deployment_uuid;
    }
    return ok(envelope);
  } catch (e) {
    return toErrorResult(e);
  }
};

const deleteResourceHandler: ToolHandler = async (args, ctx) => {
  try {
    const resolved = resolveTypedResource(ctx.api, args);
    if ("status" in resolved) return resolved;
    const { type, uuid, sub } = resolved;

    const fence = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({ action: "delete", type, uuid }),
    });
    if (fence !== null) return fence;

    const result = await sub.delete(uuid);
    return ok({ message: result.message });
  } catch (e) {
    return toErrorResult(e);
  }
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_resources",
    description:
      "List all Coolify resources (applications, databases, services) across all projects. Optionally filter by type.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["applications", "databases", "services"],
          description: "Optional filter by resource type.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    handler: listResourcesHandler,
    tier: "api",
  },
  {
    name: "get_resource",
    description:
      "Get full details of a specific Coolify resource by type and UUID.",
    inputSchema: {
      type: "object",
      required: ["type", "uuid"],
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
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    handler: getResourceHandler,
    tier: "api",
  },
  {
    name: "create_resource",
    description:
      "Create a new Coolify resource. `kind` discriminates: application (with `source` sub-discriminator), database (with `engine`), or service (with `service_type` XOR `docker_compose_raw` base64). FENCED: requires --allow-destructive and confirm:true (code/credential write).",
    inputSchema: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: ["application", "database", "service"],
          description: "The type of resource to create.",
        },
        source: {
          type: "string",
          enum: ["public", "private-github-app", "private-deploy-key", "dockerfile", "dockerimage"],
          description: "Required when kind=application. Determines which Coolify endpoint is called.",
        },
        engine: {
          type: "string",
          enum: ["postgresql", "mysql", "mariadb", "mongodb", "redis", "keydb", "dragonfly", "clickhouse"],
          description: "Required when kind=database.",
        },
        service_type: {
          type: "string",
          description: "Required when kind=service and not using docker_compose_raw. Mutually exclusive with docker_compose_raw.",
        },
        docker_compose_raw: {
          type: "string",
          description: "Base64-encoded docker-compose content. Required when kind=service and not using service_type. Mutually exclusive with service_type.",
        },
        server_uuid: { type: "string", description: "UUID of the target server." },
        environment_name: { type: "string", description: "Name of the Coolify environment." },
        project_uuid: { type: "string", description: "UUID of the target project." },
        name: { type: "string", description: "Name for the new resource." },
        git_repository: { type: "string", description: "Git repository URL (for git-based apps)." },
        git_branch: { type: "string", description: "Git branch (for git-based apps)." },
        github_app_uuid: { type: "string", description: "GitHub App UUID (for private-github-app source)." },
        private_key_uuid: { type: "string", description: "Private key UUID (for private-deploy-key source)." },
        dockerfile: { type: "string", description: "Dockerfile content (for dockerfile source)." },
        docker_image: { type: "string", description: "Docker image reference (for dockerimage source)." },
        instant_deploy: { type: "boolean", description: "Trigger deploy immediately after creation." },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm resource creation (destructive: code/credential write).",
        },
        dry_run: {
          type: "boolean",
          description: "If true, show what would be created without performing the action.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    handler: createResourceHandler,
    tier: "api",
  },
  {
    name: "update_resource",
    description: "Update configuration fields of an existing Coolify resource.",
    inputSchema: {
      type: "object",
      required: ["type", "uuid"],
      properties: {
        type: { type: "string", enum: ["applications", "databases", "services"] },
        uuid: { type: "string", description: "The Coolify UUID of the resource." },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      additionalProperties: true,
    },
    handler: updateResourceHandler,
    tier: "api",
  },
  {
    name: "control_resource",
    description:
      "Start, stop (fenced), or restart (fenced) a Coolify resource. stop and restart are destructive — they require --allow-destructive and confirm:true. For applications, start/restart return a deployment_uuid that can be used to track progress.",
    inputSchema: {
      type: "object",
      required: ["type", "uuid", "action"],
      properties: {
        type: { type: "string", enum: ["applications", "databases", "services"] },
        uuid: { type: "string", description: "The Coolify UUID of the resource." },
        action: { type: "string", enum: ["start", "stop", "restart"] },
        instant_deploy: {
          type: "boolean",
          description: "Applications only: skip the build queue.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm destructive operations (stop, restart).",
        },
        dry_run: {
          type: "boolean",
          description: "If true, show what would happen without performing the action (stop, restart).",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    handler: controlResourceHandler,
    tier: "api",
  },
  {
    name: "delete_resource",
    description: "Delete a Coolify resource permanently. Requires `confirm:true` and `--allow-destructive` flag.",
    inputSchema: {
      type: "object",
      required: ["type", "uuid"],
      properties: {
        type: { type: "string", enum: ["applications", "databases", "services"] },
        uuid: { type: "string" },
        confirm: { type: "boolean", description: "Must be true to execute." },
        dry_run: { type: "boolean", description: "Return preview without deleting." },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    handler: deleteResourceHandler,
    tier: "api",
  },
];
