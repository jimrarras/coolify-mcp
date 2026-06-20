import { describe, it, expect, vi } from "vitest";
import { ServerResolver } from "./resolver.js";
import { TOOLS as hostTools } from "../../mcp/tools/host.js";

// Regression tests for the config/host-ops security re-audit fixes.

function apiWith(servers: Record<string, unknown>[]) {
  return {
    servers: {
      list: vi.fn(async () => servers),
      get: vi.fn(async (u: string) => servers.find((s) => s.uuid === u) ?? Promise.reject({ kind: "not_found" })),
    },
  } as unknown as ConstructorParameters<typeof ServerResolver>[0];
}

describe("re-audit-config: control-host selection is exact-match only (anti-hijack)", () => {
  it("does NOT select a server whose fqdn merely CONTAINS the baseUrl host", async () => {
    const r = new ServerResolver(
      apiWith([{ uuid: "evil", ip: "203.0.113.66", fqdn: "evil-coolify.example.com", user: "root", port: 22 }]),
      { baseUrl: "https://coolify.example.com" },
    );
    await expect(r.resolveControlHost()).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("still selects an EXACT fqdn match", async () => {
    const r = new ServerResolver(
      apiWith([{ uuid: "real", ip: "203.0.113.5", fqdn: "coolify.example.com", user: "root", port: 22 }]),
      { baseUrl: "https://coolify.example.com" },
    );
    expect((await r.resolveControlHost()).serverUuid).toBe("real");
  });

  it("still selects an exact ip match", async () => {
    const r = new ServerResolver(
      apiWith([{ uuid: "byip", ip: "203.0.113.5", user: "deploy", port: 2222 }]),
      { baseUrl: "https://203.0.113.5" },
    );
    expect((await r.resolveControlHost())).toMatchObject({ serverUuid: "byip", host: "203.0.113.5" });
  });
});

describe("re-audit-config: docker_op blocks Go-template braces in docker_args", () => {
  const dockerOp = hostTools.find((t) => t.name === "docker_op")!;
  const hostOpsCtx = (overrides: Record<string, unknown> = {}) =>
    ({
      config: { name: "default", enableHostOps: true, allowDestructive: false },
      hostOps: async () => ({ dockerExec: async () => ({ code: 0, stdout: "", stderr: "" }) }),
      resolver: { resolveByServer: async () => ({ serverUuid: "abc123", isCoolifyHost: true }) },
      ...overrides,
    }) as never;

  it("rejects docker_args containing a {{.Config.Env}} template", async () => {
    const res = await dockerOp.handler(
      { server: "abc123", action: "inspect", docker_args: "-f {{.Config.Env}} other123" },
      hostOpsCtx(),
    );
    expect(res).toMatchObject({ status: "error", error: { kind: "invalid_input" } });
  });

  it("does not trip the metacharacter/braces guard on brace-free docker_args", async () => {
    const res = await dockerOp.handler(
      { server: "abc123", action: "ps", docker_args: "--all --no-trunc" },
      hostOpsCtx(),
    );
    const msg = (res as { error?: { message?: string } }).error?.message ?? "";
    expect(msg).not.toMatch(/metacharacter|braces/i);
  });
});
