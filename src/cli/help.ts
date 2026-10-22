// Help and version text for the CLI. Kept dependency-free and side-effect-free
// so dispatch can print and exit without touching config or network.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Injected by esbuild at build time (see esbuild.config.mjs `define`).
declare const __PKG_VERSION__: string | undefined;

export function getVersion(): string {
  if (typeof __PKG_VERSION__ === 'string') return __PKG_VERSION__;
  // Dev fallback (vitest/tsx run the sources directly, no define available).
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

export type HelpTopic = 'init' | 'doctor' | 'instances';

const TOP = `coolify-mcp — MCP server + CLI for managing Coolify instances

Usage:
  coolify-mcp [server flags]        start the MCP server (stdio) — what MCP clients run
  coolify-mcp <command> [options]

Commands:
  init            guided setup wizard (creates or extends the config file)
  doctor          check every configured instance (API, SSH, DB role)
  instances       list and manage configured instances (see: coolify-mcp help instances)
  help [command]  show help (also: --help, -h)

Server flags (when starting the MCP server):
  --enable-host-ops       allow SSH/Docker/live-log tools
  --allow-destructive     allow destructive tools (delete/update; still per-call confirm)
  --config <path>         explicit config file
  --header K:V            extra HTTP header for the Coolify API (repeatable)

Options:
  --version               print the version
  --help, -h              show this help

Config precedence: --config > COOLIFY_CONFIG > ~/.coolify-mcp/config.json,
falling back to COOLIFY_BASE_URL/COOLIFY_TOKEN environment variables.

Examples:
  coolify-mcp init
  coolify-mcp doctor
  coolify-mcp instances set prod allowDestructive on`;

const INSTANCES = `coolify-mcp instances — list and manage configured instances

Usage:
  coolify-mcp instances [list]                     list instances (* = default)
  coolify-mcp instances default <name>             make <name> the default instance
  coolify-mcp instances rm <name>                  remove an instance
  coolify-mcp instances edit <name>                interactive edit (Enter keeps current values)
  coolify-mcp instances set <name> <field> [value] set one field
  coolify-mcp instances unset <name> <field>       clear an optional field or block

Settable fields:
  baseUrl  token  enableHostOps  allowDestructive  pinnedCoolifyVersion
  ssh.keyPath  ssh.host  ssh.hostServer  ssh.user  ssh.port  ssh.fingerprint
  ssh.knownHostsPath  ssh.passphrase  db.readonlyUser  db.readonlyPassword

Notes:
  - Omit the value for secret fields (token, ssh.passphrase, db.readonlyPassword)
    to be prompted with hidden input — keeps secrets out of shell history.
  - unset accepts optional fields, or 'ssh' / 'db' to remove a whole block.
  - After every change the instance is re-verified (API; SSH when ssh changed).
    Skip with --no-verify.

Examples:
  coolify-mcp instances set prod allowDestructive on
  coolify-mcp instances set prod token            (prompts hidden)
  coolify-mcp instances unset prod ssh
  coolify-mcp instances edit stg`;

const INIT = `coolify-mcp init — guided setup wizard

Usage:
  coolify-mcp init [--env-secrets] [--config <path>]

Creates ~/.coolify-mcp/config.json (or extends it with another instance).
Walks through API credentials, optional host-ops (SSH), and an optional
read-only DB role.

Options:
  --env-secrets    write \${ENV} references instead of inline secrets
  --config <path>  explicit config file to create/extend`;

const DOCTOR = `coolify-mcp doctor — verify every configured instance

Usage:
  coolify-mcp doctor [--config <path>]

Checks each instance: API reachability and version, control-host resolution,
SSH connectivity, and the read-only DB role (when configured).`;

export function helpText(topic?: string): string {
  switch (topic) {
    case 'instances':
      return INSTANCES;
    case 'init':
      return INIT;
    case 'doctor':
      return DOCTOR;
    default:
      return TOP;
  }
}
