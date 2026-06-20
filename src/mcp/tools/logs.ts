// src/mcp/tools/logs.ts
//
// Task 25: get_logs — API snapshot for applications; host fallback stub for
// databases and services (returns host_ops_disabled until Task 31 wires HostOps).
//
// Task 30: stream_logs — live tail via HostOps.dockerStream + progress + cancellation.
//
import { ok, err, partial, toErrorResult } from "../../core/errors.js";
import { checkFences } from "../../core/fencing.js";
import { assertCoolifyUuid } from "../../core/validate.js";
import type { ToolDef, ToolHandler, ToolContext } from "./types.js";
import type { ToolResult } from "../../core/errors.js";
import type { ResourceKind } from "../../core/api/deployments.js";

// ---------------------------------------------------------------------------
// get_logs
// ---------------------------------------------------------------------------

const getLogs: ToolHandler = async (args, ctx) => {
  const kind = args.kind as string | undefined;

  if (!kind) {
    return err("invalid_input", "kind is required. Valid values: application, database, service");
  }

  try {
    switch (kind) {
      case "application": {
        const uuid = assertCoolifyUuid(args.uuid, "uuid");
        const lines = typeof args.lines === "number" && args.lines > 0 ? args.lines : 100;
        const data = await ctx.api.applications.logs(uuid, lines);
        return ok({ logs: data.logs, lines, uuid, kind });
      }

      case "database": {
        // The Coolify REST API has no logs endpoint for databases.
        // Task 31 wires the docker logs --tail host fallback via HostOps.
        assertCoolifyUuid(args.uuid, "uuid");
        return err(
          "host_ops_disabled",
          "Database logs are not available via the Coolify REST API. Enable host-ops (--enable-host-ops) and re-run after Task 31 wires the docker logs fallback.",
        );
      }

      case "service": {
        // The Coolify REST API has no logs endpoint for services.
        // Task 31 wires the docker logs --tail host fallback via HostOps.
        assertCoolifyUuid(args.uuid, "uuid");
        return err(
          "host_ops_disabled",
          "Service logs are not available via the Coolify REST API. Enable host-ops (--enable-host-ops) and re-run after Task 31 wires the docker logs fallback.",
        );
      }

      default:
        return err(
          "invalid_input",
          `Unknown kind: ${String(kind)}. Valid values: application, database, service`,
        );
    }
  } catch (e) {
    return toErrorResult(e);
  }
};

// ---------------------------------------------------------------------------
// stream_logs  (Task 30: live tail via HostOps.dockerStream)
// ---------------------------------------------------------------------------

/** Maximum log lines buffered before truncation. */
const MAX_LINES = 1000;
/** Send a progress notification every N lines. */
const NOTIFY_EVERY_LINES = 25;
/** Default stream timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Maximum stream timeout allowed: 15 minutes. */
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

const VALID_STREAM_KINDS: ResourceKind[] = ["applications", "databases", "services"];

const streamLogs: ToolHandler = async (args, ctx: ToolContext): Promise<ToolResult> => {
  // Require host-ops tier
  const hostFence = await checkFences(ctx.config, {
    requireHostOps: true,
    args: {},
  });
  if (hostFence !== null) return hostFence;

  const kind = args["kind"] as string | undefined;
  if (!kind || !VALID_STREAM_KINDS.includes(kind as ResourceKind)) {
    return err("invalid_input", `kind must be one of: ${VALID_STREAM_KINDS.join(", ")}`);
  }
  let resourceUuid: string;
  try {
    resourceUuid = assertCoolifyUuid(args["resource_uuid"], "resource_uuid");
  } catch (e) {
    return toErrorResult(e);
  }

  const rawLines = typeof args["lines"] === "number" ? args["lines"] : 50;
  const tailLines = Math.min(Math.max(1, rawLines), 500);

  const rawTimeout = typeof args["timeout_ms"] === "number" ? args["timeout_ms"] : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(1, rawTimeout), MAX_TIMEOUT_MS);

  try {
    const hostOps = await ctx.hostOps();
    const target = await ctx.resolver.resolveByResource(kind as ResourceKind, resourceUuid);

    const logLines: string[] = [];
    let linesReceived = 0;
    let truncated = false;

    // AbortController wired to both the MCP cancellation signal and our own timeout.
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    const onLine = (line: string): void => {
      linesReceived++;
      if (logLines.length < MAX_LINES) {
        logLines.push(line);
      } else {
        truncated = true;
      }
      // Send progress notification every NOTIFY_EVERY_LINES lines
      if (linesReceived % NOTIFY_EVERY_LINES === 0 && ctx.notifier?.sendNotification) {
        ctx.notifier.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: ctx.progressToken ?? "stream_logs",
            progress: linesReceived,
            total: undefined,
            message: `stream_logs: ${linesReceived} lines received for ${kind}/${resourceUuid}`,
          },
        }).catch(() => {
          // Notification errors are non-fatal; abort if the channel is gone.
          controller.abort();
        });
      }
      // Stop collecting once we hit the hard cap but don't abort — let the stream
      // continue until the caller cancels or timeout fires, to correctly drain it.
    };

    const dockerArgs = `logs --follow --tail ${tailLines} ${resourceUuid}`;
    const streamResult = await hostOps.dockerStream(
      target,
      dockerArgs,
      onLine,
      controller.signal,
    );

    clearTimeout(timeoutHandle);

    const stopped_reason = controller.signal.aborted ? "timeout_or_cancel" : "stream_ended";
    const baseData = {
      kind,
      resource_uuid: resourceUuid,
      lines_received: linesReceived,
      log_lines: logLines,
      truncated,
      exit_code: streamResult.code,
      stopped_reason,
    };

    return ok(baseData);
  } catch (e) {
    return toErrorResult(e);
  }
};

// ---------------------------------------------------------------------------
// TOOLS export
// ---------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "get_logs",
    description: [
      "Fetch a log snapshot for a Coolify resource.",
      "• application: uses GET /applications/{uuid}/logs?lines= (REST API).",
      "• database / service: requires --enable-host-ops; the docker logs fallback is wired in Task 31.",
    ].join(" "),
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["application", "database", "service"],
          description: "Resource type whose logs to fetch.",
        },
        uuid: {
          type: "string",
          description: "Resource UUID.",
        },
        lines: {
          type: "number",
          description: "Number of log lines to retrieve (default 100). Applies to application kind.",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
      required: ["kind", "uuid"],
    },
    handler: getLogs,
  },
  {
    name: "stream_logs",
    description:
      "Tail live logs for a resource in real-time over SSH/Docker. Buffers up to 1000 lines and " +
      "sends MCP progress notifications every 25 lines. Automatically stops when the resource exits, " +
      "when the caller cancels (MCP cancellation or AbortSignal), or when timeout_ms elapses. " +
      "Requires --enable-host-ops.",
    tier: "host",
    inputSchema: {
      type: "object",
      required: ["kind", "resource_uuid"],
      properties: {
        kind: {
          type: "string",
          enum: ["applications", "databases", "services"],
          description: "Resource kind.",
        },
        resource_uuid: {
          type: "string",
          description: "UUID of the resource whose container logs to stream.",
        },
        lines: {
          type: "number",
          description: "Number of historic lines to include from the tail (--tail, default 50, max 500).",
        },
        timeout_ms: {
          type: "number",
          description:
            "Maximum milliseconds to stream before stopping (default 300000, max 900000).",
        },
        instance: { type: "string", description: "Coolify instance name (omit for the default)." },
      },
    },
    handler: streamLogs,
  },
];
