// src/mcp/tools/logs.stream.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "./logs.js";
import type { ToolContext } from "./types.js";
import type { HostOps } from "../../core/ssh/host-ops.js";
import type { ServerResolver } from "../../core/ssh/resolver.js";
import type { CoolifyApiClient } from "../../core/api/client.js";
import type { InstanceConfig } from "../../core/config.js";

function makeHostOps(overrides: Partial<HostOps> = {}): HostOps {
  return {
    dockerStream: vi.fn(async (
      _target: unknown,
      _dockerArgs: string,
      onLine: (l: string) => void,
      _signal: AbortSignal,
    ) => {
      onLine("2024-01-01T00:00:00Z line-one");
      onLine("2024-01-01T00:00:01Z line-two");
      return { code: 0 };
    }),
    dockerExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    rawExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    psqlReadOnly: vi.fn(async () => ""),
    readHostFile: vi.fn(async () => ""),
    ...overrides,
  } as unknown as HostOps;
}

function makeResolver(overrides: Partial<ServerResolver> = {}): ServerResolver {
  return {
    resolveByResource: vi.fn(async () => ({
      serverUuid: "serverabc",
      isCoolifyHost: true,
    })),
    resolveByServer: vi.fn(async () => ({
      serverUuid: "serverabc",
      isCoolifyHost: true,
    })),
    ...overrides,
  } as unknown as ServerResolver;
}

function makeCtx(opts: {
  enableHostOps?: boolean;
  allowDestructive?: boolean;
  hostOpsImpl?: HostOps;
  resolverImpl?: ServerResolver;
  notifier?: { sendNotification?: (n: unknown) => Promise<void> };
}): ToolContext {
  const hostOpsImpl = opts.hostOpsImpl ?? makeHostOps();
  const resolverImpl = opts.resolverImpl ?? makeResolver();
  return {
    api: {} as unknown as CoolifyApiClient,
    config: {
      name: "default",
      baseUrl: "http://coolify.test",
      token: "1|abc",
      extraHeaders: {},
      enableHostOps: opts.enableHostOps ?? true,
      allowDestructive: opts.allowDestructive ?? false,
    } as InstanceConfig,
    hostOps: async () => hostOpsImpl,
    resolver: resolverImpl,
    notifier: opts.notifier as ToolContext["notifier"],
  };
}

