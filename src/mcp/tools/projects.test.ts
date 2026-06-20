import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "./projects.js";
import type { ToolContext } from "./types.js";
import type { InstanceConfig } from "../../core/config.js";

// ---- helpers ---------------------------------------------------------------

function makeCtx(overrides?: {
  enableHostOps?: boolean;
  allowDestructive?: boolean;
  projects?: Partial<{
    list: () => Promise<unknown[]>;
    get: (uuid: string) => Promise<Record<string, unknown>>;
    create: (body: { name: string; description?: string }) => Promise<{ uuid: string }>;
    update: (uuid: string, body: { name?: string; description?: string }) => Promise<Record<string, unknown>>;
    delete: (uuid: string) => Promise<{ message: string }>;
    listEnvironments: (uuid: string) => Promise<Record<string, unknown>[]>;
    createEnvironment: (uuid: string, body: { name: string }) => Promise<unknown>;
    getEnvironment: (uuid: string, nameOrUuid: string) => Promise<Record<string, unknown>>;
    deleteEnvironment: (uuid: string, nameOrUuid: string) => Promise<unknown>;
  }>;
}): ToolContext {
  const defaultProjects = {
    list: vi.fn(async () => [{ uuid: "abc123", name: "myproj" }]),
    get: vi.fn(async (_uuid: string) => ({ uuid: "abc123", name: "myproj", environments: [] })),
    create: vi.fn(async (_body: { name: string; description?: string }) => ({ uuid: "newuuid1" })),
    update: vi.fn(async (_uuid: string, _body: Record<string, unknown>) => ({ uuid: "abc123", name: "updated" })),
    delete: vi.fn(async (_uuid: string) => ({ message: "Project deleted." })),
    listEnvironments: vi.fn(async (_uuid: string) => [{ name: "production", uuid: "envuuid1" }]),
    createEnvironment: vi.fn(async (_uuid: string, _body: { name: string }) => ({ name: "staging" })),
    getEnvironment: vi.fn(async (_uuid: string, _nameOrUuid: string) => ({ name: "production", uuid: "envuuid1" })),
    deleteEnvironment: vi.fn(async (_uuid: string, _nameOrUuid: string) => ({ message: "Environment deleted." })),
    ...overrides?.projects,
  };

  return {
    api: { projects: defaultProjects } as unknown as ToolContext["api"],
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

const tool = TOOLS.find((t) => t.name === "manage_projects")!;

// ---- tests -----------------------------------------------------------------

describe("manage_projects tool definition", () => {
  it("is exported in TOOLS with tier api", () => {
    expect(tool).toBeDefined();
    expect(tool.tier).toBe("api");
    expect(tool.name).toBe("manage_projects");
  });
});

describe("manage_projects action:list", () => {
  it("returns project list", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "list" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).projects).toEqual([{ uuid: "abc123", name: "myproj" }]);
  });
});

describe("manage_projects action:get", () => {
  it("returns a single project", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get", uuid: "abc123" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).project.uuid).toBe("abc123");
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects action:create", () => {
  it("creates a project and returns uuid", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "create", name: "newproj" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).uuid).toBe("newuuid1");
  });

  it("returns error when name is missing", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "create" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects action:update", () => {
  it("updates a project", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "update", uuid: "abc123", name: "updated" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).project.name).toBe("updated");
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "update" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects action:delete", () => {
  it("blocks delete when allowDestructive is false", async () => {
    const ctx = makeCtx({ allowDestructive: false });
    const result = await tool.handler({ action: "delete", uuid: "abc123", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("blocks delete when confirm is missing", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete", uuid: "abc123" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("dry-runs delete when dry_run is true", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete", uuid: "abc123", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
  });

  it("deletes project when allowed + confirmed", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete", uuid: "abc123", confirm: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).message).toMatch(/deleted/i);
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects action:list_environments", () => {
  it("lists environments for a project", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "list_environments", uuid: "abc123" }, ctx);
    expect(result.status).toBe("ok");
    expect(Array.isArray((result as any).environments)).toBe(true);
    expect((result as any).environments[0].name).toBe("production");
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "list_environments" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects action:create_environment", () => {
  it("creates an environment", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "create_environment", uuid: "abc123", name: "staging" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).environment).toBeDefined();
  });

  it("returns error on missing project uuid", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "create_environment", name: "staging" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("returns error on missing environment name", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "create_environment", uuid: "abc123" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects action:get_environment", () => {
  it("gets a specific environment", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "production" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).environment.name).toBe("production");
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", environment: "production" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("returns error on missing environment", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects action:delete_environment", () => {
  it("blocks delete_environment when allowDestructive is false", async () => {
    const ctx = makeCtx({ allowDestructive: false });
    const result = await tool.handler({ action: "delete_environment", uuid: "abc123", environment: "production", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("blocks delete_environment when confirm is missing", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete_environment", uuid: "abc123", environment: "production" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("dry-runs delete_environment when dry_run is true", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete_environment", uuid: "abc123", environment: "production", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
    expect((result as any).preview.action).toBe("delete_environment");
  });

  it("deletes an environment when allowed + confirmed", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete_environment", uuid: "abc123", environment: "production", confirm: true }, ctx);
    expect(result.status).toBe("ok");
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete_environment", environment: "production", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

describe("manage_projects unknown action", () => {
  it("returns invalid_input for unrecognized action", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "frobnicate" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

// R8 — REST path injection regression tests for the MCP tool layer
describe("manage_projects R8 path injection hardening", () => {
  it("get_environment rejects environment value containing '/'", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "../../servers/x/disable" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("get_environment rejects environment value containing '?'", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "prod?inject=1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("get_environment rejects environment value containing '#'", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "prod#fragment" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("get_environment rejects environment value containing '%'", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "prod%2Fother" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("get_environment rejects environment value containing whitespace", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "prod env" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("get_environment accepts a clean environment name", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "production" }, ctx);
    expect(result.status).toBe("ok");
  });

  it("delete_environment rejects environment value containing '/'", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete_environment", uuid: "abc123", environment: "../../admin", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  // H2R5: dot-segment traversal — '.' and '..' survive encodeURIComponent but
  // cause URL path normalisation to traverse directories.
  it("get_environment rejects environment value '.'", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: "." }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("get_environment rejects environment value '..'", async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ action: "get_environment", uuid: "abc123", environment: ".." }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("delete_environment rejects environment value '.'", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete_environment", uuid: "abc123", environment: ".", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("delete_environment rejects environment value '..'", async () => {
    const ctx = makeCtx({ allowDestructive: true });
    const result = await tool.handler({ action: "delete_environment", uuid: "abc123", environment: "..", confirm: true }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});
