// src/mcp/server.http.test.ts — HTTP transport auth + config resolution
import { describe, it, expect } from "vitest";
import { isAuthorized, isHostAllowed, resolveHttpConfig, getAllTools } from "./server.js";

// A bearer token that satisfies the minimum-length requirement.
const STRONG_TOKEN = "strong-bearer-token-0123456789ab";

describe("isAuthorized", () => {
  const token = "s3cret-bearer-token";

  it("rejects a missing Authorization header", () => {
    expect(isAuthorized(undefined, token)).toBe(false);
    expect(isAuthorized("", token)).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(isAuthorized(`Basic ${token}`, token)).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorized("Bearer wrong-token-here", token)).toBe(false);
    expect(isAuthorized("Bearer s3cret-bearer-toke", token)).toBe(false); // shorter
  });

  it("accepts the correct token (Bearer scheme is case-insensitive)", () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`  Bearer ${token}  `, token)).toBe(true);
  });

  it("handles an array-valued header (takes the first)", () => {
    expect(isAuthorized([`Bearer ${token}`], token)).toBe(true);
    expect(isAuthorized(["Bearer nope"], token)).toBe(false);
  });
});

describe("resolveHttpConfig", () => {
  it("returns null (stdio mode) when neither flag nor env is set", () => {
    expect(resolveHttpConfig([], {})).toBeNull();
    expect(resolveHttpConfig(["--enable-host-ops"], {})).toBeNull();
  });

  it("throws if HTTP is requested without a bearer token", () => {
    expect(() => resolveHttpConfig(["--http"], {})).toThrow(/COOLIFY_MCP_HTTP_TOKEN/);
    expect(() => resolveHttpConfig([], { COOLIFY_MCP_HTTP_PORT: "3000" })).toThrow(/COOLIFY_MCP_HTTP_TOKEN/);
  });

  it("defaults to 127.0.0.1:3000 for a bare --http with a token", () => {
    expect(resolveHttpConfig(["--http"], { COOLIFY_MCP_HTTP_TOKEN: STRONG_TOKEN })).toEqual({
      host: "127.0.0.1",
      port: 3000,
      token: STRONG_TOKEN,
    });
  });

  it("rejects a too-short bearer token (weak-secret guard)", () => {
    expect(() => resolveHttpConfig(["--http"], { COOLIFY_MCP_HTTP_TOKEN: "short" })).toThrow(/COOLIFY_MCP_HTTP_TOKEN/);
    // a token at/above the minimum length is accepted
    expect(resolveHttpConfig(["--http"], { COOLIFY_MCP_HTTP_TOKEN: STRONG_TOKEN })?.token).toBe(STRONG_TOKEN);
  });

  it("reads the port from --http <port> and from COOLIFY_MCP_HTTP_PORT", () => {
    expect(resolveHttpConfig(["--http", "8080"], { COOLIFY_MCP_HTTP_TOKEN: STRONG_TOKEN })?.port).toBe(8080);
    expect(resolveHttpConfig([], { COOLIFY_MCP_HTTP_PORT: "9090", COOLIFY_MCP_HTTP_TOKEN: STRONG_TOKEN })?.port).toBe(9090);
  });

  it("honors a COOLIFY_MCP_HTTP_HOST override", () => {
    const cfg = resolveHttpConfig(["--http"], { COOLIFY_MCP_HTTP_TOKEN: STRONG_TOKEN, COOLIFY_MCP_HTTP_HOST: "0.0.0.0" });
    expect(cfg?.host).toBe("0.0.0.0");
  });

  it("parses COOLIFY_MCP_HTTP_ALLOWED_HOSTS into a trimmed list", () => {
    const cfg = resolveHttpConfig(["--http"], {
      COOLIFY_MCP_HTTP_TOKEN: STRONG_TOKEN,
      COOLIFY_MCP_HTTP_ALLOWED_HOSTS: "mcp.example.com:3000, 10.0.0.5:3000 ",
    });
    expect(cfg?.allowedHosts).toEqual(["mcp.example.com:3000", "10.0.0.5:3000"]);
  });

  it("omits allowedHosts when COOLIFY_MCP_HTTP_ALLOWED_HOSTS is unset", () => {
    expect(resolveHttpConfig(["--http"], { COOLIFY_MCP_HTTP_TOKEN: STRONG_TOKEN })?.allowedHosts).toBeUndefined();
  });
});

describe("isHostAllowed", () => {
  const allowed = ["mcp.example.com:3000", "10.0.0.5:3000"];

  it("rejects a missing Host header", () => {
    expect(isHostAllowed(undefined, allowed)).toBe(false);
  });

  it("accepts a Host in the allowlist (case-insensitive)", () => {
    expect(isHostAllowed("mcp.example.com:3000", allowed)).toBe(true);
    expect(isHostAllowed("MCP.Example.com:3000", allowed)).toBe(true);
  });

  it("rejects a Host not in the allowlist (e.g. rebinding to localhost)", () => {
    expect(isHostAllowed("localhost:3000", allowed)).toBe(false);
    expect(isHostAllowed("evil.example.com", allowed)).toBe(false);
  });
});

describe("HTTP transport never exposes the host tier", () => {
  it("the API-tier tool set (enableHostOps:false) used for HTTP excludes host tools", () => {
    // main() registers getAllTools({ enableHostOps: false }) whenever HTTP is on.
    const tools = getAllTools({ enableHostOps: false });
    expect(tools.some((t) => t.tier === "host")).toBe(false);
    expect(tools.map((t) => t.name)).not.toContain("ssh_exec");
  });
});
