// src/mcp/dispatch.ts
import { toErrorResult } from "../core/errors.js";
import { redact, scrubInlineSecrets } from "../core/redact.js";
import type { ToolResult } from "../core/errors.js";
import type { ToolDef, ToolContext } from "./tools/types.js";
import type { InstanceRegistry } from "../core/registry.js";
import type { Notifier } from "../core/heartbeat.js";

export interface DispatchResult {
  content: Array<{ type: "text"; text: string }>;
}

export async function dispatch(
  name: string,
  args: Record<string, unknown>,
  tools: ToolDef[],
  registry: InstanceRegistry,
  notifier?: Notifier,
  progressToken?: string | number,
): Promise<DispatchResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const result = {
      status: "error" as const,
      error: {
        kind: "invalid_input" as const,
        message: `Unknown tool: ${name}`,
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  let toolResult: ToolResult;
  try {
    const instanceName = typeof args.instance === "string" ? args.instance : undefined;
    const inst = registry.get(instanceName); // throws invalid_input on unknown
    const { instance: _omit, ...toolArgs } = args;
    const ctx: ToolContext = {
      api: inst.api,
      config: inst.config,
      hostOps: inst.hostOps,
      resolver: inst.resolver,
      notifier,
      progressToken,
      instances: registry.summaries(),
      defaultInstance: registry.defaultName(),
    };
    toolResult = await tool.handler(toolArgs, ctx);
  } catch (e) {
    toolResult = toErrorResult(e);
  }

  // Redact incidental secrets leaked into an error envelope before it reaches the
  // client: scrub inline credentials from the (developer-authored) message and
  // key-redact the raw_response. Success payloads are NOT redacted (e.g. manage_env
  // returns env values by design).
  if (toolResult.status === "error") {
    toolResult = {
      ...toolResult,
      error: {
        ...toolResult.error,
        // Scrub the (free-text) message without the bare `-p` short-flag rule,
        // which would mangle benign diagnostics like "unknown flag -platform".
        message: scrubInlineSecrets(toolResult.error.message, { shortPasswordFlag: false }),
        raw_response:
          toolResult.error.raw_response !== undefined
            ? redact(toolResult.error.raw_response)
            : toolResult.error.raw_response,
      },
    };
  }

  return { content: [{ type: "text", text: JSON.stringify(toolResult) }] };
}
