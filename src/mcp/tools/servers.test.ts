// src/mcp/tools/servers.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "./servers.js";
import type { ToolContext } from "./types.js";
import type { InstanceConfig } from "../../core/config.js";

// ---- helpers ---------------------------------------------------------------

function makeCtx(overrides?: {
  enableHostOps?: boolean;
  allowDestructive?: boolean;
  servers?: Record<string, unknown>;
  security?: Record<string, unknown>;
  hetzner?: Record<string, unknown>;
}): ToolContext {
  const defaultServers = {
    list: vi.fn(async () => [
      { uuid: "srvuuid1", name: "My Server", ip: "1.2.3.4", reachable: true, settings: {} },
    ]),
    get: vi.fn(async (_uuid: string) => ({
      uuid: "srvuuid1", name: "My Server", ip: "1.2.3.4", reachable: true, settings: {},
    })),
    validate: vi.fn(async (_uuid: string) => ({ message: "Server is reachable." })),
    resources: vi.fn(async (_uuid: string) => [{ uuid: "appuuid1", type: "application" }]),
    domains: vi.fn(async (_uuid: string) => [{ domain: "example.com" }]),
    create: vi.fn(async (_body: Record<string, unknown>) => ({ uuid: "newsrv1" })),
    createHetzner: vi.fn(async (_body: Record<string, unknown>) => ({ uuid: "hetnewsrv1" })),
    update: vi.fn(async (_uuid: string, _body: Record<string, unknown>) => ({
      uuid: "srvuuid1", name: "Updated Server",
    })),
    delete: vi.fn(async (_uuid: string) => ({ message: "Server deleted." })),
    ...overrides?.servers,
  };

  const defaultSecurity = {
    listKeys: vi.fn(async () => [{ uuid: "keyuuid1", name: "my-key", private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----" }]),
    getKey: vi.fn(async (_uuid: string) => ({ uuid: "keyuuid1", name: "my-key", public_key: "ssh-rsa AAA...", private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----" })),
    createKey: vi.fn(async (_body: Record<string, unknown>) => ({ uuid: "newkeyuuid1" })),
    updateKey: vi.fn(async (_body: Record<string, unknown>) => ({ uuid: "keyuuid1", name: "updated-key" })),
    deleteKey: vi.fn(async (_uuid: string) => ({ message: "Key deleted." })),
    ...overrides?.security,
  };

  const defaultHetzner = {
    list: vi.fn(async (resource: string) => {
      if (resource === "server-types") return [{ id: 1, name: "cx11" }];
      if (resource === "locations") return [{ id: 1, name: "nbg1" }];
      if (resource === "images") return [{ id: 1, name: "ubuntu-22.04" }];
      if (resource === "ssh-keys") return [{ id: 1, name: "my-key" }];
      return [];
    }),
    ...overrides?.hetzner,
  };

  return {
    api: {
      servers: defaultServers,
      security: defaultSecurity,
      hetzner: defaultHetzner,
    } as unknown as ToolContext["api"],
    config: {
      name: "default",
      baseUrl: "http://coolify.example.com",
      token: "1|secret",
      extraHeaders: {},
      enableHostOps: overrides?.enableHostOps ?? false,
      allowDestructive: overrides?.allowDestructive ?? false,
    } as InstanceConfig,
    hostOps: async () => { throw new Error("hostOps not available"); },
    resolver: {} as ToolContext["resolver"],
    notifier: undefined,
    progressToken: undefined,
  };
}

function getTool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found in TOOLS`);
  return t;
}

// ---- get_servers -----------------------------------------------------------

describe("get_servers", () => {
  it("is exported with tier api", () => {
    const t = getTool("get_servers");
    expect(t.tier).toBe("api");
  });

  it("lists servers with summary fields by default", async () => {
    const ctx = makeCtx();
    const t = getTool("get_servers");
    const result = await t.handler({ action: "list" }, ctx);
    expect(result.status).toBe("ok");
    expect(Array.isArray((result as any).servers)).toBe(true);
  });

  it("gets a single server by uuid", async () => {
    const ctx = makeCtx();
    const t = getTool("get_servers");
    const result = await t.handler({ action: "get", uuid: "srvuuid1" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).server.uuid).toBe("srvuuid1");
  });

  it("validates a server", async () => {
    const ctx = makeCtx();
    const t = getTool("get_servers");
    const result = await t.handler({ action: "validate", uuid: "srvuuid1" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).validation).toBeDefined();
  });

  it("lists server resources", async () => {
    const ctx = makeCtx();
    const t = getTool("get_servers");
    const result = await t.handler({ action: "resources", uuid: "srvuuid1" }, ctx);
    expect(result.status).toBe("ok");
    expect(Array.isArray((result as any).resources)).toBe(true);
  });

  it("lists server domains", async () => {
    const ctx = makeCtx();
    const t = getTool("get_servers");
    const result = await t.handler({ action: "domains", uuid: "srvuuid1" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).domains).toBeDefined();
  });

  it("returns invalid_input for unknown action", async () => {
    const ctx = makeCtx();
    const t = getTool("get_servers");
    const result = await t.handler({ action: "bogus" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("returns invalid_input when uuid missing for get", async () => {
    const ctx = makeCtx();
    const t = getTool("get_servers");
    const result = await t.handler({ action: "get" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

// ---- manage_server ---------------------------------------------------------

describe("manage_server", () => {
  it("is exported with tier api", () => {
    const t = getTool("manage_server");
    expect(t.tier).toBe("api");
  });

  it("creates a server", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_server");
    const result = await t.handler({
      action: "create",
      name: "new-server",
      ip: "10.0.0.1",
      user: "root",
      port: 22,
      private_key_uuid: "keyuuid1",
    }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).uuid).toBe("newsrv1");
  });

  it("updates a server", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_server");
    const result = await t.handler({ action: "update", uuid: "srvuuid1", name: "Updated Server" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).server).toBeDefined();
  });

  it("blocks delete when allowDestructive is false", async () => {
    const ctx = makeCtx({ allowDestructive: false });
    const t = getTool("manage_server");
    const result = await t.handler({ action: "delete", uuid: "srvuuid1", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("blocks delete when confirm is missing", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_server");
    const result = await t.handler({ action: "delete", uuid: "srvuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("deletes a server when allowed + confirmed", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_server");
    const result = await t.handler({ action: "delete", uuid: "srvuuid1", confirm: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).message).toMatch(/deleted/i);
  });

  it("dry-runs delete", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_server");
    const result = await t.handler({ action: "delete", uuid: "srvuuid1", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
  });

  it("returns invalid_input for unknown action", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_server");
    const result = await t.handler({ action: "frobnicate" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("returns invalid_input when create missing required fields", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_server");
    const result = await t.handler({ action: "create" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

// ---- provision_hetzner -----------------------------------------------------

describe("provision_hetzner", () => {
  it("is exported with tier api", () => {
    const t = getTool("provision_hetzner");
    expect(t.tier).toBe("api");
  });

  it("blocks when allowDestructive is false", async () => {
    const ctx = makeCtx({ allowDestructive: false });
    const t = getTool("provision_hetzner");
    const result = await t.handler({
      hetzner_server_type: "cx11",
      location: "nbg1",
      name: "my-server",
      confirm: true,
    }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("blocks when confirm is missing", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("provision_hetzner");
    const result = await t.handler({
      hetzner_server_type: "cx11",
      location: "nbg1",
      name: "my-server",
    }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("provisions a hetzner server when allowed + confirmed", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("provision_hetzner");
    const result = await t.handler({
      hetzner_server_type: "cx11",
      location: "nbg1",
      name: "my-server",
      confirm: true,
    }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).uuid).toBe("hetnewsrv1");
  });

  it("dry-runs provisioning", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("provision_hetzner");
    const result = await t.handler({
      hetzner_server_type: "cx11",
      location: "nbg1",
      name: "my-server",
      dry_run: true,
    }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
  });
});

// ---- hetzner_inventory -----------------------------------------------------

describe("hetzner_inventory", () => {
  it("is exported with tier api", () => {
    const t = getTool("hetzner_inventory");
    expect(t.tier).toBe("api");
  });

  it("fetches server-types by default", async () => {
    const ctx = makeCtx();
    const t = getTool("hetzner_inventory");
    const result = await t.handler({ resource: "server-types" }, ctx);
    expect(result.status).toBe("ok");
    expect(Array.isArray((result as any).items)).toBe(true);
    expect((result as any).items[0].name).toBe("cx11");
  });

  it("fetches locations", async () => {
    const ctx = makeCtx();
    const t = getTool("hetzner_inventory");
    const result = await t.handler({ resource: "locations" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).items[0].name).toBe("nbg1");
  });

  it("defaults to server-types when resource omitted", async () => {
    const ctx = makeCtx();
    const t = getTool("hetzner_inventory");
    const result = await t.handler({}, ctx);
    expect(result.status).toBe("ok");
    expect(Array.isArray((result as any).items)).toBe(true);
  });

  it("returns invalid_input for unknown resource type", async () => {
    const ctx = makeCtx();
    const t = getTool("hetzner_inventory");
    const result = await t.handler({ resource: "unicorns" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

// ---- manage_keys -----------------------------------------------------------

describe("manage_keys", () => {
  it("is exported with tier api", () => {
    const t = getTool("manage_keys");
    expect(t.tier).toBe("api");
  });

  it("lists keys", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "list" }, ctx);
    expect(result.status).toBe("ok");
    expect(Array.isArray((result as any).keys)).toBe(true);
  });

  // R10 regression: private_key must never appear in list output
  it("strips private_key from list output", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "list" }, ctx);
    expect(result.status).toBe("ok");
    const keys = (result as any).keys as Record<string, unknown>[];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toHaveProperty("private_key");
    }
    // metadata fields are preserved
    expect(keys[0].uuid).toBe("keyuuid1");
    expect(keys[0].name).toBe("my-key");
  });

  it("gets a single key", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "get", uuid: "keyuuid1" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).key.uuid).toBe("keyuuid1");
  });

  // R10 regression: private_key must never appear in get output
  it("strips private_key from get output", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "get", uuid: "keyuuid1" }, ctx);
    expect(result.status).toBe("ok");
    const key = (result as any).key as Record<string, unknown>;
    expect(key).not.toHaveProperty("private_key");
    // metadata fields are preserved
    expect(key.uuid).toBe("keyuuid1");
    expect(key.name).toBe("my-key");
    expect(key.public_key).toBeDefined();
  });

  it("creates a key when allowDestructive=true and confirm=true", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "create", name: "new-key", private_key: "-----BEGIN...", confirm: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).uuid).toBe("newkeyuuid1");
  });

  it("updates a key when allowDestructive=true and confirm=true — uuid in body (collection-level PATCH)", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "update", uuid: "keyuuid1", name: "updated-key", confirm: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).key).toBeDefined();
  });

  // H2R2 regression: manage_keys create is fenced (credential write)
  it("manage_keys create: destructive_blocked when allowDestructive=false", async () => {
    const ctx = makeCtx({ allowDestructive: false });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "create", name: "new-key", private_key: "-----BEGIN..." }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("manage_keys create: confirmation_required when allowDestructive=true but no confirm", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "create", name: "new-key", private_key: "-----BEGIN..." }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("manage_keys create: dry_run returns preview without calling API", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "create", name: "new-key", private_key: "-----BEGIN...", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
    expect(ctx.api.security.createKey).not.toHaveBeenCalled();
  });

  // H2R2 regression: manage_keys update is fenced (credential write)
  it("manage_keys update: destructive_blocked when allowDestructive=false", async () => {
    const ctx = makeCtx({ allowDestructive: false });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "update", uuid: "keyuuid1", name: "updated-key" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("manage_keys update: confirmation_required when allowDestructive=true but no confirm", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "update", uuid: "keyuuid1", name: "updated-key" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("manage_keys update: dry_run returns preview without calling API", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "update", uuid: "keyuuid1", name: "updated-key", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
    expect(ctx.api.security.updateKey).not.toHaveBeenCalled();
  });

  it("blocks delete when allowDestructive is false", async () => {
    const ctx = makeCtx({ allowDestructive: false });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "delete", uuid: "keyuuid1", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("blocks delete when confirm is missing", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "delete", uuid: "keyuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("deletes a key when allowed + confirmed", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "delete", uuid: "keyuuid1", confirm: true }, ctx);
    expect(result.status).toBe("ok");
  });

  it("dry-runs key delete", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "delete", uuid: "keyuuid1", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
  });

  // H2R3 regression: manage_keys update must never leak private_key in output
  it("strips private_key from update output (H2R3-managekeys-update-leak)", async () => {
    // Simulate a Coolify API response that echoes the full record including the PEM.
    const ctx = makeCtx({
      allowDestructive: true,
      security: {
        updateKey: vi.fn(async (_body: Record<string, unknown>) => ({
          uuid: "keyuuid1",
          name: "updated-key",
          private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
          public_key: "ssh-rsa AAAA...",
        })),
      },
    });
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "update", uuid: "keyuuid1", name: "updated-key", confirm: true }, ctx);
    expect(result.status).toBe("ok");
    const key = (result as any).key as Record<string, unknown>;
    // The PEM must never be echoed back to the caller.
    expect(key).not.toHaveProperty("private_key");
    // Metadata fields must still be present.
    expect(key.uuid).toBe("keyuuid1");
    expect(key.name).toBe("updated-key");
    expect(key.public_key).toBeDefined();
  });

  it("returns invalid_input for unknown action", async () => {
    const ctx = makeCtx();
    const t = getTool("manage_keys");
    const result = await t.handler({ action: "frob" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});
