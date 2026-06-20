// src/mcp/tools/deploy.ts
import { ok, err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import { DeploymentsApi } from "../../core/api/deployments.js";
import { runDeployWatch } from "../../core/deploy/watch.js";
import type { ToolDef, ToolContext } from "./types.js";
import type { ToolResult } from "../../core/errors.js";

interface DeployParams {
  uuid?: string;
  tag?: string;
  force?: boolean;
  pr?: number;
}

/**
 * Validates the deploy params shared by `deploy` and `deploy_watch`. Returns the
 * params object on success, or a ToolResult error envelope on a validation
 * failure. May throw CoolifyError via assertCoolifyUuid (caught by the handler).
 */
function parseDeployParams(args: Record<string, unknown>): DeployParams | ToolResult {
  const { uuid, tag, force, pr } = args;
  const params: DeployParams = {};

  if (uuid !== undefined) {
    params.uuid = assertCoolifyUuid(uuid, "uuid");
  }
  if (tag !== undefined) {
    if (typeof tag !== "string" || tag.trim() === "") {
      return err("invalid_input", "tag must be a non-empty string");
    }
    params.tag = tag.trim();
  }
  if (!params.uuid && !params.tag) {
    return err("invalid_input", "At least one of uuid or tag is required");
  }
  if (force !== undefined) {
    params.force = Boolean(force);
  }
  if (pr !== undefined) {
    if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) {
      return err("invalid_input", "pr must be a positive integer");
    }
    params.pr = pr;
  }
  return params;
}

const deployHandler = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> => {
  try {
    const parsed = parseDeployParams(args);
    if ("status" in parsed) return parsed; // validation error envelope
    const params = parsed;

    const fenced = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({ action: "deploy", ...params }),
    });
    if (fenced !== null) return fenced;

    const deploymentsApi = new DeploymentsApi(ctx.api);
    const deployments = await deploymentsApi.trigger(params);
    return ok({ deployments });
  } catch (e) {
    return toErrorResult(e);
  }
};

const getDeploymentsHandler = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> => {
  try {
    const { app_uuid, skip, take } = args;

    const deploymentsApi = new DeploymentsApi(ctx.api);

    if (app_uuid !== undefined) {
      const uuid = assertCoolifyUuid(app_uuid, "app_uuid");
      const opts: { skip?: number; take?: number } = {};
      if (skip !== undefined) {
        if (typeof skip !== "number" || !Number.isInteger(skip) || skip < 0) {
          return err("invalid_input", "skip must be a non-negative integer");
        }
        opts.skip = skip;
      }
      if (take !== undefined) {
        if (typeof take !== "number" || !Number.isInteger(take) || take < 1) {
          return err("invalid_input", "take must be a positive integer");
        }
        opts.take = take;
      }
      const { deployments, count } = await deploymentsApi.history(uuid, opts);
      return ok({ deployments, count, app_uuid: uuid });
    }

    const deployments = await deploymentsApi.listActive();
    return ok({ deployments });
  } catch (e) {
    return toErrorResult(e);
  }
};

const cancelDeploymentHandler = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> => {
  try {
    const { deployment_uuid } = args;
    const uuid = assertCoolifyUuid(deployment_uuid, "deployment_uuid");
    const fenced = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({ action: "cancel_deployment", deployment_uuid: uuid }),
    });
    if (fenced !== null) return fenced;
    const deploymentsApi = new DeploymentsApi(ctx.api);
    const result = await deploymentsApi.cancel(uuid);
    // Use "deployment_status" to avoid shadowing the envelope's "status" key.
    return ok({ deployment_uuid: result.deployment_uuid, deployment_status: result.status });
  } catch (e) {
    return toErrorResult(e);
  }
};

