import { ok, err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import { resolveTypedResource, buildFieldsBody, fieldsPassthroughProps } from "./resource-clients.js";
import type { ToolDef, ToolHandler } from "./types.js";

const manageStorageHandler: ToolHandler = async (args, ctx) => {
  try {
    const resolved = resolveTypedResource(ctx.api, args);
    if ("status" in resolved) return resolved;
    const { type, uuid, sub } = resolved;
    const action = args.action as string | undefined;

    if (!action || !["list", "create", "update", "delete"].includes(action)) {
      return err("invalid_input", "`action` must be one of: list, create, update, delete");
    }

    if (action === "list") {
      const storages = await sub.listStorages(uuid);
      return ok({ storages });
    }

    if (action === "create") {
      const built = buildFieldsBody(args, "type", "uuid", "action");
      if ("status" in built) return built;
      if (Object.keys(built.body).length === 0) {
        return err(
          "invalid_input",
          'No storage fields provided. Pass them in `fields`, e.g. { "fields": { "type": "volume", "name": "data", "mount_path": "/data" } }.',
        );
      }
      const result = await sub.createStorage(uuid, built.body);
      return ok({ result });
    }

    if (action === "update") {
      const storageUuid = assertCoolifyUuid(args.storage_uuid, "storage_uuid");
      const built = buildFieldsBody(args, "type", "uuid", "action", "storage_uuid");
      if ("status" in built) return built;
      if (Object.keys(built.body).length === 0) {
        return err(
          "invalid_input",
          'No storage fields provided. Pass them in `fields`, e.g. { "fields": { "mount_path": "/data" } }.',
        );
      }
      const result = await sub.updateStorage(uuid, storageUuid, built.body);
      return ok({ result });
    }

    // action === "delete"
    const storageUuid = assertCoolifyUuid(args.storage_uuid, "storage_uuid");
    const fence = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({ action: "delete_storage", type, uuid, storage_uuid: storageUuid }),
    });
    if (fence !== null) return fence;
    const result = await sub.deleteStorage(uuid, storageUuid);
    return ok({ result });
  } catch (e) {
    return toErrorResult(e);
  }
};

export const TOOLS: ToolDef[] = [
  {
    name: "manage_storage",
    description:
      "List, create, update, or delete persistent volume storage for an application, database, or service. For create/update, pass the storage fields in `fields` (create requires `type` and `mount_path`; also name, host_path, content, is_directory, fs_path).",
    inputSchema: {
      type: "object",
      required: ["type", "uuid", "action"],
      properties: {
        type: { type: "string", enum: ["applications", "databases", "services"] },
        uuid: { type: "string" },
        action: { type: "string", enum: ["list", "create", "update", "delete"] },
        storage_uuid: { type: "string", description: "Required for update and delete." },
        ...fieldsPassthroughProps("Storage fields for create/update (create requires type and mount_path; also name, host_path, content, is_directory, fs_path)"),
        confirm: { type: "boolean", description: "Required for delete." },
        dry_run: { type: "boolean" },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      additionalProperties: true,
    },
    handler: manageStorageHandler,
    tier: "api",
  },
];
