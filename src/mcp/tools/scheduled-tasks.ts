import { ok, err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import { resolveTypedResource, bodyWithout, type AppOrServiceSubClient } from "./resource-clients.js";
import type { ToolDef, ToolHandler } from "./types.js";

// Scheduled tasks are supported on applications and services only (not databases).
const TASK_TYPES = ["applications", "services"] as const;

const manageScheduledTasksHandler: ToolHandler = async (args, ctx) => {
  try {
    const resolved = resolveTypedResource<AppOrServiceSubClient>(ctx.api, args, TASK_TYPES);
    if ("status" in resolved) return resolved;
    const { type, uuid, sub } = resolved;
    const action = args.action as string | undefined;

    if (!action || !["list", "create", "update", "delete", "executions"].includes(action)) {
      return err("invalid_input", "`action` must be one of: list, create, update, delete, executions");
    }

    if (action === "list") {
      const tasks = await sub.listScheduledTasks(uuid);
      return ok({ tasks });
    }

    if (action === "create") {
      const fenced = await checkFences(ctx.config, {
        destructive: true,
        args: destructiveArgs(args),
        preview: async () => ({ action: "create_scheduled_task", type, uuid }),
      });
      if (fenced !== null) return fenced;
      const result = await sub.createScheduledTask(uuid, bodyWithout(args, "type", "uuid", "action"));
      return ok({ result });
    }

    if (action === "update") {
      const taskUuid = assertCoolifyUuid(args.task_uuid, "task_uuid");
      const fenced = await checkFences(ctx.config, {
        destructive: true,
        args: destructiveArgs(args),
        preview: async () => ({ action: "update_scheduled_task", type, uuid, task_uuid: taskUuid }),
      });
      if (fenced !== null) return fenced;
      const body = bodyWithout(args, "type", "uuid", "action", "task_uuid");
      const result = await sub.updateScheduledTask(uuid, taskUuid, body);
      return ok({ result });
    }

    if (action === "delete") {
      const taskUuid = assertCoolifyUuid(args.task_uuid, "task_uuid");
      const fence = await checkFences(ctx.config, {
        destructive: true,
        args: destructiveArgs(args),
        preview: async () => ({ action: "delete_scheduled_task", type, uuid, task_uuid: taskUuid }),
      });
      if (fence !== null) return fence;
      const result = await sub.deleteScheduledTask(uuid, taskUuid);
      return ok({ result });
    }

    // action === "executions"
    const taskUuid = assertCoolifyUuid(args.task_uuid, "task_uuid");
    const executions = await sub.scheduledTaskExecutions(uuid, taskUuid);
    return ok({ executions });
  } catch (e) {
    return toErrorResult(e);
  }
};

export const TOOLS: ToolDef[] = [
  {
    name: "manage_scheduled_tasks",
    description: "List, create (fenced), update (fenced), delete (fenced), or view executions of scheduled tasks on an application or service. create and update are code-execution writes — they require --allow-destructive and confirm:true.",
    inputSchema: {
      type: "object",
      required: ["type", "uuid", "action"],
      properties: {
        type: { type: "string", enum: ["applications", "services"] },
        uuid: { type: "string" },
        action: { type: "string", enum: ["list", "create", "update", "delete", "executions"] },
        task_uuid: { type: "string", description: "Required for update, delete, executions." },
        name: { type: "string" },
        command: { type: "string" },
        frequency: { type: "string", description: "Cron expression." },
        confirm: { type: "boolean", description: "Required for create, update, and delete." },
        dry_run: { type: "boolean", description: "If true, show preview without performing the action (create, update, delete)." },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      additionalProperties: true,
    },
    handler: manageScheduledTasksHandler,
    tier: "api",
  },
];