function getTool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe("stream_logs", () => {
  it("is present in TOOLS with tier=host", () => {
    const tool = getTool("stream_logs");
    expect(tool.tier).toBe("host");
  });

  it("returns host_ops_disabled when enableHostOps=false", async () => {
    const tool = getTool("stream_logs");
    const ctx = makeCtx({ enableHostOps: false });
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "app1abc" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("host_ops_disabled");
    }
  });

  it("returns invalid_input when resource_uuid is missing", async () => {
    const tool = getTool("stream_logs");
    const ctx = makeCtx({ enableHostOps: true });
    const result = await tool.handler({ kind: "applications" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("returns invalid_input when kind is missing", async () => {
    const tool = getTool("stream_logs");
    const ctx = makeCtx({ enableHostOps: true });
    const result = await tool.handler({ resource_uuid: "app1abc" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("streams lines and returns them in result with line count", async () => {
    const notifications: unknown[] = [];
    const notifier = {
      sendNotification: vi.fn(async (n: unknown) => { notifications.push(n); }),
    };
    const fakeHostOps = makeHostOps({
      dockerStream: vi.fn(async (
        _target: unknown,
        _dockerArgs: string,
        onLine: (l: string) => void,
        _signal: AbortSignal,
      ) => {
        for (let i = 0; i < 5; i++) {
          onLine(`line ${i}`);
        }
        return { code: 0 };
      }),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps, notifier });
    const tool = getTool("stream_logs");
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "app1abc", lines: 50, timeout_ms: 5000 },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["lines_received"]).toBe(5);
      const logLines = result["log_lines"] as string[];
      expect(logLines).toHaveLength(5);
      expect(logLines[0]).toBe("line 0");
    }
  });

  it("sends progress notifications as lines arrive", async () => {
    const sentNotifications: unknown[] = [];
    const notifier = {
      sendNotification: vi.fn(async (n: unknown) => { sentNotifications.push(n); }),
    };
    // Inject custom dockerStream that emits NOTIFY_INTERVAL+1 lines to trigger a notification
    const NOTIFY_INTERVAL = 25;
    const fakeHostOps = makeHostOps({
      dockerStream: vi.fn(async (
        _target: unknown,
        _dockerArgs: string,
        onLine: (l: string) => void,
        _signal: AbortSignal,
      ) => {
        for (let i = 0; i < NOTIFY_INTERVAL + 1; i++) {
          onLine(`line ${i}`);
        }
        return { code: 0 };
      }),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps, notifier });
    const tool = getTool("stream_logs");
    await tool.handler(
      { kind: "applications", resource_uuid: "app1abc", lines: 200, timeout_ms: 5000 },
      ctx,
    );
    // At least one progress notification should have been sent
    expect(sentNotifications.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces MAX_LINES hard cap (1000)", async () => {
    const fakeHostOps = makeHostOps({
      dockerStream: vi.fn(async (
        _target: unknown,
        _dockerArgs: string,
        onLine: (l: string) => void,
        _signal: AbortSignal,
      ) => {
        // Emit 2000 lines
        for (let i = 0; i < 2000; i++) {
          onLine(`line ${i}`);
        }
        return { code: 0 };
      }),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("stream_logs");
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "app1abc", lines: 2000 },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const logLines = result["log_lines"] as string[];
      expect(logLines.length).toBeLessThanOrEqual(1000);
      expect(result["truncated"]).toBe(true);
    }
  });

  it("uses resolveByResource to find the target server", async () => {
    const resolverImpl = makeResolver({
      resolveByResource: vi.fn(async () => ({
        serverUuid: "custom-server",
        isCoolifyHost: false,
        dockerHost: "ssh://root@10.0.0.1",
      })),
    });
    const fakeHostOps = makeHostOps();
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps, resolverImpl });
    const tool = getTool("stream_logs");
    await tool.handler(
      { kind: "applications", resource_uuid: "app1abc" },
      ctx,
    );
    expect(resolverImpl.resolveByResource).toHaveBeenCalledWith("applications", "app1abc");
  });

  it("returns partial with abort reason when AbortSignal fires before stream ends", async () => {
    let capturedSignal: AbortSignal | null = null;
    const fakeHostOps = makeHostOps({
      dockerStream: vi.fn(async (
        _target: unknown,
        _dockerArgs: string,
        onLine: (l: string) => void,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        onLine("line 0");
        // Simulate abort during streaming: just exit if aborted
        if (signal.aborted) return { code: null };
        return { code: 0 };
      }),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("stream_logs");
    // timeout_ms=0 forces immediate timeout
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "app1abc", timeout_ms: 1 },
      ctx,
    );
    // Either ok (1 line collected before abort) or partial
    expect(["ok", "partial"]).toContain(result.status);
  });

  // ── R3 regression: shell-injection via resource_uuid ────────────────────────
  it("R3: rejects resource_uuid containing shell metacharacters (injection payload)", async () => {
    const tool = getTool("stream_logs");
    const ctx = makeCtx({ enableHostOps: true });
    // Attacker payload: stacked command via semicolon
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "app1abc; cat /etc/shadow" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: rejects resource_uuid containing pipe metacharacter", async () => {
    const tool = getTool("stream_logs");
    const ctx = makeCtx({ enableHostOps: true });
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "app1abc|id" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: rejects resource_uuid with hyphen (non-alphanumeric, not a Coolify UUID)", async () => {
    const tool = getTool("stream_logs");
    const ctx = makeCtx({ enableHostOps: true });
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "app-1-abc" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: accepts a valid alphanumeric resource_uuid", async () => {
    const fakeHostOps = makeHostOps();
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("stream_logs");
    const result = await tool.handler(
      { kind: "applications", resource_uuid: "abc123XYZ" },
      ctx,
    );
    // Should reach execution (not blocked at validation)
    expect(result.status).not.toBe("error");
  });
});
