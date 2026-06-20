// src/mcp/tools/servers.ts
import { ok, err, toErrorResult } from "../../core/errors.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import { checkFences, destructiveArgs } from "../../core/fencing.js";
import { projectList, SERVER_SUMMARY_FIELDS } from "../../core/projection.js";
import type { HetznerResource } from "../../core/api/hetzner.js";
import type { ToolDef, ToolHandler } from "./types.js";

// ---------------------------------------------------------------------------
// get_servers
// ---------------------------------------------------------------------------

const getServers: ToolHandler = async (args, ctx) => {
  const action = (args.action as string | undefined) ?? "list";

  try {
    switch (action) {
      case "list": {
        const raw = await ctx.api.servers.list();
        const include = args.include === true;
        const normalized: Record<string, unknown>[] = Array.isArray(raw) ? raw : [];
        const result = include
          ? normalized
          : projectList(normalized, SERVER_SUMMARY_FIELDS);
        return ok({ servers: result });
      }

      case "get": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const server = await ctx.api.servers.get(uuid);
        return ok({ server });
      }

      case "validate": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const validation = await ctx.api.servers.validate(uuid);
        return ok({ validation });
      }

      case "resources": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const resources = await ctx.api.servers.resources(uuid);
        return ok({ resources });
      }

      case "domains": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const domains = await ctx.api.servers.domains(uuid);
        return ok({ domains });
      }

      default:
        return err("invalid_input", `Unknown action: ${String(action)}. Valid actions: list, get, validate, resources, domains`);
    }
  } catch (e) {
    return toErrorResult(e);
  }
};

// ---------------------------------------------------------------------------
// manage_server
// ---------------------------------------------------------------------------

const manageServer: ToolHandler = async (args, ctx) => {
  const action = args.action as string | undefined;

  try {
    switch (action) {
      case "create": {
        if (
          typeof args.name !== "string" || !args.name.trim() ||
          typeof args.ip !== "string" || !args.ip.trim() ||
          typeof args.user !== "string" || !args.user.trim() ||
          typeof args.private_key_uuid !== "string" || !args.private_key_uuid.trim()
        ) {
          return err("invalid_input", "create requires: name, ip, user, private_key_uuid");
        }
        const body: Record<string, unknown> = {
          name: args.name,
          ip: args.ip,
          user: args.user,
          private_key_uuid: args.private_key_uuid,
        };
        if (typeof args.port === "number") body.port = args.port;
        if (typeof args.description === "string") body.description = args.description;
        if (typeof args.is_build_server === "boolean") body.is_build_server = args.is_build_server;
        if (typeof args.instant_validate === "boolean") body.instant_validate = args.instant_validate;
        const result = await ctx.api.servers.create(body);
        return ok({ uuid: result.uuid });
      }

      case "update": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const body: Record<string, unknown> = {};
        const updatableFields = ["name", "ip", "user", "port", "description", "is_build_server"];
        for (const field of updatableFields) {
          if (args[field] !== undefined) body[field] = args[field];
        }
        const server = await ctx.api.servers.update(uuid, body);
        return ok({ server });
      }

      case "delete": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const fenced = await checkFences(ctx.config, {
          destructive: true,
          args: destructiveArgs(args),
          preview: async () => ({ action: "delete", resource: "server", uuid }),
        });
        if (fenced !== null) return fenced;
        const result = await ctx.api.servers.delete(uuid);
        return ok({ message: result.message });
      }

      default:
        return err("invalid_input", `Unknown action: ${String(action)}. Valid actions: create, update, delete`);
    }
  } catch (e) {
    return toErrorResult(e);
  }
};

// ---------------------------------------------------------------------------
// provision_hetzner
// NOTE: Provisioning is treated as destructive because it incurs immediate
// cloud cost and creates infrastructure.
// ---------------------------------------------------------------------------

const provisionHetzner: ToolHandler = async (args, ctx) => {
  try {
    const fenced = await checkFences(ctx.config, {
      destructive: true,
      args: destructiveArgs(args),
      preview: async () => ({
        action: "provision_hetzner",
        hetzner_server_type: args.hetzner_server_type,
        location: args.location,
        name: args.name,
      }),
    });
    if (fenced !== null) return fenced;

    if (typeof args.hetzner_server_type !== "string" || !args.hetzner_server_type.trim()) {
      return err("invalid_input", "hetzner_server_type is required");
    }
    if (typeof args.location !== "string" || !args.location.trim()) {
      return err("invalid_input", "location is required");
    }
    if (typeof args.name !== "string" || !args.name.trim()) {
      return err("invalid_input", "name is required");
    }

    const body: Record<string, unknown> = {
      hetzner_server_type: args.hetzner_server_type,
      location: args.location,
      name: args.name,
    };
    const optionalFields = [
      "hetzner_api_token", "coolify_token", "private_key_uuid",
      "ip", "user", "port", "description", "instant_validate",
    ];
    for (const field of optionalFields) {
      if (args[field] !== undefined) body[field] = args[field];
    }

    const result = await ctx.api.servers.createHetzner(body);
    return ok({ uuid: result.uuid, note: "Hetzner server provisioned. SSH connectivity may take 30–120s to become available." });
  } catch (e) {
    return toErrorResult(e);
  }
};

