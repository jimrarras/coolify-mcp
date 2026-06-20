#!/usr/bin/env node
interface DispatchDeps {
  runDoctor: (argv: string[], env: Record<string, string | undefined>, out: (l: string) => void) => Promise<number>;
  runInit: (argv: string[], env: Record<string, string | undefined>) => Promise<number>;
  runServer: () => Promise<void>;
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
  await runServer();
  return 0;
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
