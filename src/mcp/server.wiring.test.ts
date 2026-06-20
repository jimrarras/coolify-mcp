// src/mcp/server.wiring.test.ts (host-tool registration via getAllTools)
import { describe, it, expect } from "vitest";
import { getAllTools } from "./server.js";

describe("getAllTools", () => {
  it("excludes host tier when no instance enables host-ops", () => {
    expect(getAllTools({ enableHostOps: false }).some((t) => t.tier === "host")).toBe(false);
  });
  it("includes host tier when any instance enables host-ops", () => {
    const host = getAllTools({ enableHostOps: true }).filter((t) => t.tier === "host").map((t) => t.name);
    expect(host).toContain("ssh_exec");
    expect(host).toContain("query_coolify_db");
  });
});
