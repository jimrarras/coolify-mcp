// src/mcp/dispatch.test.ts
import { describe, it, expect, vi } from "vitest";
import { dispatch } from "./dispatch.js";
import { CoolifyError } from "../core/errors.js";
import type { ToolDef } from "./tools/types.js";

function fakeRegistry(byName: Record<string, any>, def = "prod") {
  return {
    names: () => Object.keys(byName),
    defaultName: () => def,
    get: (n?: string) => {
      const inst = byName[n ?? def];
      if (!inst) { throw new CoolifyError("invalid_input", `unknown instance: ${n}`); }
      return inst;
    },
  } as any;
}
const echoTool: ToolDef = {
  name: "echo", description: "", tier: "api", inputSchema: { type: "object" },
  handler: async (args, ctx) => ({ status: "ok", baseUrl: (ctx.config as any).baseUrl, sawInstanceArg: "instance" in args } as any),
};

describe("dispatch instance routing", () => {
  const reg = fakeRegistry({
    prod: { name: "prod", config: { baseUrl: "https://p" }, api: {}, resolver: {}, hostOps: async () => ({}) },
    staging: { name: "staging", config: { baseUrl: "https://s" }, api: {}, resolver: {}, hostOps: async () => ({}) },
  });
  it("routes to the default instance and strips the instance arg", async () => {
    const r = await dispatch("echo", {}, [echoTool], reg);
    const body = JSON.parse(r.content[0].text);
    expect(body.baseUrl).toBe("https://p");
    expect(body.sawInstanceArg).toBe(false);
  });
  it("routes to a named instance", async () => {
    const r = await dispatch("echo", { instance: "staging" }, [echoTool], reg);
    expect(JSON.parse(r.content[0].text).baseUrl).toBe("https://s");
  });
  it("returns invalid_input for an unknown instance", async () => {
    const r = await dispatch("echo", { instance: "nope" }, [echoTool], reg);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ status: "error", error: { kind: "invalid_input" } });
  });
});

describe("dispatch basic behavior", () => {
  const singleReg = fakeRegistry({
    prod: { name: "prod", config: { baseUrl: "https://p", enableHostOps: false, allowDestructive: false }, api: {}, resolver: {}, hostOps: async () => ({}) },
  });

  it("returns error envelope when tool is not found", async () => {
    const result = await dispatch("no_such_tool", {}, [], singleReg);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error.kind).toBe("invalid_input");
  });

  it("maps a thrown CoolifyError to an error envelope", async () => {
    const { CoolifyError } = await import("../core/errors.js");
    const tools: ToolDef[] = [
      {
        name: "boom",
        description: "Throws",
        inputSchema: {},
        tier: "api",
        handler: async () => {
          throw new CoolifyError("not_found", "resource gone", { status: 404 });
        },
      },
    ];
    const result = await dispatch("boom", {}, tools, singleReg);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error.kind).toBe("not_found");
    expect(parsed.error.message).toContain("resource gone");
  });

  it("maps an unexpected thrown error to unknown kind", async () => {
    const tools: ToolDef[] = [
      {
        name: "crash",
        description: "Raw throw",
        inputSchema: {},
        tier: "api",
        handler: async () => { throw new Error("unexpected"); },
      },
    ];
    const result = await dispatch("crash", {}, tools, singleReg);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error.kind).toBe("unknown");
  });

  it("redacts secrets in raw_response when a CoolifyError carries a secret-keyed field", async () => {
    const { CoolifyError } = await import("../core/errors.js");
    const tools: ToolDef[] = [
      {
        name: "leak",
        description: "Leaks a secret in raw_response",
        inputSchema: {},
        tier: "api",
        handler: async () => {
          throw new CoolifyError("auth", "bad credentials", {
            raw_response: { token: "supersecret123", message: "Unauthorized" },
          });
        },
      },
    ];
    const result = await dispatch("leak", {}, tools, singleReg);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error.kind).toBe("auth");
    // The secret value must be masked; the non-sensitive field is preserved
    expect(parsed.error.raw_response.token).toBe("***REDACTED***");
    expect(parsed.error.raw_response.message).toBe("Unauthorized");
  });

  it("scrubs inline secrets from error.message, not just raw_response", async () => {
    const { CoolifyError } = await import("../core/errors.js");
    const tools: ToolDef[] = [
      {
        name: "leakmsg",
        description: "Leaks a secret in the error message",
        inputSchema: {},
        tier: "api",
        handler: async () => {
          throw new CoolifyError("unknown", "exec failed: PGPASSWORD=topsecret123 psql ...");
        },
      },
    ];
    const result = await dispatch("leakmsg", {}, tools, singleReg);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.message).not.toContain("topsecret123");
    expect(parsed.error.message).toContain("PGPASSWORD=***");
  });

  it("does NOT mangle benign flag-like tokens in error.message (no -p short-flag rule)", async () => {
    const { CoolifyError } = await import("../core/errors.js");
    const tools: ToolDef[] = [
      {
        name: "flagmsg",
        description: "Throws a message with benign -p-prefixed flags",
        inputSchema: {},
        tier: "api",
        handler: async () => {
          throw new CoolifyError("unknown", "docker: unknown flag -platform; tried -p8080:80");
        },
      },
    ];
    const result = await dispatch("flagmsg", {}, tools, singleReg);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.message).toContain("-platform");
    expect(parsed.error.message).toContain("-p8080:80");
    expect(parsed.error.message).not.toContain("***");
  });
});

describe("get_servers end-to-end dispatch", () => {
  it("calls the get_servers handler via dispatch and returns ok status", async () => {
    const fakeServers = [
      { uuid: "abc123", name: "prod", ip: "1.2.3.4", reachable: true, settings: {} },
    ];

    const { TOOLS: serverTools } = await import("./tools/servers.js");

    const reg = fakeRegistry({
      default: {
        name: "default",
        config: { name: "default", baseUrl: "http://localhost", token: "1|secret", extraHeaders: {}, enableHostOps: false, allowDestructive: false },
        api: { servers: { list: vi.fn(async () => fakeServers) } },
        resolver: {},
        hostOps: async () => ({}),
      },
    }, "default");

    const result = await dispatch("get_servers", { action: "list" }, serverTools, reg);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(Array.isArray(parsed.servers)).toBe(true);
  });
});
