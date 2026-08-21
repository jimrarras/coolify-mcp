#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMissingConfigError } from "../core/config.js";
import { CoolifyError } from "../core/errors.js";

interface DispatchDeps {
  runDoctor: (argv: string[], env: Record<string, string | undefined>, out: (l: string) => void) => Promise<number>;
  runInit: (argv: string[], env: Record<string, string | undefined>) => Promise<number>;
  runInstances: (argv: string[], env: Record<string, string | undefined>, out: (l: string) => void) => Promise<number>;
  runServer: () => Promise<void>;
  out: (l: string) => void;
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

const KNOWN_SUBCOMMANDS = new Set(["doctor", "init", "instances"]);

export async function dispatch(argv: string[], deps?: Partial<DispatchDeps>): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const env = process.env as Record<string, string | undefined>;
  const { defaultPalette, paintLine } = await import("./ansi.js");
  const palette = defaultPalette();
  const out = deps?.out ?? ((l: string) => process.stdout.write(paintLine(l, palette) + "\n"));

  // Help and version short-circuit everything (including the server), so
  // `coolify-mcp --help` no longer silently starts an MCP server on stdio.
  if (sub === "--help" || sub === "-h" || sub === "help") {
    const { helpText } = await import("./help.js");
    out(helpText(sub === "help" ? rest[0] : undefined));
    return 0;
  }
  if (sub === "--version") {
    const { getVersion } = await import("./help.js");
    out(getVersion());
    return 0;
  }
  if (KNOWN_SUBCOMMANDS.has(sub ?? "") && (rest.includes("--help") || rest.includes("-h"))) {
    const { helpText } = await import("./help.js");
    out(helpText(sub));
    return 0;
  }

  if (sub === "doctor") {
    const runDoctor = deps?.runDoctor ?? (await import("./doctor.js")).runDoctor;
    return runDoctor(rest, env, out);
  }
  if (sub === "init") {
    const runInit = deps?.runInit ?? (await import("./init.js")).runInit;
    return runInit(rest, env);
  }
  if (sub === "instances") {
    const runInstances = deps?.runInstances ?? (await import("./instances.js")).runInstances;
    return runInstances(rest, env, out);
  }
  // No subcommand (or a server flag like --enable-host-ops): run the MCP server.
  const runServer = deps?.runServer ?? (await import("../mcp/server.js")).main;
  try {
    await runServer();
    return 0;
  } catch (e) {
    // The most common first-run failure is "not configured yet" — guide the user
    // through setup instead of dumping a stack trace.
    if (isMissingConfigError(e)) {
      process.stderr.write(configGuidance() + "\n");
      return 1;
    }
    // Any other CoolifyError is an expected, user-facing failure (a malformed
    // config, an unresolved ${ENV} reference, auth, …) — its message is already
    // actionable, so print it cleanly rather than as a stack trace. Only truly
    // unexpected errors rethrow and surface a stack (a real bug to report).
    if (e instanceof CoolifyError) {
      process.stderr.write(`[coolify-mcp] ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

/**
 * Is this module the process entry point? Robust to symlink/junction installs
 * (npm link, `npm install -g .` on Windows): Node realpaths the loaded module,
 * so `import.meta.url` points at the real file while argv[1] may be the linked
 * path — realpath both sides before comparing. Getting this wrong is fatal in
 * the worst way: the CLI exits 0 having done nothing.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    // .native canonicalizes case and 8.3 short names on Windows too.
    return realpathSync.native(modulePath) === realpathSync.native(argv1);
  } catch {
    // realpath failed (path vanished, EPERM, …) — fall back to a normalized
    // textual comparison so a direct invocation still starts the server.
    const norm = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();
    return norm(modulePath) === norm(argv1);
  }
}

// Entry point (ignored by tests, which import { dispatch }).
if (isMainModule(import.meta.url, process.argv[1])) {
  dispatch(process.argv.slice(2)).then(
    (code) => { if (code) process.exit(code); },
    (e) => { process.stderr.write(`[coolify-mcp] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`); process.exit(1); },
  );
}
