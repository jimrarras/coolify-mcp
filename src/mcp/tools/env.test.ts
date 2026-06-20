// src/mcp/tools/env.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "./env.js";
import type { ToolContext } from "./types.js";
import type { InstanceConfig } from "../../core/config.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    api: {
      applications: {
        listEnvs: vi.fn(),
        upsertEnvsBulk: vi.fn(),
        deleteEnv: vi.fn(),
      },
      databases: {
        listEnvs: vi.fn(),
        upsertEnvsBulk: vi.fn(),
        deleteEnv: vi.fn(),
      },
      services: {
        listEnvs: vi.fn(),
        upsertEnvsBulk: vi.fn(),
        deleteEnv: vi.fn(),
      },
    } as unknown as ToolContext["api"],
    config: {
      name: "default",
      baseUrl: "http://coolify.test",
      token: "1|secret",
      extraHeaders: {},
      enableHostOps: false,
      allowDestructive: false,
    } as InstanceConfig,
    hostOps: async () => { throw new Error("no host ops"); },
    resolver: {} as ToolContext["resolver"],
    ...overrides,
  } as ToolContext;
}

function findTool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe("manage_env — list", () => {
  it("lists envs for an application", async () => {
    const ctx = makeCtx();
    const envs = [
      { uuid: "env1", key: "NODE_ENV", value: "production", is_preview: false },
      { uuid: "env2", key: "SECRET_KEY", value: "", is_preview: false },
    ];
    (ctx.api.applications.listEnvs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(envs);

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "list" },
      ctx,
    );

    expect(result.status).toBe("ok");
    const r = result as Record<string, unknown>;
    expect(Array.isArray(r.envs)).toBe(true);
    expect((r.envs as unknown[]).length).toBe(2);
  });

  it("attaches redaction_hint:true when a value looks redacted or empty", async () => {
    const ctx = makeCtx();
    const envs = [
      { uuid: "env1", key: "NODE_ENV", value: "production" },
      { uuid: "env2", key: "SECRET_KEY", value: "" },
      { uuid: "env3", key: "API_TOKEN", value: "***REDACTED***" },
    ];
    (ctx.api.applications.listEnvs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(envs);

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "list" },
      ctx,
    );

    expect(result.status).toBe("ok");
    const r = result as Record<string, unknown>;
    expect(r.redaction_hint).toBe(true);
  });

  it("does not attach redaction_hint when all values are non-empty and non-redacted", async () => {
    const ctx = makeCtx();
    const envs = [
      { uuid: "env1", key: "NODE_ENV", value: "production" },
      { uuid: "env2", key: "PORT", value: "3000" },
    ];
    (ctx.api.applications.listEnvs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(envs);

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "list" },
      ctx,
    );

    expect(result.status).toBe("ok");
    const r = result as Record<string, unknown>;
    expect(r.redaction_hint).toBeUndefined();
  });

  it("lists envs for a database", async () => {
    const ctx = makeCtx();
    const envs = [{ uuid: "env1", key: "DB_NAME", value: "mydb" }];
    (ctx.api.databases.listEnvs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(envs);

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "databases", uuid: "def456", action: "list" },
      ctx,
    );

    expect(result.status).toBe("ok");
  });

  it("lists envs for a service", async () => {
    const ctx = makeCtx();
    const envs = [{ uuid: "env1", key: "SERVICE_URL", value: "http://localhost:8080" }];
    (ctx.api.services.listEnvs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(envs);

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "services", uuid: "ghi789", action: "list" },
      ctx,
    );

    expect(result.status).toBe("ok");
  });

  it("returns invalid_input for unknown type", async () => {
    const ctx = makeCtx();
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "unknown", uuid: "abc123", action: "list" },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("invalid_input");
  });

  it("returns invalid_input for invalid uuid", async () => {
    const ctx = makeCtx();
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "bad uuid!", action: "list" },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("invalid_input");
  });
});