// ---------------------------------------------------------------------------
// hetzner_inventory
// ---------------------------------------------------------------------------

const VALID_HETZNER_RESOURCES: HetznerResource[] = ["locations", "server-types", "images", "ssh-keys"];

const hetznerInventory: ToolHandler = async (args, ctx) => {
  try {
    const resource = (args.resource as string | undefined) ?? "server-types";
    if (!VALID_HETZNER_RESOURCES.includes(resource as HetznerResource)) {
      return err(
        "invalid_input",
        `Unknown resource: ${String(resource)}. Valid values: ${VALID_HETZNER_RESOURCES.join(", ")}`,
      );
    }
    const items = await ctx.api.hetzner.list(resource as HetznerResource);
    return ok({ resource, items });
  } catch (e) {
    return toErrorResult(e);
  }
};

// ---------------------------------------------------------------------------
// manage_keys
// NOTE: Security API PATCH is collection-level: the uuid must be included
// in the request body, not the URL path. See contract for SecurityApi.updateKey.
// ---------------------------------------------------------------------------

const manageKeys: ToolHandler = async (args, ctx) => {
  const action = args.action as string | undefined;

  try {
    switch (action) {
      case "list": {
        const keys = await ctx.api.security.listKeys();
        // Strip private_key from every item — callers must never receive raw key material.
        const safeKeys = Array.isArray(keys)
          ? keys.map((k: Record<string, unknown>) => {
              const { private_key: _pk, ...rest } = k as Record<string, unknown> & { private_key?: unknown };
              return rest;
            })
          : keys;
        return ok({ keys: safeKeys });
      }

      case "get": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const key = await ctx.api.security.getKey(uuid);
        // Strip private_key from output — return only fingerprint/metadata.
        const { private_key: _pk, ...safeKey } = (key ?? {}) as Record<string, unknown> & { private_key?: unknown };
        return ok({ key: safeKey });
      }

      case "create": {
        const createFenced = await checkFences(ctx.config, {
          destructive: true,
          args: destructiveArgs(args),
          preview: async () => ({ action: "create_key", name: args.name }),
        });
        if (createFenced !== null) return createFenced;
        if (typeof args.name !== "string" || !args.name.trim()) {
          return err("invalid_input", "name is required for create");
        }
        if (typeof args.private_key !== "string" || !args.private_key.trim()) {
          return err("invalid_input", "private_key is required for create");
        }
        const body: Record<string, unknown> = {
          name: args.name,
          private_key: args.private_key,
        };
        if (typeof args.description === "string") body.description = args.description;
        if (typeof args.is_git_related === "boolean") body.is_git_related = args.is_git_related;
        const result = await ctx.api.security.createKey(body);
        return ok({ uuid: result.uuid });
      }

      case "update": {
        // PATCH is collection-level: uuid goes in the body, not the URL.
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const updateFenced = await checkFences(ctx.config, {
          destructive: true,
          args: destructiveArgs(args),
          preview: async () => ({ action: "update_key", uuid }),
        });
        if (updateFenced !== null) return updateFenced;
        const body: Record<string, unknown> = { uuid };
        if (typeof args.name === "string") body.name = args.name;
        if (typeof args.description === "string") body.description = args.description;
        if (typeof args.private_key === "string") body.private_key = args.private_key;
        if (typeof args.is_git_related === "boolean") body.is_git_related = args.is_git_related;
        const rawKey = await ctx.api.security.updateKey(body);
        // Strip private_key from update response exactly as get/list do —
        // the Coolify API echoes the full record including the PEM.
        const { private_key: _pk, ...safeKey } = (rawKey ?? {}) as Record<string, unknown> & { private_key?: unknown };
        return ok({ key: safeKey });
      }

      case "delete": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const fenced = await checkFences(ctx.config, {
          destructive: true,
          args: destructiveArgs(args),
          preview: async () => ({ action: "delete", resource: "private_key", uuid }),
        });
        if (fenced !== null) return fenced;
        await ctx.api.security.deleteKey(uuid);
        return ok({ message: "Private key deleted." });
      }

      default:
        return err("invalid_input", `Unknown action: ${String(action)}. Valid actions: list, get, create, update, delete`);
    }
  } catch (e) {
    return toErrorResult(e);
  }
};

