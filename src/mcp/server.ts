// src/mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../core/config.js";
import { CoolifyError } from "../core/errors.js";
import { InstanceRegistry } from "../core/registry.js";
import { withHeartbeat } from "../core/heartbeat.js";
import { dispatch } from "./dispatch.js";
import type { ToolDef } from "./tools/types.js";

import { TOOLS as deployTools } from "./tools/deploy.js";
import { TOOLS as resourceTools } from "./tools/resources.js";
import { TOOLS as storageTools } from "./tools/storage.js";
import { TOOLS as backupTools } from "./tools/backups.js";
import { TOOLS as scheduledTaskTools } from "./tools/scheduled-tasks.js";
import { TOOLS as envTools } from "./tools/env.js";
import { TOOLS as logTools } from "./tools/logs.js";
import { TOOLS as serverTools } from "./tools/servers.js";
import { TOOLS as projectTools } from "./tools/projects.js";
import { TOOLS as instanceTools } from "./tools/instances.js";
import { TOOLS as hostTools } from "./tools/host.js";

/** All ToolDefs, host tier filtered out unless enableHostOps. Exported for tests. */
export function getAllTools(flags: { enableHostOps: boolean }): ToolDef[] {
  const all = [
    ...deployTools, ...resourceTools, ...storageTools, ...backupTools, ...scheduledTaskTools,
    ...envTools, ...logTools, ...serverTools, ...projectTools, ...instanceTools, ...hostTools,
  ];
  return flags.enableHostOps ? all : all.filter((t) => t.tier !== "host");
}

export interface HttpTransportConfig {
  host: string;
  port: number;
  token: string;
  allowedHosts?: string[];
}

// Minimum bearer-token length for the HTTP transport (weak-secret guard).
const MIN_HTTP_TOKEN_LENGTH = 16;

/**
 * Resolves HTTP-transport config from `--http [port]` or COOLIFY_MCP_HTTP_PORT.
 * Returns null for the default (stdio) mode. Throws if HTTP is requested without
 * a bearer token — we refuse to expose an unauthenticated network endpoint.
 */
