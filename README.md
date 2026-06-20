# coolify-mcp

A TypeScript MCP server that drives a self-hosted [Coolify](https://coolify.io) instance.
Full REST CRUD, deploy/watch, and a flag-gated host-ops tier (SSH + Docker + psql) for live log streaming and ad-hoc access.

## Quick Start

```bash
# Install from npm
npm install -g @jimrarras/coolify-mcp
# …or run ad-hoc without installing:  npx -y @jimrarras/coolify-mcp doctor
#
# (Or install the latest straight from GitHub: npm install -g github:jimrarras/coolify-mcp)
#
# The published build is a single self-contained bundle with ZERO native/runtime
# dependencies — it installs on any machine with no C/C++ toolchain and runs no
# install scripts. No flags needed.

# Configure — guided wizard writes ~/.coolify-mcp/config.json (recommended)
coolify-mcp init

# …or just set the two required env vars (token format: <id>|<secret>):
export COOLIFY_BASE_URL="https://coolify.example.com"
export COOLIFY_TOKEN="<id>|<secret>"

# Run (API tier only)
coolify-mcp

# Run with host-ops (SSH access) enabled
coolify-mcp --enable-host-ops

# Run with destructive actions allowed (requires confirm:true per-call)
coolify-mcp --enable-host-ops --allow-destructive
```

### Guided setup (recommended)

Two commands take you from installed to working:

```bash
coolify-mcp init      # one-time interactive wizard — writes ~/.coolify-mcp/config.json
coolify-mcp doctor    # verify the setup any time, with a specific fix for each failure
```

> Prefer not to touch a config file? The [zero-file env-var mode](#1-zero-file-quick-start)
> (just `COOLIFY_BASE_URL` + `COOLIFY_TOKEN`) still works for the API tier — `init` is for a
> guided setup that also wires up host-ops.

#### What `init` asks

1. **Base URL + API token** — validated live against your instance before continuing. The token
   must be `<id>|<secret>` with scope **write + read:sensitive**.
2. **Enable host-ops?** If yes, it resolves the SSH control host. On a standard single-server
   install Coolify reports the host's IP as `host.docker.internal`, so auto-detect can't match it —
   `init` then **lists your servers and asks you to pick** the control host (anti-hijack: it won't
   silently guess). It substitutes your `baseUrl` host as the reachable SSH address.
3. It then **auto-discovers a working SSH key** — it scans `~/.ssh`, tries each OpenSSH key against
   the host, and prompts (masked) for a passphrase if the key needs one. (A PuTTY `.ppk` is detected
   and you're told to export an OpenSSH key first.)
4. It shows the host's **key fingerprint** and asks you to confirm before pinning it.
5. **Enable `query_coolify_db`?** If yes, it prints ready-to-run `CREATE ROLE … GRANT … REVOKE …`
   SQL (with a generated password) for you to run on your Coolify Postgres.

It writes `~/.coolify-mcp/config.json` (backing up any existing one) with **secrets as `${ENV}`
references, never inline** — for example:

```jsonc
{
  "defaultInstance": "default",
  "instances": {
    "default": {
      "baseUrl": "https://coolify.example.com",
      "token": "${COOLIFY_TOKEN}",
      "enableHostOps": true,
      "allowDestructive": false,
      "ssh": {
        "keyPath": "/home/you/.ssh/id_ed25519",
        "hostServer": "<control-server-uuid>",
        "fingerprint": "SHA256:…",
        "passphrase": "${COOLIFY_SSH_KEY_PASSPHRASE}"
      }
    }
  }
}
```

…then prints the env vars to set (`COOLIFY_TOKEN`, `COOLIFY_SSH_KEY_PASSPHRASE`, …) and the
MCP-client snippet to paste. Set those env vars in your MCP client's `env` block (or shell), since
the `${ENV}` references are expanded at startup.

#### `doctor`

`doctor` runs read-only checks and prints a fix for anything that fails (add `--enable-host-ops`
to include the SSH/DB checks):

```
$ coolify-mcp doctor --enable-host-ops
── instance: default ──
PASS  api — Coolify 4.1.2 reachable
PASS  control_host — root@coolify.example.com:22 (using baseUrl host)
PASS  ssh — SSH root@coolify.example.com:22 OK
SKIP  db_role — query_coolify_db not configured
```

It exits non-zero if any check fails, so it's usable as a preflight in scripts.

Add to your MCP client config (e.g. `~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "coolify": {
      "command": "coolify-mcp",
      "args": [],
      "env": {
        "COOLIFY_BASE_URL": "https://coolify.example.com",
        "COOLIFY_TOKEN": "<id>|<secret>"
      }
    }
  }
}
```

## Configuration

### 1. Zero-file quick start

Set two environment variables and run — no config file needed:

```bash
export COOLIFY_BASE_URL="https://coolify.example.com"
export COOLIFY_TOKEN="<id>|<secret>"
coolify-mcp
```

The token format is `<id>|<secret>` — both parts required. The `id` is an integer; the `secret` is an alphanumeric string.

### 2. Config file

For multi-instance setups or richer per-instance settings, supply a JSON config file.

**File resolution order:**
1. `--config <path>` CLI flag
2. `COOLIFY_CONFIG` environment variable
3. `~/.coolify-mcp/config.json` (auto-discovered if present)
4. Falls back to env-var mode (step 1) if none of the above exists

**`${ENV}` expansion** is applied to every string value in the file, including nested ones.  
`${VAR}` — substitutes the environment variable; throws if unset.  
`${VAR:-default}` — uses `default` when `VAR` is unset or absent.

Only `baseUrl` and `token` are required per instance; everything else is optional and defaults to safe values.

See [`config.example.json`](./config.example.json) for a full multi-instance example.

### 3. Host-ops configuration

To enable SSH access, set `"enableHostOps": true` and provide `ssh.keyPath`.  
The SSH **host**, **user**, and **port** are **auto-derived** from the Coolify API — no need to set them manually.

> **Single-server installs (`host.docker.internal`).** Coolify's built-in "localhost" server often
> reports its `ip` as `host.docker.internal` (a Docker-internal alias) that a remote workstation can't
> SSH to. Two things handle this:
> - **Select the control host explicitly** with `ssh.hostServer` (its UUID or name) — required because
>   a non-matching server is not auto-selected (anti-hijack). When the selected server's `ip` is a
>   non-routable alias, coolify-mcp automatically substitutes the `baseUrl` host (which is reachable and
>   operator-trusted).
> - **Override the SSH address** with `ssh.host` when even the `baseUrl` host isn't SSH-reachable (e.g.
>   it's behind a proxy/CDN) — set it to the server's real IP/hostname.
>
> Minimal host-ops config for a standard single-server install:
> ```json
> "ssh": { "keyPath": "~/.ssh/id_ed25519", "hostServer": "<server-uuid-or-name>" }
> ```
> Add `"host": "<reachable-ip>"` if `baseUrl` isn't directly SSH-reachable.

```json
"ssh": {
  "keyPath": "~/.ssh/id_ed25519"
}
```

Tilde (`~`) is expanded to the home directory. Optional overrides:

| Field | Description |
|---|---|
| `ssh.keyPath` | Path to the SSH private key (required for host-ops). |
| `ssh.host` | Explicit SSH host/IP override. Use when the API-derived address isn't reachable (e.g. it reports `host.docker.internal`, or `baseUrl` is behind a proxy). Takes precedence over auto-derivation. |
| `ssh.knownHostsPath` | Path to a known_hosts file. Defaults to `~/.ssh/known_hosts`. |
| `ssh.fingerprint` | SHA-256 host fingerprint (alternative to known_hosts). |
| `ssh.hostServer` | UUID or name of the Coolify control server (override when auto-match fails). |
| `ssh.user` | SSH user override (else from API). |
| `ssh.port` | SSH port override (else from API). |
| `ssh.passphrase` | Private key passphrase. |

**SSH host-key verification is fail-closed.** The server will not connect unless the key presented by the remote host matches either `ssh.fingerprint` (SHA-256, from `ssh-keyscan <host> | ssh-keygen -lf -`) or the appropriate entry in `ssh.knownHostsPath` / `~/.ssh/known_hosts`. A missing or non-matching entry is an immediate connection refusal. Note: known_hosts matching is **literal** — wildcard (`*.example.com`) and hashed (`|1|...`) entries are not matched; use `ssh.fingerprint` or a literal host line for those hosts.

**Threat-model note (host-ops trusts the Coolify API).** The SSH host/user/port are derived from the Coolify API (`GET /servers`). A **compromised Coolify API** could therefore influence which host the MCP connects to — but this is bounded by the fail-closed host-key verification above (a redirect to an untrusted host is refused). For the strongest assurance set `ssh.fingerprint` to **pin** the control host's key regardless of `known_hosts`. Connections to remote managed servers run via `docker -H ssh://…` *on the Coolify host*, so that hop is governed by the Coolify host's own SSH trust store rather than this client's.

### 4. `query_coolify_db` — read-only DB role

Set `db.readonlyUser` per instance to enable the `query_coolify_db` tool. The in-code SQL blocklist and output redaction are best-effort defense-in-depth only — they cannot make arbitrary free-form SQL safe. **You MUST provision the role so PostgreSQL enforces the constraints:**

```sql
CREATE ROLE coolify_ro LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE coolify TO coolify_ro;
GRANT USAGE ON SCHEMA public TO coolify_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO coolify_ro;   -- omit sensitive tables/columns you don't want exposed
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM coolify_ro;  -- blocks adminpack/dblink/file fns
-- do NOT grant pg_read_server_files / pg_write_server_files / pg_execute_server_program / superuser
```

Treat `query_coolify_db` output as "whatever this role may SELECT" — redaction reduces incidental leakage but is not guaranteed.

### 5. Multi-instance + per-call `instance` selector

A single `coolify-mcp` process can drive multiple Coolify instances simultaneously.  
Every tool exposes an optional `instance` argument; omit it to use the default instance.

```jsonc
// config.json
{
  "defaultInstance": "prod",
  "instances": {
    "prod":    { "baseUrl": "https://coolify.prod.example.com",    "token": "${PROD_TOKEN}" },
    "staging": { "baseUrl": "https://coolify.staging.example.com", "token": "${STAGING_TOKEN}" }
  }
}
```

Example tool call routing to the non-default instance:
```json
{ "tool": "list_resources", "arguments": { "instance": "staging", "type": "applications" } }
```

`enableHostOps`/`allowDestructive` are **per-instance** — you can allow destructive actions on staging while keeping them blocked on prod.

### 6. CLI flags + back-compat

When no config file is used, the legacy flags and environment variables still work and map onto the synthesized `default` instance:

| Flag / Variable | Maps to |
|---|---|
| `--enable-host-ops` | `instances.default.enableHostOps = true` |
| `--allow-destructive` | `instances.default.allowDestructive = true` |
| `COOLIFY_SSH_KEY_PATH` | `instances.default.ssh.keyPath` |
| `COOLIFY_SSH_HOST` | `instances.default.ssh.host` |
| `COOLIFY_SSH_KNOWN_HOST_FINGERPRINT` | `instances.default.ssh.fingerprint` |
| `COOLIFY_SSH_KNOWN_HOSTS_PATH` | `instances.default.ssh.knownHostsPath` |
| `COOLIFY_SSH_USER` | `instances.default.ssh.user` |
| `COOLIFY_SSH_PORT` | `instances.default.ssh.port` |
| `COOLIFY_SSH_KEY_PASSPHRASE` | `instances.default.ssh.passphrase` |
| `COOLIFY_SSH_HOST_SERVER` | `instances.default.ssh.hostServer` |
| `COOLIFY_DB_READONLY_USER` | `instances.default.db.readonlyUser` |
| `COOLIFY_DB_READONLY_PASSWORD` | `instances.default.db.readonlyPassword` |
| `COOLIFY_PINNED_VERSION` | `instances.default.pinnedCoolifyVersion` |
| `--header "K: V"` | `instances.default.extraHeaders` (repeatable) |

When a config file is loaded, `--enable-host-ops` and `--allow-destructive` are **ignored** (a warning is printed); per-instance gating comes from the file.

### 7. HTTP transport (optional)

By default the server speaks MCP over **stdio**. To serve it over **Streamable HTTP**
instead, pass `--http [port]` (default `3000`) or set `COOLIFY_MCP_HTTP_PORT`:

```bash
export COOLIFY_MCP_HTTP_TOKEN="<a long random secret>"   # required
coolify-mcp --http 3000
```

| Variable | Description |
|---|---|
| `COOLIFY_MCP_HTTP_PORT` | Enable HTTP on this port (or use `--http <port>`). |
| `COOLIFY_MCP_HTTP_TOKEN` | **Required (min 16 chars).** Bearer token clients must send as `Authorization: Bearer <token>`. The server refuses to start an unauthenticated endpoint, or one with a token shorter than 16 characters. |
| `COOLIFY_MCP_HTTP_HOST` | Bind address. Defaults to `127.0.0.1`; a non-localhost bind prints a warning. |
| `COOLIFY_MCP_HTTP_ALLOWED_HOSTS` | Comma-separated `host:port` allowlist for the `Host` header (DNS-rebinding defense), enforced on **non-loopback** binds. Defaults to the bind `host:port`; set this to your client-facing `host:port` when binding `0.0.0.0`. |

**The host-ops tier is never exposed over HTTP.** `ssh_exec`, `docker_op`,
`query_coolify_db`, `read_host_file`, and `stream_logs` are root-level operations
registered **only on the stdio transport** — over HTTP the server serves the API tier
(read/write/destructive) only, regardless of `enableHostOps`. Keep the bind on
`127.0.0.1`, keep the bearer token secret, and treat any non-localhost bind as
internet-facing.

### Token Scope Guidance

Coolify tokens carry full-account permissions. For read-only use (monitoring, querying), prefer creating a dedicated read-only token in Coolify's settings if the feature is available for your version. For write operations, use a token scoped to the team/project you intend to manage. Never share the same token across environments.

## Tools

Tools are grouped by tier. Tier determines what flags must be set for the tool to be registered and callable.

| Tier | Meaning | Required flags |
|---|---|---|
| **R** (read) | Non-mutating reads: list, get, inspect | none |
| **W** (write) | Creates and updates | none (but Coolify token must have write access) |
| **D** (destructive) | Deletes and stop/restart/kill operations | `--allow-destructive` **and** `confirm: true` in the call |
| **host** | SSH, Docker, psql, file reads | `--enable-host-ops` |

Destructive host actions (docker rm/rmi/stop/kill/prune/exec) additionally require `--allow-destructive` and `confirm: true`. The host tier is root-level read access by design: read-only `docker_op` actions (`inspect`, `logs`, …) and `read_host_file` can surface container configuration **including environment variables/secrets** — treat their output as sensitive. `docker_args` rejects shell metacharacters and `{}` template braces, but plain `docker inspect <container>` still returns that container's full config; only enable `--enable-host-ops` for trusted callers.

### Deploy

| Tool | Tier | Description |
|---|---|---|
| `deploy` | W | Trigger a deployment for a resource by UUID or tag. |
| `deploy_watch` | W | Trigger and poll until a terminal deploy status, emitting MCP progress. |
| `get_deployments` | R | List active deployments or fetch deployment history for an application. |
| `cancel_deployment` | D | Cancel a running deployment. |

### Resources (Applications, Databases, Services)

| Tool | Tier | Description |
|---|---|---|
| `list_resources` | R | List all resources of a given kind with summary fields. |
| `get_resource` | R | Fetch full details for a single resource by UUID. |
| `create_resource` | W | Create an application (public/private-github-app/private-deploy-key/dockerfile/dockerimage), database, or service. |
| `update_resource` | W | Update an existing resource's settings. |
| `control_resource` | W/D | Start/stop/restart a resource (stop/restart require `--allow-destructive`). |
| `delete_resource` | D | Permanently delete a resource. Requires `--allow-destructive` + `confirm: true`. |
| `manage_storage` | W/D | List, create, update, or delete persistent storage volumes for a resource. |
| `manage_backups` | W/D | List, create, update, or delete backup schedules for databases. |
| `manage_scheduled_tasks` | W/D | List, create, update, or delete scheduled tasks for apps/services. |

### Environment Variables

| Tool | Tier | Description |
|---|---|---|
| `manage_env` | W/D | List, upsert-bulk, or delete environment variables for a resource. |

### Projects

| Tool | Tier | Description |
|---|---|---|
| `manage_projects` | R/W/D | List, get, create, update, or delete projects and their environments. |

### Servers & Keys

| Tool | Tier | Description |
|---|---|---|
| `get_servers` | R | List servers or get a single server with validation/resource info. |
| `manage_server` | W/D | Create, update, or delete servers. |
| `provision_hetzner` | W | Provision a new Hetzner cloud server via Coolify. |
| `hetzner_inventory` | R | List Hetzner locations, server types, images, or SSH keys. |
| `manage_keys` | W/D | Manage Coolify private keys and cloud provider tokens. |

### Logs

| Tool | Tier | Description |
|---|---|---|
| `get_logs` | R / host | Snapshot logs for an application (REST API). For databases and services, falls back to `docker logs --tail` via host-ops. |
| `stream_logs` | host | Live-tail Docker logs via SSH/HostOps. Sends MCP progress every 25 lines. Hard cap: 1000 lines / 15 min. |

### Host Ops

| Tool | Tier | Description |
|---|---|---|
| `ssh_exec` | host | Run a shell command on a server over SSH. Returns stdout, stderr, exit code. |
| `docker_op` | host | Run a Docker CLI sub-command on a server. Mutating actions require `--allow-destructive` + `confirm: true`. |
| `query_coolify_db` | host | Execute a read-only SELECT query against the Coolify PostgreSQL database. |
| `read_host_file` | host | Read an allowed file on the Coolify host (restricted to `/data/coolify/**`). |

## Security Notes

### Never-Exposed Endpoints (Lockout Policy)

The following Coolify API endpoints are intentionally **never** exposed as tools, because calling them from an automated agent risks locking out all access to the Coolify UI:

- `GET /enable` — enables Coolify
- `GET /disable` — disables Coolify
- `POST /mcp/enable` — enables Coolify's own MCP endpoint
- `POST /mcp/disable` — disables Coolify's own MCP endpoint
- IP-allowlist mutation endpoints

### Destructive Operations

All destructive operations follow a deny-by-default, double-confirmation model:

1. The server must be started with `--allow-destructive`.
2. Each individual call must include `confirm: true` in its arguments.
3. You can pass `dry_run: true` to preview what would be executed without performing it.

### Host-Ops Tier

When `enableHostOps: true` is set for an instance (or `--enable-host-ops` in env mode), the server opens an SSH connection to the Coolify host on first use. Commands run as the configured SSH user (typically root). File access is restricted to `/data/coolify/**` prefixes. SQL access is restricted to read-only SELECT statements.

**SSH host-key verification is fail-closed.** The server refuses to connect unless the key presented by the remote host matches either `ssh.fingerprint` (SHA-256, from `ssh-keyscan <host> | ssh-keygen -lf -`) or the appropriate entry in `ssh.knownHostsPath` / `~/.ssh/known_hosts`. A missing or non-matching entry is an immediate connection refusal.

## Development

```bash
npm install
npm test              # vitest
npm run build         # esbuild -> single self-contained dist/cli/index.js bundle
npm run probe         # scripts/probe.ts (requires COOLIFY_TEST_BASE_URL / COOLIFY_TEST_TOKEN)
```

> **Note — `dist/` is committed.** `npm run build` bundles the CLI, the MCP server, and
> **all runtime deps** (ssh2, the MCP SDK, …) into a single `dist/cli/index.js` via esbuild,
> with ssh2's native bindings externalized (it falls back to pure-JS crypto). The result has
> **zero runtime dependencies**, so `npm install github:…` compiles nothing and runs no install
> scripts on the user's machine. Because no build runs at install time, the bundle is checked
> into git: **run `npm run build` and commit the updated `dist/cli/index.js` (and the
> regenerated `THIRD-PARTY-NOTICES.txt`) whenever you change anything under `src/`.**
> (Runtime libs live in `devDependencies` since they're bundled, not installed by
> consumers.) CI runs `git diff --exit-code dist/ THIRD-PARTY-NOTICES.txt` so a stale
> committed bundle fails the build.

## License

MIT. The published single-file bundle inlines third-party packages (ssh2, the MCP
SDK, ajv, …); their license and copyright notices are reproduced in
[`THIRD-PARTY-NOTICES.txt`](./THIRD-PARTY-NOTICES.txt), regenerated at build time.
