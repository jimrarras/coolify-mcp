# Multi-instance setup & management — design

**Date:** 2026-06-29
**Status:** approved (pre-implementation)
**Target version:** 0.1.2 → 0.2.0

## Premise

The **runtime** already drives multiple Coolify instances:

- Config schema is an `instances` map + `defaultInstance` (`src/core/config/schema.ts`).
- `InstanceRegistry` resolves and caches a per-instance API client, resolver, and lazy host-ops (`src/core/registry.ts`).
- Every tool accepts an optional `instance` arg that `dispatch` uses to route the call (`src/mcp/dispatch.ts`).
- `doctor` already loops over every configured instance (`src/cli/doctor.ts`).

You can drive N instances **today** by hand-editing `~/.coolify-mcp/config.json`.

The gap is **setup/management ergonomics**: `init` only ever builds a single-instance object and overwrites the whole file (`src/cli/init.ts` — `buildConfigObject` + `writeConfig`), and there is no guided way to list, remove, or change the default instance. This work closes that gap and adds one read-only discovery tool. **No changes to request routing or the runtime resolution path.**

## Scope (agreed)

1. `init` can **add** an instance to an existing config (merge, not clobber).
2. A `instances` CLI command group: **list**, **remove**, **set-default**.
3. A read-only `list_instances` MCP tool.

Explicitly **out of scope:** any change to how a call is routed to an instance at runtime (already works); editing instance fields other than via `init` (re-run `init` to reconfigure an instance).

## 1. Shared config-path resolution

Add a helper that returns the **active** config file path (the file `init`/`instances` read and write):

```
resolveConfigPath(argv, env, home) ->
  1. --config <path>            (CLI flag)
  2. COOLIFY_CONFIG             (env var)
  3. <home>/.coolify-mcp/config.json   (default write location)
```

- Lives alongside `loadConfig` (e.g. exported from `src/core/config/load.ts` or a small `src/core/config/path.ts`), `home` injectable for hermetic tests.
- `loadConfig` keeps its current "use the file if it exists, else env fallback" semantics; it may reuse this helper for the file-path branch.
- `init`'s `writeConfig` and all `instances` commands use this helper, so they all act on the same file regardless of `--config`/`COOLIFY_CONFIG`. (Today `init` hard-codes the home path and ignores both — this fixes that.)

## 2. `init` — detect & merge (no clobber)

- Refactor `buildConfigObject` into `buildInstanceObject(input)` that returns **only** the single instance record (`{ baseUrl, token, enableHostOps, allowDestructive, ssh?, db? }`). A thin `buildConfigObject` may remain for the fresh-file case, expressed via the merge.
- New flow inside `runInitFlow`:
  1. Read the existing **raw** file at the active path (parse JSON; if absent, start from `{ instances: {} }`).
  2. Collect inputs as today (name, baseUrl, token, host-ops, db).
  3. If the chosen instance name already exists in `raw.instances` → `io.confirm("Reconfigure existing instance '<name>'? (overwrites it)", false)`. If declined, re-prompt for a name (or abort with a clear message).
  4. **Merge:** `raw.instances[name] = buildInstanceObject(input)`. All other instances are preserved **verbatim** — we mutate the raw parsed object, never the env-expanded form, so `${ENV}` references and any hand-added fields survive.
  5. **Default:**
     - No prior config / first instance → `raw.defaultInstance = name`.
     - Adding alongside an existing different default → `io.confirm("Make '<name>' the default? (current: <X>)", false)`; only switch on yes.
  6. Back up the existing file to `<path>.bak` (current behavior), write the merged raw object at mode `0600`.
- `--env-secrets` behavior is unchanged for the newly written instance.

## 3. `instances` CLI command group

`src/cli/index.ts` dispatcher gains `sub === "instances"`, delegating to a new `src/cli/instances.ts`. Sub-actions on `rest`:

### `instances` (no action) — list
- Read the raw active file. Print a table: `name | baseUrl(raw) | default(*) | host-ops | destructive`.
- **Never print tokens or any secret.** `baseUrl` is shown raw (may contain `${...}` literally — fine).
- No file present (env-var mode) → show the synthesized `default` instance (name + `COOLIFY_BASE_URL`) and note that instances are coming from env vars, not a file.

