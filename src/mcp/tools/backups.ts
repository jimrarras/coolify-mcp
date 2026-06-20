import { ok, err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import { bodyWithout } from "./resource-clients.js";
import type { ToolDef, ToolHandler } from "./types.js";

const manageBackupsHandler: ToolHandler = async (args, ctx) => {
  try {
    const uuid = assertCoolifyUuid(args.uuid, "uuid");
    const action = args.action as string | undefined;

    if (!action || !["list", "create", "update", "delete", "executions", "delete_execution"].includes(action)) {
      return err("invalid_input", "`action` must be one of: list, create, update, delete, executions, delete_execution");
    }

    const db = ctx.api.databases;

    if (action === "list") {
      const backups = await db.listBackups(uuid);
      return ok({ backups });
    }

    if (action === "create") {
      const result = await db.createBackup(uuid, bodyWithout(args, "uuid", "action"));
      return ok({ result });
    }

    if (action === "update") {
      const backupUuid = assertCoolifyUuid(args.backup_uuid, "backup_uuid");
      const body = bodyWithout(args, "uuid", "action", "backup_uuid");
      const result = await db.updateBackup(uuid, backupUuid, body);
      return ok({ result });
    }

    if (action === "delete") {
      const backupUuid = assertCoolifyUuid(args.backup_uuid, "backup_uuid");
      const fence = await checkFences(ctx.config, {
        destructive: true,
        args: destructiveArgs(args),
        preview: async () => ({ action: "delete_backup", uuid, backup_uuid: backupUuid }),
      });
      if (fence !== null) return fence;
      const result = await db.deleteBackup(uuid, backupUuid);
      return ok({ result });
    }

    if (action === "executions") {
      const backupUuid = assertCoolifyUuid(args.backup_uuid, "backup_uuid");
      const executions = await db.backupExecutions(uuid, backupUuid);
      return ok({ executions });
    }

    // action === "delete_execution"
    const backupUuid = assertCoolifyUuid(args.backup_uuid, "backup_uuid");
    const execUuid = assertCoolifyUuid(args.execution_uuid, "execution_uuid");
    const fence = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({ action: "delete_backup_execution", uuid, backup_uuid: backupUuid, execution_uuid: execUuid }),
    });
    if (fence !== null) return fence;
    const result = await db.deleteBackupExecution(uuid, backupUuid, execUuid);
    return ok({ result });
  } catch (e) {
    return toErrorResult(e);
  }
};

export const TOOLS: ToolDef[] = [
  {
    name: "manage_backups",
    description: "List, create, update, or delete database backup schedules and executions. Only applicable to databases.",
    inputSchema: {
      type: "object",
      required: ["uuid", "action"],
      properties: {
        uuid: { type: "string", description: "Database UUID." },
        action: { type: "string", enum: ["list", "create", "update", "delete", "executions", "delete_execution"] },
        backup_uuid: { type: "string", description: "Required for update, delete, executions, delete_execution." },
        execution_uuid: { type: "string", description: "Required for delete_execution." },
        confirm: { type: "boolean", description: "Required for delete and delete_execution." },
        dry_run: { type: "boolean" },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      additionalProperties: true,
    },
    handler: manageBackupsHandler,
    tier: "api",
  },
];
