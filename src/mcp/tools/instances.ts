// src/mcp/tools/instances.ts
import { ok } from "../../core/errors.js";
import type { ToolDef, ToolHandler } from "./types.js";

const listInstances: ToolHandler = async (_args, ctx) => {
  return ok({ default: ctx.defaultInstance, instances: ctx.instances ?? [] });
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_instances",
    description: "List the Coolify instances this server is configured to drive (names, base URLs, default, and per-instance host-ops/destructive flags). Never returns tokens or other secrets. Pass an instance name as the 'instance' arg to any other tool to route to it.",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "Ignored — the instance list is global. Present for argument-shape consistency." },
      },
      required: [],
    },
    handler: listInstances,
  },
];