// ---------------------------------------------------------------------------
// TOOLS export
// ---------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "get_servers",
    description: "Query Coolify servers. Actions: list (summary fields by default; include:true for full), get, validate, resources, domains.",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "validate", "resources", "domains"],
          description: "Operation to perform. Defaults to list.",
        },
        uuid: {
          type: "string",
          description: "Server UUID (required for get, validate, resources, domains).",
        },
        include: {
          type: "boolean",
          description: "If true, return full server objects instead of summary fields (list only).",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      required: [],
    },
    handler: getServers,
  },
  {
    name: "manage_server",
    description: "Create, update, or delete (fenced) a Coolify server.",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete"],
          description: "Operation to perform.",
        },
        uuid: {
          type: "string",
          description: "Server UUID (required for update, delete).",
        },
        name: { type: "string", description: "Server display name." },
        ip: { type: "string", description: "Server IP address (required for create)." },
        user: { type: "string", description: "SSH user (required for create)." },
        port: { type: "number", description: "SSH port (default 22)." },
        private_key_uuid: { type: "string", description: "UUID of the private key to use (required for create)." },
        description: { type: "string", description: "Optional description." },
        is_build_server: { type: "boolean", description: "Mark as build server." },
        instant_validate: { type: "boolean", description: "Validate immediately after create." },
        confirm: { type: "boolean", description: "Must be true to confirm delete." },
        dry_run: { type: "boolean", description: "Preview delete without executing." },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      required: ["action"],
    },
    handler: manageServer,
  },
  {
    name: "provision_hetzner",
    description: "Provision a new server on Hetzner Cloud via Coolify (destructive — creates billable infrastructure). Requires --allow-destructive flag and confirm:true.",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        hetzner_server_type: { type: "string", description: "Hetzner server type (e.g. cx11). Use hetzner_inventory to browse." },
        location: { type: "string", description: "Hetzner datacenter location (e.g. nbg1). Use hetzner_inventory to browse." },
        name: { type: "string", description: "Display name for the new server." },
        hetzner_api_token: { type: "string", description: "Hetzner API token (if not configured server-side)." },
        coolify_token: { type: "string", description: "Coolify cloud token UUID for the account." },
        private_key_uuid: { type: "string", description: "SSH private key UUID to install on the new server." },
        ip: { type: "string", description: "Override the provisioned IP (advanced)." },
        user: { type: "string", description: "SSH user (default root)." },
        port: { type: "number", description: "SSH port (default 22)." },
        description: { type: "string", description: "Optional description." },
        instant_validate: { type: "boolean", description: "Validate connectivity immediately." },
        confirm: { type: "boolean", description: "Must be true to proceed." },
        dry_run: { type: "boolean", description: "Preview without provisioning." },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      required: ["hetzner_server_type", "location", "name"],
    },
    handler: provisionHetzner,
  },
  {
    name: "hetzner_inventory",
    description: "Browse Hetzner Cloud resource catalog exposed by Coolify. Use before provision_hetzner to pick a server type and location.",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          enum: ["server-types", "locations", "images", "ssh-keys"],
          description: "Resource type to list. Defaults to server-types.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      required: [],
    },
    handler: hetznerInventory,
  },
  {
    name: "manage_keys",
    description: "Manage Coolify SSH private keys (security keys). Actions: list, get, create (fenced), update (fenced), delete (fenced). create and update are credential writes — they require --allow-destructive and confirm:true. Note: update uses a collection-level PATCH — uuid is passed in the body.",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete"],
          description: "Operation to perform.",
        },
        uuid: {
          type: "string",
          description: "Key UUID (required for get, update, delete).",
        },
        name: { type: "string", description: "Key display name." },
        private_key: { type: "string", description: "PEM-encoded private key (required for create)." },
        description: { type: "string", description: "Optional description." },
        is_git_related: { type: "boolean", description: "Mark as a git-related key." },
        confirm: { type: "boolean", description: "Must be true to confirm create, update, or delete." },
        dry_run: { type: "boolean", description: "Preview the action without executing (create, update, delete)." },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      required: ["action"],
    },
    handler: manageKeys,
  },
];