export function resolveHttpConfig(
  argv: string[],
  env: Record<string, string | undefined>,
): HttpTransportConfig | null {
  let port: number | undefined;
  const flagIdx = argv.indexOf("--http");
  if (flagIdx !== -1) {
    const next = argv[flagIdx + 1];
    port = next && /^\d+$/.test(next) ? parseInt(next, 10) : 3000;
  } else if (env.COOLIFY_MCP_HTTP_PORT) {
    const p = parseInt(env.COOLIFY_MCP_HTTP_PORT, 10);
    if (!Number.isNaN(p)) port = p;
  }
  if (port === undefined) return null; // stdio mode

  const token = env.COOLIFY_MCP_HTTP_TOKEN;
  if (!token) {
    throw new CoolifyError(
      "invalid_input",
      "HTTP transport requires COOLIFY_MCP_HTTP_TOKEN (a bearer token); refusing to expose an unauthenticated MCP endpoint.",
    );
  }
  // Reject a trivially weak/brute-forceable secret. The endpoint is network-facing
  // (especially on a non-loopback bind), so require meaningful entropy by length.
  if (token.length < MIN_HTTP_TOKEN_LENGTH) {
    throw new CoolifyError(
      "invalid_input",
      `COOLIFY_MCP_HTTP_TOKEN must be at least ${MIN_HTTP_TOKEN_LENGTH} characters; use a long random secret.`,
    );
  }
  const host = env.COOLIFY_MCP_HTTP_HOST ?? "127.0.0.1";
  const result: HttpTransportConfig = { host, port, token };
  const allowedHostsRaw = env.COOLIFY_MCP_HTTP_ALLOWED_HOSTS;
  if (allowedHostsRaw) {
    result.allowedHosts = allowedHostsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return result;
}

/** True when the request carries a matching `Authorization: Bearer <token>` header. */
export function isAuthorized(authHeader: string | string[] | undefined, token: string): boolean {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** True when the request's Host header is in the allowlist (DNS-rebinding defense). */
export function isHostAllowed(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  return allowedHosts.some((a) => a.trim().toLowerCase() === h);
}

function isLocalhost(host: string): boolean {
  return /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i.test(host);
}

/** Builds a configured MCP Server with the list/call handlers wired up. */
function buildServer(registry: InstanceRegistry, tools: ToolDef[]): Server {
  const multi = registry.names().length > 1;
  const server = new Server({ name: "coolify-mcp", version: "0.1.2" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: multi ? `${t.description} [instances: ${registry.names().join(", ")}; default ${registry.defaultName()}]` : t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).setRequestHandler(CallToolRequestSchema, async (req: any, extra: any) => {
    const notifier = extra as import("../core/heartbeat.js").Notifier;
    return withHeartbeat(notifier, () =>
      dispatch(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
        tools,
        registry,
        notifier,
        (req.params._meta as { progressToken?: string | number } | undefined)?.progressToken,
      ),
    );
  });

  return server;
}

/** Serves the MCP server over Streamable HTTP behind a bearer-token gate. */
async function startHttp(registry: InstanceRegistry, tools: ToolDef[], cfg: HttpTransportConfig): Promise<void> {
  // DNS-rebinding defense for non-loopback binds: validate the Host header against
  // an allowlist (the SDK's transport-level option is deprecated in favor of
  // external middleware, so we enforce it here). Loopback binds skip the check —
  // the bearer token is the primary control either way. Defaults to the bind
  // host:port; override with COOLIFY_MCP_HTTP_ALLOWED_HOSTS (needed for 0.0.0.0).
  const allowedHosts = isLocalhost(cfg.host)
    ? undefined
    : (cfg.allowedHosts && cfg.allowedHosts.length ? cfg.allowedHosts : [`${cfg.host}:${cfg.port}`]);

  const httpServer = createHttpServer((req, res) => {
    if (!isAuthorized(req.headers["authorization"], cfg.token)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
      return;
    }
    if (allowedHosts && !isHostAllowed(req.headers.host, allowedHosts)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32003, message: "Forbidden host" }, id: null }));
      return;
    }
    // Stateless mode: build a fresh server + transport PER REQUEST so concurrent
    // clients cannot collide on JSON-RPC request ids (a single shared transport
    // would interleave their messages). Both are torn down when the response closes.
    const server = buildServer(registry, tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    (async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((e: unknown) => {
      process.stderr.write(`[coolify-mcp] HTTP request error: ${e instanceof Error ? e.message : String(e)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, resolve));
  process.stderr.write(
    `[coolify-mcp] HTTP transport on http://${cfg.host}:${cfg.port} (API tier only — host-ops is never exposed over HTTP)\n`,
  );
}

export async function main(): Promise<void> {
  const cfg = loadConfig(process.argv.slice(2), process.env as Record<string, string | undefined>);
  const httpCfg = resolveHttpConfig(process.argv.slice(2), process.env as Record<string, string | undefined>);
  const registry = new InstanceRegistry(cfg);

  // Host-ops registration is the union: if ANY instance enables it, include host
  // tools — but ONLY on stdio. The host tier (root SSH/Docker/psql) is never
  // exposed over the network HTTP transport, regardless of enableHostOps.
  const anyHostOps = Object.values(cfg.instances).some((i) => i.enableHostOps);
  const tools = getAllTools({ enableHostOps: httpCfg ? false : anyHostOps });

  // Per-instance startup probe (non-fatal).
  for (const name of registry.names()) {
    try {
      const inst = registry.get(name);
      await inst.api.health();
      const version = await inst.api.version();
      const pinned = inst.config.pinnedCoolifyVersion;
      if (version && pinned && version !== pinned) {
        process.stderr.write(`[coolify-mcp] WARNING: instance '${name}' Coolify ${version} differs from pinned ${pinned}.\n`);
      }
    } catch (e) {
      process.stderr.write(`[coolify-mcp] WARNING: instance '${name}' startup health check failed: ${e instanceof Error ? e.message : String(e)}. Run 'coolify-mcp doctor' to diagnose.\n`);
    }
  }

  if (httpCfg) {
    if (!isLocalhost(httpCfg.host)) {
      process.stderr.write(
        `[coolify-mcp] WARNING: HTTP transport bound to non-localhost ${httpCfg.host}. Ensure COOLIFY_MCP_HTTP_TOKEN is strong, set COOLIFY_MCP_HTTP_ALLOWED_HOSTS to your client-facing host:port, and firewall the port.\n`,
      );
    }
    await startHttp(registry, tools, httpCfg);
  } else {
    const server = buildServer(registry, tools);
    await server.connect(new StdioServerTransport());
  }
}

// main() is invoked by the CLI entry point (src/cli/index.ts), which is the
// single executable entry. This module deliberately does NOT auto-run on import:
// in the esbuild single-file bundle it shares import.meta.url with the CLI entry,
// so a self-`isMain` guard here would fire a second main() (a double stdio
// connect, or an EADDRINUSE crash under the HTTP transport).
