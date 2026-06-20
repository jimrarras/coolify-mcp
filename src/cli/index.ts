#!/usr/bin/env node
import { isMissingConfigError } from "../core/config.js";

interface DispatchDeps {
  runDoctor: (argv: string[], env: Record<string, string | undefined>, out: (l: string) => void) => Promise<number>;
  runInit: (argv: string[], env: Record<string, string | undefined>) => Promise<number>;
  runServer: () => Promise<void>;
}

/** Friendly, actionable setup guidance shown when nothing is configured yet. */
export function configGuidance(): string {
  return [
    "coolify-mcp is not configured yet.",
    "",
    "Set it up in one of these ways:",
    "  1. Guided setup (recommended):  coolify-mcp init",
    "  2. Environment variables:       set COOLIFY_BASE_URL and COOLIFY_TOKEN (token format: <id>|<secret>)",
    "  3. Config file:                 ~/.coolify-mcp/config.json",
    "",
    "Then verify with:  coolify-mcp doctor",
    "Docs: https://github.com/jimrarras/coolify-mcp#configuration",
  ].join("\n");
}

export async function dispatch(argv: string[], deps?: Partial<DispatchDeps>): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const env = process.env as Record<string, string | undefined>;

  if (sub === "doctor") {
    const runDoctor = deps?.runDoctor ?? (await import("./doctor.js")).runDoctor;
    return runDoctor(rest, env, (l) => process.stdout.write(l + "\n"));
  }
  if (sub === "init") {
    const runInit = deps?.runInit ?? (await import("./init.js")).runInit;
    return runInit(rest, env);
  }
  // No subcommand (or a server flag like --enable-host-ops): run the MCP server.
  const runServer = deps?.runServer ?? (await import("../mcp/server.js")).main;
  try {
    await runServer();
    return 0;
  } catch (e) {
    // The most common first-run failure is "not configured yet" — guide the user
    // instead of dumping a CoolifyError stack trace. Other errors stay fatal.
    if (isMissingConfigError(e)) {
      process.stderr.write(configGuidance() + "\n");
      return 1;
    }
    throw e;
  }
}

// Entry point (ignored by tests, which import { dispatch }).
const isMain = process.argv[1]
  ? new URL(import.meta.url).pathname === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).pathname
  : false;
if (isMain) {
  dispatch(process.argv.slice(2)).then(
    (code) => { if (code) process.exit(code); },
    (e) => { process.stderr.write(`[coolify-mcp] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`); process.exit(1); },
  );
}