### `instances default <name>` — set default
- Read raw; validate `<name>` ∈ `instances` (else `invalid_input` listing known names).
- Set `defaultInstance = name`; back up + write.

### `instances rm <name>` — remove
- Read raw; validate `<name>` exists.
- Refuse to remove the **only** instance (`invalid_input`: a config must define at least one).
- Remove `instances[name]`. If it was the default:
  - exactly one instance remains → promote it to default automatically (report it).
  - several remain → `invalid_input`: "removed instance was the default; set a new one first: `coolify-mcp instances default <name>`" **without writing** (leave the file unchanged so there's no dangling default). *(Agreed behavior: force the user to pick.)*
- Back up + write.

### File requirement
`default` and `rm` operate on a file only. In env-var mode (no file) they error with guidance to run `coolify-mcp init` (which creates the file). `list` works in both modes.

## 4. `list_instances` MCP tool (read tier)

- New `src/mcp/tools/instances.ts`, `tier: "api"`, exported as `TOOLS` and added to `getAllTools` in `src/mcp/server.ts`. Registered on **both** stdio and HTTP transports (read-only, no secrets).
- `InstanceRegistry` gains `summaries(): InstanceSummary[]` where
  `InstanceSummary = { name, baseUrl, isDefault, enableHostOps, allowDestructive }`.
- `dispatch` injects `ctx.instances = registry.summaries()` and `ctx.defaultInstance = registry.defaultName()` into `ToolContext` (two new optional fields on the `ToolContext` interface).
- The tool ignores the per-call `instance` arg (the answer is global) and returns:
  ```json
  { "default": "prod",
    "instances": [
      { "name": "prod",    "baseUrl": "https://…", "isDefault": true,  "enableHostOps": false, "allowDestructive": false },
      { "name": "staging", "baseUrl": "https://…", "isDefault": false, "enableHostOps": true,  "allowDestructive": true  }
    ] }
  ```
- **Never** returns token, ssh passphrase, or db credentials.
- When `>1` instance is configured, `buildServer` already appends an instances hint to each tool description; `list_instances` complements that by making the list machine-readable.

## Error handling

| Case | Result |
|---|---|
| `instances rm` of the only instance | `invalid_input` — config must keep ≥1 instance |
| `instances rm` of the default with several remaining | `invalid_input` — set a new default first; file left unchanged |
| `instances rm`/`default` unknown name | `invalid_input` listing known names |
| `instances rm`/`default` in env-var mode (no file) | `invalid_input` — run `coolify-mcp init` to create a config file |
| malformed existing file (init or instances) | same parse-error message style as `loadConfig` |

## Docs, tests, build

- **README:** update §5 (multi-instance) to describe `init` merge + the `instances` commands; add `list_instances` to the tool table. Keep `src/__tests__/readme.test.ts` green.
- **config.example.json:** verify it remains a valid multi-instance example.
- **Tests (TDD, vitest):** mock `IO` and inject fs/`home` as the existing init/doctor tests do.
  - `buildInstanceObject` + merge logic (preserves other instances and their `${ENV}` refs; default rules).
  - `init` merge flow: fresh file, add-second, reconfigure-existing-with-confirm, make-default prompt.
  - `instances` list (file mode + env mode; no secrets in output).
  - `instances default` (valid, unknown name).
  - `instances rm` (normal, only-instance guard, default-with-one-left promotion, default-with-many error/no-write, unknown name, env-mode error).
  - `resolveConfigPath` precedence.
  - `InstanceRegistry.summaries()` (fields + isDefault, no secrets).
  - `dispatch` injects `ctx.instances`/`ctx.defaultInstance`.
  - `list_instances` tool output shape + secret-free.
- **Build:** run `npm run build`, commit the regenerated `dist/cli/index.js` (+ `THIRD-PARTY-NOTICES.txt` if changed). Bump version `0.1.2 → 0.2.0` in `package.json` and the hardcoded version in `src/mcp/server.ts` (`buildServer`).

## Testing strategy

TDD per task. New CLI/tool logic is pure functions over injected `IO`/fs so it is unit-testable without touching a real config or network. A final whole-branch review + `npm test` + `git diff --exit-code dist/ THIRD-PARTY-NOTICES.txt` (CI staleness gate) before merge.
