// src/mcp/tools/instances.test.ts
import { describe, it, expect } from "vitest";
import { TOOLS } from "./instances.js";
import type { ToolContext } from "./types.js";

const tool = TOOLS.find((t) => t.name === "list_instances")!;

function ctx(over: Partial<ToolContext>): ToolContext {
  return {
    api: {} as any, config: {} as any, hostOps: (async () => ({})) as any, resolver: {} as any,
    ...over,
  } as ToolContext;
}

describe("list_instances", () => {
  it("is registered as an api-tier tool with an optional instance arg", () => {
    expect(tool.tier).toBe("api");
    const props = (tool.inputSchema as any).properties ?? {};
    expect(props.instance).toMatchObject({ type: "string" });
    expect((tool.inputSchema as any).required ?? []).not.toContain("instance");
  });

  it("returns the default name and the secret-free summaries from ctx", async () => {
    const summaries = [
      { name: "prod", baseUrl: "https://prod", isDefault: true, enableHostOps: false, allowDestructive: false },
      { name: "stg",  baseUrl: "https://stg",  isDefault: false, enableHostOps: true,  allowDestructive: true },
    ];
    const res = await tool.handler({}, ctx({ instances: summaries, defaultInstance: "prod" }));
    expect(res).toEqual({ status: "ok", default: "prod", instances: summaries });
  });

  it("degrades to an empty list if ctx has no summaries", async () => {
    const res = await tool.handler({}, ctx({}));
    expect(res).toMatchObject({ status: "ok", default: undefined, instances: [] });
  });
});
