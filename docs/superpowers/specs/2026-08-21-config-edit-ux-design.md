# Config editing + CLI UX overhaul — design

Date: 2026-08-21. Status: approved (implemented inline in the same session).

## Problem

The only ways to change an existing instance are re-running the whole `init`
wizard (which overwrites the instance wholesale) or hand-editing
`~/.coolify-mcp/config.json`. There is no way to rotate a token, toggle
`allowDestructive`, or fix a baseUrl in isolation. Additionally: `--help`
silently starts the MCP server, `instances list` is terse, and output has no
color or alignment.

## Scope

CLI layer only. No changes to the MCP server surface or core config loading.
Existing patterns kept: dependency injection for I/O and network, vitest + TDD,
raw-config pass-through (unknown fields and other instances preserved verbatim,
`.bak` backup on every write).

## 1. `instances edit <name>` — interactive wizard

Re-prompts each section (API, flags, ssh, db) with current values as defaults;
Enter keeps the current value.

- Secrets display redacted (`1|****abcd` — id + last 4) and keep the stored
  value unless a new one is typed.
- Values stored as `${ENV}` references display as such and are kept verbatim
  unless replaced. Editing never silently inlines an env-referenced secret.
- If baseUrl or token changed, re-verify against the API (health + version)
  like `init`; failure aborts without writing.
- Simple prompts for ssh fields (keyPath, host, hostServer, user, port,
  passphrase, fingerprint) — no re-discovery flow (that stays in `init`).
- Only the named instance is touched.

## 2. `instances set <name> <field> [value]` / `instances unset <name> <field>`

Whitelisted dotted fields matching the schema:

| field | validation |
|---|---|
| `baseUrl` | http(s) URL, trailing slashes stripped |
| `token` | `<int>\|<secret>` format, or a literal `${ENV}` reference |
| `enableHostOps`, `allowDestructive` | `true/false/on/off/1/0` |
| `pinnedCoolifyVersion` | non-empty string |
| `ssh.keyPath`, `ssh.host`, `ssh.hostServer`, `ssh.user`, `ssh.fingerprint`, `ssh.knownHostsPath` | non-empty string |
| `ssh.port` | integer 1–65535 |
| `ssh.passphrase` | secret |
| `db.readonlyUser` | valid Postgres role name |
| `db.readonlyPassword` | secret |

- Secret fields (`token`, `ssh.passphrase`, `db.readonlyPassword`): omitting
  the value prompts masked, so secrets stay out of shell history.
- Setting `ssh.*` (other than `keyPath`) with no ssh block → error: set
  `ssh.keyPath` first. Setting `db.readonlyPassword` with no db block → error:
  set `db.readonlyUser` first.
- `unset` clears optional fields only: `pinnedCoolifyVersion`, `ssh` (whole
  block), `ssh.host|hostServer|user|port|fingerprint|passphrase|knownHostsPath`,
  `db` (whole block), `db.readonlyPassword`. Required fields (`baseUrl`,
  `token`, `ssh.keyPath`, `db.readonlyUser`) cannot be unset — unset the block.
- Unknown field → error listing valid fields.

## 3. Help + version

- `coolify-mcp --help` / `-h` / `help` prints a real overview: subcommands,
  server flags (`--enable-host-ops`, `--allow-destructive`, `--config`,
  `--header`), config precedence, examples. Exit 0, server not started.
- Per-subcommand `--help` (`init --help`, `instances --help`, `doctor --help`).
- `--version` prints the package version (injected at build time via esbuild
  define; falls back to reading package.json in dev).
- Any argv that is not a known subcommand/help/version still starts the MCP
  server, so MCP client configs are unaffected.

## 4. Output polish

- `src/cli/ansi.ts`: hand-rolled helper (green/red/yellow/bold/dim), disabled
  when `NO_COLOR` is set or stdout is not a TTY. No new dependency.
- Applied to doctor (PASS green / FAIL red / SKIP dim), init ✓/✗, error lines.
- `instances list`: aligned table, config-path header, per-instance indicators
  `ssh:✓ db:✓ env-refs:✓`.

## 5. Safer edit feedback

After `edit`/`set`/`unset`:

- Print exactly what changed as `field: old → new`, secrets always redacted.
- Auto-verify the edited instance: API health always; SSH connect only when
  ssh fields changed. `--no-verify` skips. Unresolvable `${ENV}` refs skip
  verification with a note rather than failing.
- A failed verification keeps the write; output names the `.bak` file for
  rollback.

## Testing

TDD per unit: `ansi.test.ts`, `help.test.ts`, extended `instances.test.ts`
(set/unset/edit/list), dispatch tests for help/version routing. E2E smoke via
the junction-installed binary after build.