const deployWatchHandler = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> => {
  try {
    const { timeout_seconds, _sleep } = args;

    const parsed = parseDeployParams(args);
    if ("status" in parsed) return parsed; // validation error envelope
    const params = parsed;

    const fenced = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({ action: "deploy_watch", ...params }),
    });
    if (fenced !== null) return fenced;

    const timeoutMs =
      typeof timeout_seconds === "number" && timeout_seconds > 0
        ? timeout_seconds * 1_000
        : 1_800_000;

    // _sleep is an injectable for tests only — not exposed in inputSchema
    const sleepFn =
      typeof _sleep === "function"
        ? (_sleep as (ms: number) => Promise<void>)
        : undefined;

    const deploymentsApi = new DeploymentsApi(ctx.api);
    const triggers = await deploymentsApi.trigger(params);

    const onProgress = (e: { resource_uuid: string; status: string; lines: number }) => {
      if (ctx.notifier?.sendNotification && ctx.progressToken !== undefined) {
        ctx.notifier.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: ctx.progressToken,
            progress: e.lines,
            total: undefined,
            message: `${e.resource_uuid}: ${e.status} (${e.lines} log lines)`,
          },
        });
      }
    };

    const results = await runDeployWatch(
      triggers,
      async (_resourceUuid: string) => {
        // serverUuidFor: we don't have a mapping here, return empty string
        // (the server polling branch is only taken when deployment_uuid is absent)
        return "";
      },
      {
        deployments: deploymentsApi,
        // servers is part of the contract type but not used in the current implementation
        // (no-uuid path returns immediately; wiring ctx.api.servers would trigger a
        // lazy createRequire load that fails under vitest). Pass a minimal stub.
        servers: {} as import("../../core/api/servers.js").ServersApi,
        onProgress,
        sleep: sleepFn,
        timeoutMs,
      },
    );

    // Only finished/skipped are unambiguous successes. failed/cancelled/unknown
    // (incl. a timeout that returned "unknown") downgrade the envelope to
    // "partial" so a caller keying off the top-level status does not read a
    // stuck or cancelled deploy as a success.
    const allSucceeded = results.every(
      (r) => r.final_status === "finished" || r.final_status === "skipped",
    );
    if (!allSucceeded) {
      return { status: "partial", results };
    }
    return ok({ results });
  } catch (e) {
    return toErrorResult(e);
  }
};

export const TOOLS: ToolDef[] = [
  {
    name: "deploy",
    description:
      "Trigger a new deployment for an application (by UUID or tag). Optionally force-rebuild or deploy a pull-request preview. FENCED: requires --allow-destructive and confirm:true (code/credential write).",
    inputSchema: {
      type: "object",
      properties: {
        uuid: {
          type: "string",
          description: "Coolify application UUID to deploy (alphanumeric, e.g. abc123).",
        },
        tag: {
          type: "string",
          description: "Deploy all resources sharing this tag.",
        },
        force: {
          type: "boolean",
          description: "Force a rebuild without cache.",
          default: false,
        },
        pr: {
          type: "number",
          description: "Pull-request number for preview deployments.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm this deployment (destructive: triggers production change).",
        },
        dry_run: {
          type: "boolean",
          description: "If true, show what would be deployed without triggering.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    tier: "api",
    handler: deployHandler,
  },
  {
    name: "get_deployments",
    description:
      "List active deployments (no args) or the deployment history for a specific application (app_uuid). Supports pagination with skip/take.",
    inputSchema: {
      type: "object",
      properties: {
        app_uuid: {
          type: "string",
          description:
            "Application UUID whose deployment history to retrieve. Omit for all active deployments.",
        },
        skip: {
          type: "number",
          description: "Number of records to skip (pagination). Only used with app_uuid.",
        },
        take: {
          type: "number",
          description: "Number of records to return (pagination). Only used with app_uuid.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    tier: "api",
    handler: getDeploymentsHandler,
  },
  {
    name: "cancel_deployment",
    description: "Cancel an in-progress deployment by its deployment UUID (fenced). Requires --allow-destructive and confirm:true.",
    inputSchema: {
      type: "object",
      required: ["deployment_uuid"],
      properties: {
        deployment_uuid: {
          type: "string",
          description: "Coolify deployment UUID to cancel (alphanumeric).",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm this destructive operation.",
        },
        dry_run: {
          type: "boolean",
          description: "If true, show what would be cancelled without performing the action.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    tier: "api",
    handler: cancelDeploymentHandler,
  },
  {
    name: "deploy_watch",
    description:
      "Trigger a deployment and block until it reaches a terminal state (finished/failed/cancelled/skipped). Emits MCP progress notifications while polling. Returns per-resource final statuses and a logs tail on failure. FENCED: requires --allow-destructive and confirm:true (code/credential write).",
    inputSchema: {
      type: "object",
      properties: {
        uuid: {
          type: "string",
          description: "Coolify application UUID to deploy (alphanumeric).",
        },
        tag: {
          type: "string",
          description: "Deploy all resources sharing this tag.",
        },
        force: {
          type: "boolean",
          description: "Force a rebuild without cache.",
          default: false,
        },
        pr: {
          type: "number",
          description: "Pull-request number for preview deployments.",
        },
        timeout_seconds: {
          type: "number",
          description: "Maximum seconds to wait before returning 'unknown'. Default 1800.",
          default: 1800,
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm this deployment (destructive: triggers production change).",
        },
        dry_run: {
          type: "boolean",
          description: "If true, show what would be deployed without triggering.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    tier: "api",
    handler: deployWatchHandler,
  },
];