describe("manage_env — set", () => {
  it("upserts a single env var via upsertEnvsBulk", async () => {
    const ctx = makeCtx();
    (ctx.api.applications.upsertEnvsBulk as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message: "Envs updated." });

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "set", key: "MY_VAR", value: "hello" },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(ctx.api.applications.upsertEnvsBulk).toHaveBeenCalledWith("abc123", [{ key: "MY_VAR", value: "hello" }]);
  });

  it("upserts multiple env vars via bulk array", async () => {
    const ctx = makeCtx();
    (ctx.api.applications.upsertEnvsBulk as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message: "Envs updated." });

    const tool = findTool("manage_env");
    const result = await tool.handler(
      {
        type: "applications",
        uuid: "abc123",
        action: "set",
        vars: [
          { key: "VAR_A", value: "1" },
          { key: "VAR_B", value: "2" },
        ],
      },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(ctx.api.applications.upsertEnvsBulk).toHaveBeenCalledWith("abc123", [
      { key: "VAR_A", value: "1" },
      { key: "VAR_B", value: "2" },
    ]);
  });

  it("returns invalid_input when neither key+value nor vars is provided", async () => {
    const ctx = makeCtx();
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "set" },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("invalid_input");
  });

  it("returns invalid_input when vars is provided but not an array", async () => {
    const ctx = makeCtx();
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "set", vars: "not-an-array" },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("invalid_input");
  });

  it("sets envs on a database", async () => {
    const ctx = makeCtx();
    (ctx.api.databases.upsertEnvsBulk as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message: "OK" });

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "databases", uuid: "def456", action: "set", key: "DB_POOL", value: "10" },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(ctx.api.databases.upsertEnvsBulk).toHaveBeenCalledWith("def456", [{ key: "DB_POOL", value: "10" }]);
  });

  it("sets envs on a service", async () => {
    const ctx = makeCtx();
    (ctx.api.services.upsertEnvsBulk as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message: "OK" });

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "services", uuid: "ghi789", action: "set", key: "REDIS_URL", value: "redis://localhost" },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(ctx.api.services.upsertEnvsBulk).toHaveBeenCalledWith("ghi789", [{ key: "REDIS_URL", value: "redis://localhost" }]);
  });
});

describe("manage_env — delete", () => {
  it("blocks delete when allowDestructive is false", async () => {
    const ctx = makeCtx(); // allowDestructive: false
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "delete", env_uuid: "env1", confirm: true },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("destructive_blocked");
  });

  it("blocks delete when confirm is missing", async () => {
    const ctx = makeCtx({ config: { name: "default", baseUrl: "http://coolify.test", token: "1|secret", extraHeaders: {}, enableHostOps: false, allowDestructive: true } as import("../../core/config.js").InstanceConfig });
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "delete", env_uuid: "env1" },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("confirmation_required");
  });

  it("dry-runs delete when dry_run is true", async () => {
    const ctx = makeCtx({ config: { name: "default", baseUrl: "http://coolify.test", token: "1|secret", extraHeaders: {}, enableHostOps: false, allowDestructive: true } as import("../../core/config.js").InstanceConfig });
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "delete", env_uuid: "env1", dry_run: true },
      ctx,
    );

    expect(result.status).toBe("ok");
    const r = result as Record<string, unknown>;
    expect(r.dry_run).toBe(true);
  });

  it("deletes an env var by env_uuid when allowed + confirmed", async () => {
    const ctx = makeCtx({ config: { name: "default", baseUrl: "http://coolify.test", token: "1|secret", extraHeaders: {}, enableHostOps: false, allowDestructive: true } as import("../../core/config.js").InstanceConfig });
    (ctx.api.applications.deleteEnv as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message: "Env deleted." });

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "delete", env_uuid: "env1", confirm: true },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(ctx.api.applications.deleteEnv).toHaveBeenCalledWith("abc123", "env1");
  });

  it("returns invalid_input when env_uuid is missing", async () => {
    const ctx = makeCtx();
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "delete" },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("invalid_input");
  });

  it("deletes an env from a database when allowed + confirmed", async () => {
    const ctx = makeCtx({ config: { name: "default", baseUrl: "http://coolify.test", token: "1|secret", extraHeaders: {}, enableHostOps: false, allowDestructive: true } as import("../../core/config.js").InstanceConfig });
    (ctx.api.databases.deleteEnv as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message: "Env deleted." });

    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "databases", uuid: "def456", action: "delete", env_uuid: "env2", confirm: true },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(ctx.api.databases.deleteEnv).toHaveBeenCalledWith("def456", "env2");
  });
});

describe("manage_env — invalid action", () => {
  it("returns invalid_input for unknown action", async () => {
    const ctx = makeCtx();
    const tool = findTool("manage_env");
    const result = await tool.handler(
      { type: "applications", uuid: "abc123", action: "explode" },
      ctx,
    );

    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe("invalid_input");
  });
});
