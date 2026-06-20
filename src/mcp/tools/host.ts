// src/mcp/tools/host.ts
import { ok, err, partial, toErrorResult } from "../../core/errors.js";
import { checkFences } from "../../core/fencing.js";
import { assertCoolifyServerRef } from "../../core/validate.js";
import { redact, scrubInlineSecrets } from "../../core/redact.js";
import type { ToolDef, ToolContext } from "./types.js";
import type { ToolResult } from "../../core/errors.js";

// Safe read-only docker sub-commands (allowlist).  Any action NOT in this set
// is treated as destructive and requires --allow-destructive + confirm:true.
const SAFE_READONLY_DOCKER_ACTIONS = new Set([
  "ps",
  "images",
  "inspect",
  "stats",
  "logs",
  "version",
  "info",
  "top",
  "port",
  "diff",
]);

/** Docker action must be lowercase alpha-only (e.g. "ps", "logs"). */
const DOCKER_ACTION_RE = /^[a-z]+$/;

/**
 * Shell metacharacters + Go-template braces that must never appear in docker_args.
 * Braces ({}) are blocked to defeat `--format`/`-f` template extraction such as
 * `inspect -f {{.Config.Env}}`, which would surface other containers' secrets.
 */
const SHELL_META_RE = /[;|&`$(){}<>\n]/;

function isDestructiveDockerAction(action: string): boolean {
  return !SAFE_READONLY_DOCKER_ACTIONS.has(action.trim().toLowerCase());
}

// ────────────────────────────────────────────────────────────────────────────
// ssh_exec
// ────────────────────────────────────────────────────────────────────────────
const sshExecTool: ToolDef = {
  name: "ssh_exec",
  description:
    "Run an arbitrary shell command on the Coolify host (or a connected server) over SSH. " +
    "Requires --enable-host-ops AND --allow-destructive. " +
    "Pass confirm:true to acknowledge the destructive nature. " +
    "Returns stdout, stderr, and exit code.",
  inputSchema: {
    type: "object",
    required: ["server", "command"],
    properties: {
      server: {
        type: "string",
        description: "Server UUID or name to target.",
      },
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      confirm: {
        type: "boolean",
        description: "Set true to confirm this destructive arbitrary-exec operation.",
      },
      dry_run: {
        type: "boolean",
        description:
          "If true, return a preview of the operation (server + best-effort credential-scrubbed command) without executing. Avoid embedding secrets in the command string — scrubbing is not exhaustive.",
      },
      instance: { type: "string", description: "Coolify instance name (omit for the default)." },
    },
  },
  tier: "host",
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    // Validate inputs early so preview can include the resolved values.
    let serverUuid: string;
    try {
      serverUuid = assertCoolifyServerRef(args["server"], "server");
    } catch (e) {
      return toErrorResult(e);
    }
    const command = args["command"];
    if (typeof command !== "string" || command.trim() === "") {
      return err("invalid_input", "command is required and must be a non-empty string");
    }

    const confirm = args["confirm"] === true;
    const dry_run = args["dry_run"] === true;

    // ssh_exec is the most dangerous op: fence as destructive + host-ops.
    const fence = await checkFences(ctx.config, {
      destructive: true,
      requireHostOps: true,
      args: { confirm, dry_run },
      preview: async () => {
        // Best-effort scrub of inline credentials, then key-based redact.
        const raw = { server: serverUuid, command: scrubInlineSecrets(command) };
        return redact(raw);
      },
    });
    if (fence !== null) return fence;

    // Emit a structured audit line to stderr BEFORE executing. Best-effort scrub
    // inline credentials in the command, then key-based redact the payload.
    const auditPayload = redact({ tool: "ssh_exec", server: serverUuid, command: scrubInlineSecrets(command) });
    process.stderr.write(`[ssh_exec] audit: ${JSON.stringify(auditPayload)}\n`);

    try {
      const hostOps = await ctx.hostOps();
      const target = await ctx.resolver.resolveByServer(serverUuid);
      const result = await hostOps.rawExec(target, command);
      if (result.code !== 0) {
        return partial({
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      return ok({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    } catch (e) {
      return toErrorResult(e);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// docker_op
// ────────────────────────────────────────────────────────────────────────────
const dockerOpTool: ToolDef = {
  name: "docker_op",
  description:
    "Run a Docker CLI operation on a server. Non-mutating actions (ps, images, logs, inspect, stats) " +
    "are always allowed when host-ops is on. Mutating actions (rm, rmi, stop, kill, restart, prune, exec, etc.) " +
    "additionally require --allow-destructive and confirm:true.",
  inputSchema: {
    type: "object",
    required: ["server", "action", "docker_args"],
    properties: {
      server: {
        type: "string",
        description: "Server UUID or name to target.",
      },
      action: {
        type: "string",
        description: "Docker sub-command, e.g. ps, logs, inspect, rm, stop, exec.",
      },
      docker_args: {
        type: "string",
        description: "Additional arguments appended after the sub-command.",
      },
      confirm: {
        type: "boolean",
        description: "Set true to confirm destructive docker actions.",
      },
      dry_run: {
        type: "boolean",
        description: "If true and action is destructive, return a preview without executing.",
      },
      instance: { type: "string", description: "Coolify instance name (omit for the default)." },
    },
  },
  tier: "host",
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    // Always require host-ops
    const hostFence = await checkFences(ctx.config, {
      requireHostOps: true,
      args: {},
    });
    if (hostFence !== null) return hostFence;

    const server = args["server"];
    let serverUuid: string;
    try {
      serverUuid = assertCoolifyServerRef(server, "server");
    } catch (e) {
      return toErrorResult(e);
    }
    const action = args["action"];
    if (typeof action !== "string" || action.trim() === "") {
      return err("invalid_input", "action is required and must be a non-empty string");
    }
    // Action must be lowercase alpha-only to prevent metacharacter injection.
    if (!DOCKER_ACTION_RE.test(action)) {
      return err(
        "invalid_input",
        `docker action must match /^[a-z]+$/ (lowercase letters only); got: ${JSON.stringify(action)}`,
      );
    }
    const dockerArgs = typeof args["docker_args"] === "string" ? args["docker_args"] : "";
    // Reject docker_args containing shell metacharacters.
    if (SHELL_META_RE.test(dockerArgs)) {
      return err(
        "invalid_input",
        "docker_args must not contain shell metacharacters or template braces (; | & ` $ ( ) { } < > or newlines)",
      );
    }
    const confirm = args["confirm"] === true;
    const dry_run = args["dry_run"] === true;

    const destructive = isDestructiveDockerAction(action);
    if (destructive) {
      const destructiveFence = await checkFences(ctx.config, {
        destructive: true,
        requireHostOps: true,
        args: { confirm, dry_run },
        preview: async () => {
          // Mirror ssh_exec's preview hygiene: best-effort scrub of inline
          // credentials in docker_args, then key-based redact, so a secret in
          // (e.g.) `run -e PGPASSWORD=…` is masked in the confirmation/dry-run preview.
          const scrubbedArgs = scrubInlineSecrets(dockerArgs);
          return redact({
            server: serverUuid,
            action,
            docker_args: scrubbedArgs,
            full_command: `docker ${action} ${scrubbedArgs}`.trim(),
          });
        },
      });
      if (destructiveFence !== null) return destructiveFence;
    }

    try {
      const hostOps = await ctx.hostOps();
      const target = await ctx.resolver.resolveByServer(serverUuid);
      const fullDockerArgs = `${action} ${dockerArgs}`.trim();
      const result = await hostOps.dockerExec(target, fullDockerArgs);
      if (result.code !== 0) {
        return partial({
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      return ok({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    } catch (e) {
      return toErrorResult(e);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// query_coolify_db
// ────────────────────────────────────────────────────────────────────────────
const queryCoolifyDbTool: ToolDef = {
  name: "query_coolify_db",
  description:
    "Execute a read-only SQL query against the Coolify PostgreSQL database (SELECT only). " +
    "Runs inside the coolify-db Docker container via psql. Requires --enable-host-ops.",
  inputSchema: {
    type: "object",
    required: ["sql"],
    properties: {
      sql: {
        type: "string",
        description: "A SELECT SQL statement to execute. Non-SELECT statements are rejected.",
      },
      instance: { type: "string", description: "Coolify instance name (omit for the default)." },
    },
  },
  tier: "host",
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const fence = await checkFences(ctx.config, {
      requireHostOps: true,
      args: {},
    });
    if (fence !== null) return fence;

    const sql = args["sql"];
    if (typeof sql !== "string" || sql.trim() === "") {
      return err("invalid_input", "sql is required and must be a non-empty string");
    }

    try {
      const hostOps = await ctx.hostOps();
      const rows = await hostOps.psqlReadOnly(sql);
      return ok({ rows });
    } catch (e) {
      return toErrorResult(e);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// read_host_file
// ────────────────────────────────────────────────────────────────────────────
const readHostFileTool: ToolDef = {
  name: "read_host_file",
  description:
    "Read the contents of an allowed file on the Coolify host. " +
    "Permitted paths: /data/coolify/source/.env, /data/coolify/proxy/**, /data/coolify/**. " +
    "Requires --enable-host-ops.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Absolute path on the Coolify host. Must be in an allowed prefix.",
      },
      instance: { type: "string", description: "Coolify instance name (omit for the default)." },
    },
  },
  tier: "host",
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const fence = await checkFences(ctx.config, {
      requireHostOps: true,
      args: {},
    });
    if (fence !== null) return fence;

    const path = args["path"];
    if (typeof path !== "string" || path.trim() === "") {
      return err("invalid_input", "path is required and must be a non-empty string");
    }

    try {
      const hostOps = await ctx.hostOps();
      const contents = await hostOps.readHostFile(path);
      return ok({ path, contents });
    } catch (e) {
      return toErrorResult(e);
    }
  },
};

export const TOOLS: ToolDef[] = [
  sshExecTool,
  dockerOpTool,
  queryCoolifyDbTool,
  readHostFileTool,
];
