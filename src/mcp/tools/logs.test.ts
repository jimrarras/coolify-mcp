// src/mcp/tools/logs.test.ts
import { describe, it, expect, vi } from "vitest";
import { TOOLS } from "./logs.js";
import type { ToolContext } from "./types.js";
import type { InstanceConfig } from "../../core/config.js";

// ---- helpers ---------------------------------------------------------------

function makeCtx(overrides?: {
  enableHostOps?: boolean;
  appLogsImpl?: (uuid: string, lines: number) => Promise<{ logs: string }>;
}): ToolContext {
  const appLogsImpl =
    overrides?.appLogsImpl ??
    vi.fn(async (_uuid: string, _lines: number) => ({ logs: "line1\nline2\nline3" }));

  return {
    api: {
      applications: {
        logs: appLogsImpl,
      },
    } as unknown as ToolContext["api"],
    config: {
      name: "default",
      baseUrl: "http://coolify.example.com",
      token: "1|secret",
      extraHeaders: {},
      enableHostOps: overrides?.enableHostOps ?? false,
      allowDestructive: false,
    } as InstanceConfig,
    hostOps: async () => { throw new Error("hostOps not available in this test"); },
    resolver: {} as ToolContext["resolver"],
    notifier: undefined,
    progressToken: undefined,
  };
}

const getLogs = TOOLS.find((t) => t.name === "get_logs")!;

// ---- tool definition -------------------------------------------------------

describe("get_logs tool definition", () => {
  it("is exported in TOOLS with tier api", () => {
    expect(getLogs).toBeDefined();
    expect(getLogs.tier).toBe("api");
    expect(getLogs.name).toBe("get_logs");
  });
});

// ---- application logs (API path) -------------------------------------------

describe("get_logs kind:application", () => {
  it("returns logs for an application uuid", async () => {
    const ctx = makeCtx();
    const result = await getLogs.handler({ kind: "application", uuid: "appuuid1" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).logs).toBe("line1\nline2\nline3");
    expect((result as any).lines).toBe(100);
  });

  it("passes custom lines to the API", async () => {
    const mockLogs = vi.fn(async (_uuid: string, _lines: number) => ({ logs: "x" }));
    const ctx = makeCtx({ appLogsImpl: mockLogs });
    await getLogs.handler({ kind: "application", uuid: "appuuid1", lines: 50 }, ctx);
    expect(mockLogs).toHaveBeenCalledWith("appuuid1", 50);
  });

  it("defaults lines to 100", async () => {
    const mockLogs = vi.fn(async (_uuid: string, _lines: number) => ({ logs: "" }));
    const ctx = makeCtx({ appLogsImpl: mockLogs });
    await getLogs.handler({ kind: "application", uuid: "appuuid1" }, ctx);
    expect(mockLogs).toHaveBeenCalledWith("appuuid1", 100);
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx();
    const result = await getLogs.handler({ kind: "application" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("returns error when uuid is not a valid coolify uuid", async () => {
    const ctx = makeCtx();
    const result = await getLogs.handler({ kind: "application", uuid: "not valid uuid!" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("propagates API errors via toErrorResult", async () => {
    const { CoolifyError } = await import("../../core/errors.js");
    const ctx = makeCtx({
      appLogsImpl: async () => {
        throw new CoolifyError("not_found", "Application not found", { status: 404 });
      },
    });
    const result = await getLogs.handler({ kind: "application", uuid: "appuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("not_found");
  });
});

// ---- database logs (host-ops stub) -----------------------------------------

describe("get_logs kind:database", () => {
  it("returns host_ops_disabled when enableHostOps is false", async () => {
    const ctx = makeCtx({ enableHostOps: false });
    const result = await getLogs.handler({ kind: "database", uuid: "dbuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("host_ops_disabled");
    expect((result as any).error.message).toMatch(/host.ops/i);
  });

  it("returns host_ops_disabled even when enableHostOps is true (Task 31 wires the fallback)", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const result = await getLogs.handler({ kind: "database", uuid: "dbuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("host_ops_disabled");
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx();
    const result = await getLogs.handler({ kind: "database" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

// ---- service logs (host-ops stub) ------------------------------------------

describe("get_logs kind:service", () => {
  it("returns host_ops_disabled when enableHostOps is false", async () => {
    const ctx = makeCtx({ enableHostOps: false });
    const result = await getLogs.handler({ kind: "service", uuid: "svcuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("host_ops_disabled");
  });

  it("returns host_ops_disabled even when enableHostOps is true (Task 31 wires the fallback)", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const result = await getLogs.handler({ kind: "service", uuid: "svcuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("host_ops_disabled");
  });

  it("returns error on missing uuid", async () => {
    const ctx = makeCtx();
    const result = await getLogs.handler({ kind: "service" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});

// ---- missing / unknown kind ------------------------------------------------

describe("get_logs kind validation", () => {
  it("returns invalid_input when kind is missing", async () => {
    const ctx = makeCtx();
    const result = await getLogs.handler({ uuid: "appuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });

  it("returns invalid_input for unknown kind", async () => {
    const ctx = makeCtx();
    const result = await getLogs.handler({ kind: "banana", uuid: "appuuid1" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("invalid_input");
  });
});
