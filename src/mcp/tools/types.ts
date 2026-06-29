// src/mcp/tools/types.ts
import type { CoolifyApiClient } from "../../core/api/client.js";
import type { InstanceConfig } from "../../core/config/schema.js";
import type { HostOps } from "../../core/ssh/host-ops.js";
import type { ServerResolver } from "../../core/ssh/resolver.js";
import type { Notifier } from "../../core/heartbeat.js";
import type { ToolResult } from "../../core/errors.js";
import type { InstanceSummary } from "../../core/registry.js";

export interface ToolContext {
  api: CoolifyApiClient;
  config: InstanceConfig;          // was AppConfig
  hostOps: () => Promise<HostOps>; // was () => HostOps
  resolver: ServerResolver;
  notifier?: Notifier;
  progressToken?: string | number;
  instances?: InstanceSummary[];   // all configured instances (secret-free), for list_instances
  defaultInstance?: string;        // the default instance name
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  tier: "api" | "host";
}
