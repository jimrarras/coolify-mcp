# Multi-instance Setup & Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `coolify-mcp` users manage multiple Coolify instances ergonomically — `init` merges instead of clobbering, a new `instances` CLI group lists/removes/sets-default, and a read-only `list_instances` MCP tool exposes the configured instances.

**Architecture:** The runtime already routes per-instance (registry + per-call `instance` arg). This work adds only setup/management surfaces that edit the **raw** config file (preserving `${ENV}` refs) plus one discovery tool. Shared helpers: `resolveConfigPath` (active-file resolution) and `readRawConfig`/`writeRawConfig` (raw read/backup/0600-write), reused by both `init` and the `instances` commands.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-ins (`fs`, `os`, `path`, `crypto`), vitest. CLI uses the injectable `IO` interface (`src/cli/io.ts`) and `makeScriptedIO` for hermetic tests. MCP tools follow the `ToolDef`/`ToolHandler` + `ok`/`err` pattern.

## Global Constraints

- ESM throughout: all relative imports end in `.js` (e.g. `import { x } from "./foo.js"`).
- Never write or print secrets: tokens, `ssh.passphrase`, `db.readonlyPassword` must never appear in `list`/`list_instances` output. Management commands edit the **raw** parsed file (never the `${ENV}`-expanded form).
- Config files are written at mode `0600`; an existing file is backed up to `<path>.bak` before overwrite.
- Errors surfaced to users/tools use `CoolifyError`/`err` with `kind: "invalid_input"` and an actionable message.
- Every MCP tool's `inputSchema` exposes an optional `instance: { type: "string" }` and never lists it in `required`.
- Run the full suite (`npm test`) and `npm run lint` (`tsc --noEmit`) before the final commit; rebuild and commit `dist/` (CI runs `git diff --exit-code dist/ THIRD-PARTY-NOTICES.txt`).
- Single-file test runs use: `npx vitest run <path>`.

---

### Task 1: `resolveConfigPath` helper

Shared resolution of the **active** config file path that `init` and `instances` read/write.

**Files:**
- Create: `src/core/config/path.ts`
- Test: `src/core/config/path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveConfigPath(argv: string[], env: Record<string, string | undefined>, home: string): string`
  - Precedence: `--config <path>` in argv → `env.COOLIFY_CONFIG` → `<home>/.coolify-mcp/config.json`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/config/path.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveConfigPath } from "./path.js";

describe("resolveConfigPath", () => {
  const home = "/home/u";
  const def = join(home, ".coolify-mcp", "config.json");

  it("defaults to <home>/.coolify-mcp/config.json", () => {
    expect(resolveConfigPath([], {}, home)).toBe(def);
  });
  it("uses COOLIFY_CONFIG when set", () => {
    expect(resolveConfigPath([], { COOLIFY_CONFIG: "/etc/c.json" }, home)).toBe("/etc/c.json");
  });
  it("prefers --config over COOLIFY_CONFIG and the default", () => {
    expect(resolveConfigPath(["--config", "/flag.json"], { COOLIFY_CONFIG: "/env.json" }, home)).toBe("/flag.json");
  });
  it("ignores a trailing --config with no value", () => {
    expect(resolveConfigPath(["--config"], {}, home)).toBe(def);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/config/path.test.ts`
Expected: FAIL — cannot find module `./path.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/config/path.ts
import { join } from "node:path";

/**
 * Resolves the active config-file path that `init`/`instances` read and write.
 * Precedence: --config <path>  →  COOLIFY_CONFIG  →  <home>/.coolify-mcp/config.json.
 * (Unlike loadConfig, the home default is always returned as the write target,
 * even when the file does not yet exist.)
 */
export function resolveConfigPath(
  argv: string[],
  env: Record<string, string | undefined>,
  home: string,
): string {
  const i = argv.indexOf("--config");
  if (i !== -1) {
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) return next;
  }
  if (env.COOLIFY_CONFIG) return env.COOLIFY_CONFIG;
  return join(home, ".coolify-mcp", "config.json");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/config/path.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/config/path.ts src/core/config/path.test.ts
git commit -m "feat: add resolveConfigPath helper for active config file"
```

---

### Task 2: Raw config read/write utilities

Read the raw (un-expanded) config and write it back with backup + `0600`, reused by `init` and `instances`. Edits to the raw object preserve `${ENV}` refs.

**Files:**
- Create: `src/cli/config-file.ts`
- Test: `src/cli/config-file.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RawConfig { instances?: Record<string, unknown>; defaultInstance?: string; [k: string]: unknown }`
  - `readRawConfig(path: string): RawConfig | null` — `null` if the file is absent; throws `CoolifyError("invalid_input", ...)` on parse failure or non-object root.
  - `writeRawConfig(path: string, obj: unknown): void` — `mkdir -p` parent, back up existing file to `<path>.bak`, write pretty JSON at mode `0600`.

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/config-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRawConfig, writeRawConfig } from "./config-file.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cfgtest-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readRawConfig", () => {
  it("returns null when the file does not exist", () => {
    expect(readRawConfig(join(dir, "nope.json"))).toBeNull();
  });
  it("parses an existing file and preserves ${ENV} refs verbatim", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ defaultInstance: "a", instances: { a: { token: "${COOLIFY_TOKEN}" } } }));
    const raw = readRawConfig(p)!;
    expect(raw.defaultInstance).toBe("a");
    expect((raw.instances!.a as { token: string }).token).toBe("${COOLIFY_TOKEN}");
  });
  it("throws CoolifyError on malformed JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    expect(() => readRawConfig(p)).toThrow(/failed to read\/parse/);
  });
});

describe("writeRawConfig", () => {
  it("creates the file, parent dirs, and writes pretty JSON", () => {
    const p = join(dir, "nested", "config.json");
    writeRawConfig(p, { defaultInstance: "a", instances: { a: {} } });
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).defaultInstance).toBe("a");
  });
  it("backs up an existing file to <path>.bak before overwriting", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ defaultInstance: "old", instances: {} }));
    writeRawConfig(p, { defaultInstance: "new", instances: {} });
    expect(JSON.parse(readFileSync(p + ".bak", "utf8")).defaultInstance).toBe("old");
    expect(JSON.parse(readFileSync(p, "utf8")).defaultInstance).toBe("new");
  });
  it("writes at mode 0600 (POSIX only)", () => {
    if (process.platform === "win32") return; // mode bits not enforced on Windows
    const p = join(dir, "config.json");
    writeRawConfig(p, { instances: {} });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/config-file.test.ts`
Expected: FAIL — cannot find module `./config-file.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/config-file.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { CoolifyError } from "../core/errors.js";

export interface RawConfig {
  instances?: Record<string, unknown>;
  defaultInstance?: string;
  [k: string]: unknown;
}

/** Reads the raw config file (no ${ENV} expansion). null if absent; throws on bad JSON. */
export function readRawConfig(path: string): RawConfig | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CoolifyError("invalid_input", `config: failed to read/parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CoolifyError("invalid_input", `config: ${path} must contain a JSON object`);
  }
  return parsed as RawConfig;
}

/** Writes pretty JSON at mode 0600, creating parent dirs and backing up any existing file to <path>.bak. */
export function writeRawConfig(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, path + ".bak");
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/config-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/config-file.ts src/cli/config-file.test.ts
git commit -m "feat: add raw config read/write utilities (backup + 0600)"
```

---

### Task 3: `init` — split instance builder + merge into existing config

Make `init` add/reconfigure a single instance inside the existing config rather than overwriting the whole file.

**Files:**
- Modify: `src/cli/init.ts` (`buildConfigObject`, `InitDeps`, `runInitFlow`, real-deps wiring + `runInit`)
- Test: `src/cli/init.test.ts` (add merge cases; existing cases must stay green)

**Interfaces:**
- Consumes: `resolveConfigPath` (Task 1), `readRawConfig`/`writeRawConfig` + `RawConfig` (Task 2).
- Produces:
  - `buildInstanceObject(input: InitConfigInput): Record<string, unknown>` — the single instance record only.
  - `buildConfigObject(input)` unchanged signature/return: `{ defaultInstance: input.instanceName, instances: { [input.instanceName]: buildInstanceObject(input) } }`.
  - `InitDeps.readConfig?: () => RawConfig | null` (optional; defaults to `() => null`).
  - `runInitFlow` now merges and may prompt "Make '<name>' the default?".

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/init.test.ts` (the existing `deps()` helper stays as-is; merge tests pass `readConfig` via the `over` param):

```ts
describe("runInitFlow merge", () => {
  it("adds a second instance, preserves the first verbatim, keeps default when declined", async () => {
    const existing = { defaultInstance: "prod", instances: { prod: { baseUrl: "https://prod", token: "${PROD}" } } };
    const written: unknown[] = [];
    // answers: baseUrl, token, instanceName="staging", host-ops? n, make-default? n
    const { deps: d } = deps(["https://stg", "2|s", "staging", "n", "n"], {
      readConfig: () => existing,
      writeConfig: (o) => { written.push(o); return "/cfg"; },
    });
    const code = await runInitFlow(d);
    expect(code).toBe(0);
    const out = written[0] as { defaultInstance: string; instances: Record<string, { token?: string }> };
    expect(out.defaultInstance).toBe("prod");                  // unchanged
    expect(out.instances.prod.token).toBe("${PROD}");          // preserved verbatim
    expect(Object.keys(out.instances).sort()).toEqual(["prod", "staging"]);
  });

  it("switches the default when the user accepts the make-default prompt", async () => {
    const existing = { defaultInstance: "prod", instances: { prod: { baseUrl: "https://prod", token: "${PROD}" } } };
    const written: unknown[] = [];
    // answers: baseUrl, token, instanceName="staging", host-ops? n, make-default? y
    const { deps: d } = deps(["https://stg", "2|s", "staging", "n", "y"], {
      readConfig: () => existing,
      writeConfig: (o) => { written.push(o); return "/cfg"; },
    });
    await runInitFlow(d);
    expect((written[0] as { defaultInstance: string }).defaultInstance).toBe("staging");
  });

  it("re-prompts for a name when the chosen name exists and reconfigure is declined", async () => {
    const existing = { defaultInstance: "prod", instances: { prod: { baseUrl: "https://prod", token: "${PROD}" } } };
    const written: unknown[] = [];
    // answers: baseUrl, token, name="prod", reconfigure? n, name="prod2", host-ops? n, make-default? n
    const { deps: d } = deps(["https://x", "9|s", "prod", "n", "prod2", "n", "n"], {
      readConfig: () => existing,
      writeConfig: (o) => { written.push(o); return "/cfg"; },
    });
    const code = await runInitFlow(d);
    expect(code).toBe(0);
    expect(Object.keys((written[0] as { instances: Record<string, unknown> }).instances).sort()).toEqual(["prod", "prod2"]);
  });

  it("overwrites only the named instance when reconfigure is confirmed", async () => {
    const existing = { defaultInstance: "prod", instances: { prod: { baseUrl: "https://old", token: "${PROD}" }, stg: { baseUrl: "https://stg", token: "${STG}" } } };
    const written: unknown[] = [];
    // answers: baseUrl, token, name="prod", reconfigure? y, host-ops? n
    const { deps: d } = deps(["https://new", "1|new", "prod", "y", "n"], {
      readConfig: () => existing,
      writeConfig: (o) => { written.push(o); return "/cfg"; },
    });
    await runInitFlow(d);
    const out = written[0] as { instances: Record<string, { baseUrl: string; token: string }> };
    expect(out.instances.prod.baseUrl).toBe("https://new");
    expect(out.instances.prod.token).toBe("1|new");   // inline by default
    expect(out.instances.stg.token).toBe("${STG}");   // untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/init.test.ts`
Expected: FAIL — merge cases fail (no `readConfig` handling; default never switches; existing instances dropped).

- [ ] **Step 3: Implement the merge**

In `src/cli/init.ts`, refactor the builder:

```ts
export function buildInstanceObject(input: InitConfigInput): Record<string, unknown> {
  const inst: Record<string, unknown> = {
    baseUrl: input.baseUrl,
    token: input.envSecrets ? "${COOLIFY_TOKEN}" : input.token,
    enableHostOps: input.enableHostOps,
    allowDestructive: false,
  };
  if (input.ssh) {
    const ssh: Record<string, unknown> = { keyPath: input.ssh.keyPath };
    if (input.ssh.host) ssh.host = input.ssh.host;
    if (input.ssh.hostServer) ssh.hostServer = input.ssh.hostServer;
    if (input.ssh.fingerprint) ssh.fingerprint = input.ssh.fingerprint;
    if (input.ssh.passphrase) {
      ssh.passphrase = input.envSecrets ? "${COOLIFY_SSH_KEY_PASSPHRASE}" : input.ssh.passphrase;
    }
    inst.ssh = ssh;
  }
  if (input.db) {
    inst.db = {
      readonlyUser: input.db.readonlyUser,
      readonlyPassword: input.envSecrets ? "${COOLIFY_DB_RO_PASSWORD}" : input.db.readonlyPassword,
    };
  }
  return inst;
}

export function buildConfigObject(input: InitConfigInput): unknown {
  return { defaultInstance: input.instanceName, instances: { [input.instanceName]: buildInstanceObject(input) } };
}
```

Add the import at the top of `init.ts`:

```ts
import type { RawConfig } from "./config-file.js";
```

Add `readConfig` to `InitDeps`:

```ts
export interface InitDeps {
  io: IO;
  env: Record<string, string | undefined>;
  envSecrets?: boolean;
  // Returns the current raw config (un-expanded) so init can merge; null when no file exists.
  readConfig?: () => RawConfig | null;
  makeApi: (baseUrl: string, token: string) => { health(): Promise<unknown>; version(): Promise<string> };
  resolveControlHost: (baseUrl: string, token: string, hostServer?: string) => Promise<{ serverUuid: string; host: string; user: string; port: number }>;
  listServers: (baseUrl: string, token: string) => Promise<Array<{ uuid: string; name?: string }>>;
  discoverKey: (host: string, user: string, port: number) => Promise<{ path: string; passphrase?: string } | { ppkOnly: true } | null>;
  getFingerprint: (host: string, port: number) => Promise<string>;
  writeConfig: (obj: unknown) => string;
}
```

In `runInitFlow`, after the API connect block (which ends with the `✓ connected` print), replace the single `const instanceName = await io.prompt(...)` line with merge-aware name selection:

```ts
  // Load any existing config so we MERGE (add/reconfigure one instance) rather than clobber.
  const existing = (deps.readConfig?.() ?? null);
  const existingInstances = (existing?.instances && typeof existing.instances === "object")
    ? (existing.instances as Record<string, unknown>) : {};

  // Pick a name; if it collides, confirm reconfigure or pick another.
  let instanceName = await io.prompt("Instance name", "default");
  while (existingInstances[instanceName] !== undefined) {
    if (await io.confirm(`Reconfigure existing instance '${instanceName}'? (overwrites it)`, false)) break;
    instanceName = await io.prompt("Choose a different instance name");
  }
```

Then at the end, replace the `buildConfigObject(...)` + `writeConfig` block (step "4. write config") with the merge + default decision:

```ts
  // 4. merge into existing config (preserve other instances and their ${ENV} refs verbatim)
  const merged: RawConfig = { ...(existing ?? {}) };
  const instancesOut: Record<string, unknown> = { ...existingInstances };
  instancesOut[instanceName] = buildInstanceObject({ instanceName, baseUrl, enableHostOps, envSecrets, token, ssh, db });
  merged.instances = instancesOut;

  const priorDefault = typeof existing?.defaultInstance === "string" ? existing.defaultInstance : undefined;
  const otherNames = Object.keys(existingInstances).filter((n) => n !== instanceName);
  if (!priorDefault || otherNames.length === 0) {
    merged.defaultInstance = instanceName;            // first/only instance
  } else if (priorDefault !== instanceName) {
    merged.defaultInstance = (await io.confirm(`Make '${instanceName}' the default? (current: ${priorDefault})`, false))
      ? instanceName : priorDefault;
  } else {
    merged.defaultInstance = priorDefault;
  }

  const path = deps.writeConfig(merged);
  io.print(`\n✓ wrote ${path}`);
```

Wire real deps: change `runInit`/`runInitFlowWithRealDeps` to thread `argv` and provide `readConfig`/`writeConfig` via the shared helpers.

```ts
export async function runInit(argv: string[], env: Record<string, string | undefined>, io: IO = defaultIO): Promise<number> {
  const envSecrets = argv.includes("--env-secrets");
  try {
    return await runInitFlowWithRealDeps(io, env, argv, envSecrets);
  } finally {
    io.close?.();
  }
}

function runInitFlowWithRealDeps(io: IO, env: Record<string, string | undefined>, argv: string[], envSecrets: boolean): Promise<number> {
  const cfgPath = resolveConfigPath(argv, env, homedir());
  return runInitFlow({
    io,
    env,
    envSecrets,
    readConfig: () => readRawConfig(cfgPath),
    makeApi: (baseUrl, token) => new CoolifyApiClient({ baseUrl, token, extraHeaders: {} }),
    resolveControlHost: async (baseUrl, token, hostServer) => {
      const api = new CoolifyApiClient({ baseUrl, token, extraHeaders: {} });
      return new ServerResolver(api, { baseUrl, hostServer }).resolveControlHost();
    },
    listServers: async (baseUrl, token) => {
      const api = new CoolifyApiClient({ baseUrl, token, extraHeaders: {} });
      return (await api.servers.list()) as Array<{ uuid: string; name?: string }>;
    },
    discoverKey: async (host, user, port) =>
      discoverWorkingKey({
        candidates: scanSshDir(),
        tryKey: async (path, passphrase) => {
          const c = new SshClient({ host, user, port, keyPath: path, passphrase, knownHostsPath: join(homedir(), ".ssh", "known_hosts") });
          await c.connect();
          await c.close();
        },
        askPassphrase: (path) => io.promptMasked(`Passphrase for ${path}`),
      }),
    getFingerprint: async (host, port) => {
      const kh = readFileSync(join(homedir(), ".ssh", "known_hosts"), "utf8");
      for (const line of kh.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && (parts[0] === host || parts[0] === `[${host}]:${port}`)) {
          const digest = createHash("sha256").update(Buffer.from(parts[2], "base64")).digest("base64").replace(/=+$/, "");
          return `SHA256:${digest}`;
        }
      }
      return "(unknown — add the host to ~/.ssh/known_hosts first: ssh-keyscan -t ed25519 " + host + " >> ~/.ssh/known_hosts)";
    },
    writeConfig: (obj) => { writeRawConfig(cfgPath, obj); return cfgPath; },
  });
}
```

Add imports at the top of `init.ts` and remove the now-unused inline write imports if they become unused (`mkdirSync`, `copyFileSync`, `existsSync` move into `config-file.ts`; keep `readFileSync` — still used by `getFingerprint`):

```ts
import { resolveConfigPath } from "../core/config/path.js";
import { readRawConfig, writeRawConfig, type RawConfig } from "./config-file.js";
```

> Note: the existing `init.test.ts` `deps()` helper calls `runInitFlow` without `readConfig`; the optional `readConfig?` (defaulting to `() => null`) keeps every existing test green — a fresh config produces `{ defaultInstance: name, instances: { [name]: ... } }` exactly as before.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/init.test.ts`
Expected: PASS (existing cases + 4 new merge cases). Then `npm run lint` to catch unused imports.

- [ ] **Step 5: Commit**

```bash
git add src/cli/init.ts src/cli/init.test.ts
git commit -m "feat: init merges into existing config instead of clobbering"
```

---

### Task 4: `instances` command — list

Create the `instances` command module with its action router and the `list` action.

**Files:**
- Create: `src/cli/instances.ts`
- Test: `src/cli/instances.test.ts`

**Interfaces:**
- Consumes: `resolveConfigPath` (Task 1), `readRawConfig`/`RawConfig` (Task 2).
- Produces: `runInstances(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void, deps?: { home?: string }): Promise<number>`
  - `argv[0]` is the action (`undefined`/`"list"` → list; `"default"` and `"rm"` added in later tasks).

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/instances.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstances } from "./instances.js";

let home: string;
function cap() { const lines: string[] = []; return { out: (l: string) => lines.push(l), text: () => lines.join("\n") }; }
function writeCfg(obj: unknown) { mkdirSync(join(home, ".coolify-mcp"), { recursive: true }); writeFileSync(join(home, ".coolify-mcp", "config.json"), JSON.stringify(obj)); }

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "inst-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("runInstances list", () => {
  it("lists instance names, baseUrls, the default marker, and tier flags — never secrets", async () => {
    writeCfg({ defaultInstance: "prod", instances: {
      prod: { baseUrl: "https://prod", token: "1|secret-prod" },
      stg:  { baseUrl: "https://stg",  token: "${STG}", enableHostOps: true, allowDestructive: true },
    } });
    const c = cap();
    const code = await runInstances([], {}, c.out, { home });
    expect(code).toBe(0);
    const t = c.text();
    expect(t).toContain("prod");
    expect(t).toContain("https://prod");
    expect(t).toContain("stg");
    expect(t).toMatch(/prod.*\*|\*.*prod/);          // default marker on prod
    expect(t).not.toContain("secret-prod");          // never print tokens
    expect(t).not.toContain("${STG}");
  });

  it("'list' action behaves the same as no action", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" } } });
    const c = cap();
    expect(await runInstances(["list"], {}, c.out, { home })).toBe(0);
    expect(c.text()).toContain("a");
  });

  it("describes env-var mode when there is no config file", async () => {
    const c = cap();
    const code = await runInstances([], { COOLIFY_BASE_URL: "https://env-host" }, c.out, { home });
    expect(code).toBe(0);
    expect(c.text()).toMatch(/env|environment/i);
    expect(c.text()).toContain("https://env-host");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/instances.test.ts`
Expected: FAIL — cannot find module `./instances.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/instances.ts
import { homedir } from "node:os";
import { resolveConfigPath } from "../core/config/path.js";
import { readRawConfig, type RawConfig } from "./config-file.js";
import { CoolifyError } from "../core/errors.js";

type Out = (line: string) => void;

function flag(v: unknown): string { return v === true ? "on" : "off"; }

function listInstances(raw: RawConfig | null, env: Record<string, string | undefined>, out: Out): number {
  if (!raw) {
    if (env.COOLIFY_BASE_URL) {
      out("No config file — using environment variables (single 'default' instance):");
      out(`  * default  ${env.COOLIFY_BASE_URL}`);
    } else {
      out("No config file and COOLIFY_BASE_URL is not set. Run 'coolify-mcp init'.");
    }
    return 0;
  }
  const instances = (raw.instances ?? {}) as Record<string, Record<string, unknown>>;
  const def = typeof raw.defaultInstance === "string" ? raw.defaultInstance : undefined;
  const names = Object.keys(instances);
  if (names.length === 0) { out("Config file has no instances."); return 0; }
  out("instances (* = default):");
  for (const name of names) {
    const i = instances[name] ?? {};
    const mark = name === def ? "*" : " ";
    out(`  ${mark} ${name}  ${String(i.baseUrl ?? "")}  host-ops:${flag(i.enableHostOps)}  destructive:${flag(i.allowDestructive)}`);
  }
  return 0;
}

export async function runInstances(
  argv: string[],
  env: Record<string, string | undefined>,
  out: Out,
  deps: { home?: string } = {},
): Promise<number> {
  const home = deps.home ?? homedir();
  const path = resolveConfigPath(argv.filter((a) => a !== "--config" || false), env, home); // see note below
  const action = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list";
  try {
    const raw = readRawConfig(path);
    switch (action) {
      case "list":
        return listInstances(raw, env, out);
      default:
        out(`Unknown action '${action}'. Usage: coolify-mcp instances [list|default <name>|rm <name>]`);
        return 1;
    }
  } catch (e) {
    out(`error: ${e instanceof CoolifyError ? e.message : e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
```

> Implementation note for the engineer: `resolveConfigPath` expects the raw process argv (it scans for `--config <path>`). Pass `argv` straight through — do NOT pre-filter it. Replace the `path` line with:
> `const path = resolveConfigPath(argv, env, home);`
> and treat `argv[0]` as the action only when it is not `--config`/its value. Simplest correct form:
> ```ts
> const path = resolveConfigPath(argv, env, home);
> const positional = argv.filter((a, idx) => !a.startsWith("--") && argv[idx - 1] !== "--config");
> const action = positional[0] ?? "list";
> ```
> Use `positional[1]` for the `<name>` argument in Tasks 5 and 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/instances.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/instances.ts src/cli/instances.test.ts
git commit -m "feat: add 'coolify-mcp instances' list command"
```

---

### Task 5: `instances default <name>` — set default

**Files:**
- Modify: `src/cli/instances.ts` (add `setDefault` + route `"default"`)
- Test: `src/cli/instances.test.ts` (add cases)

**Interfaces:**
- Consumes: `writeRawConfig` (Task 2), the `positional` parsing from Task 4.
- Produces: `default` action — sets `raw.defaultInstance` and writes; errors on unknown name or no file.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { join as pjoin } from "node:path";

describe("runInstances default", () => {
  function readBack() { return JSON.parse(readFileSync(pjoin(home, ".coolify-mcp", "config.json"), "utf8")); }

  it("sets the default to an existing instance", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" }, b: { baseUrl: "https://b", token: "2|y" } } });
    const c = cap();
    const code = await runInstances(["default", "b"], {}, c.out, { home });
    expect(code).toBe(0);
    expect(readBack().defaultInstance).toBe("b");
  });

  it("errors on an unknown instance name and does not write", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" } } });
    const c = cap();
    const code = await runInstances(["default", "nope"], {}, c.out, { home });
    expect(code).toBe(1);
    expect(c.text()).toMatch(/unknown instance 'nope'/i);
    expect(c.text()).toContain("a");                 // lists known names
    expect(readBack().defaultInstance).toBe("a");    // unchanged
  });

  it("errors when there is no config file", async () => {
    const c = cap();
    const code = await runInstances(["default", "a"], {}, c.out, { home });
    expect(code).toBe(1);
    expect(c.text()).toMatch(/no config file/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/instances.test.ts`
Expected: FAIL — `default` falls into the "Unknown action" branch / no write happens.

- [ ] **Step 3: Implement**

Add a `writeRawConfig` import and a helper, then route the action. In `src/cli/instances.ts`:

```ts
import { readRawConfig, writeRawConfig, type RawConfig } from "./config-file.js";
```

```ts
function requireFile(raw: RawConfig | null): RawConfig {
  if (!raw) throw new CoolifyError("invalid_input", "No config file to edit. Run 'coolify-mcp init' to create one.");
  return raw;
}
function instancesOf(raw: RawConfig): Record<string, unknown> {
  return (raw.instances && typeof raw.instances === "object" ? raw.instances : {}) as Record<string, unknown>;
}
function requireKnown(instances: Record<string, unknown>, name: string | undefined): string {
  if (!name) throw new CoolifyError("invalid_input", "An instance name is required.");
  if (instances[name] === undefined) {
    throw new CoolifyError("invalid_input", `Unknown instance '${name}'; known: ${Object.keys(instances).join(", ") || "(none)"}`);
  }
  return name;
}

function setDefault(path: string, raw: RawConfig | null, name: string | undefined, out: Out): number {
  const cfg = requireFile(raw);
  const instances = instancesOf(cfg);
  const target = requireKnown(instances, name);
  cfg.defaultInstance = target;
  writeRawConfig(path, cfg);
  out(`✓ default instance is now '${target}'`);
  return 0;
}
```

Add the route in the `switch`:

```ts
      case "default":
        return setDefault(path, raw, positional[1], out);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/instances.test.ts`
Expected: PASS (list + default cases).

- [ ] **Step 5: Commit**

```bash
git add src/cli/instances.ts src/cli/instances.test.ts
git commit -m "feat: add 'coolify-mcp instances default <name>'"
```

---

### Task 6: `instances rm <name>` — remove

**Files:**
- Modify: `src/cli/instances.ts` (add `removeInstance` + route `"rm"`/`"remove"`)
- Test: `src/cli/instances.test.ts` (add cases)

**Interfaces:**
- Consumes: helpers from Tasks 4–5.
- Produces: `rm` action with the agreed guards (last-instance refusal; default-with-many refusal/no-write; default-with-one auto-promote).

- [ ] **Step 1: Write the failing test**

```ts
describe("runInstances rm", () => {
  function readBack() { return JSON.parse(readFileSync(pjoin(home, ".coolify-mcp", "config.json"), "utf8")); }

  it("removes a non-default instance", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" }, b: { baseUrl: "https://b", token: "2|y" } } });
    const c = cap();
    expect(await runInstances(["rm", "b"], {}, c.out, { home })).toBe(0);
    expect(Object.keys(readBack().instances)).toEqual(["a"]);
    expect(readBack().defaultInstance).toBe("a");
  });

  it("refuses to remove the only instance", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" } } });
    const c = cap();
    expect(await runInstances(["rm", "a"], {}, c.out, { home })).toBe(1);
    expect(c.text()).toMatch(/at least one|only instance/i);
    expect(Object.keys(readBack().instances)).toEqual(["a"]);   // unchanged
  });

  it("auto-promotes the lone survivor when removing the default", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" }, b: { baseUrl: "https://b", token: "2|y" } } });
    const c = cap();
    expect(await runInstances(["rm", "a"], {}, c.out, { home })).toBe(0);
    const back = readBack();
    expect(Object.keys(back.instances)).toEqual(["b"]);
    expect(back.defaultInstance).toBe("b");
    expect(c.text()).toMatch(/default.*b|b.*default/i);
  });

  it("refuses to remove the default when several remain (and does not write)", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: {}, b: {}, c: {} } });
    const c = cap();
    expect(await runInstances(["rm", "a"], {}, c.out, { home })).toBe(1);
    expect(c.text()).toMatch(/set a new default first|instances default/i);
    expect(Object.keys(readBack().instances).sort()).toEqual(["a", "b", "c"]);  // unchanged
  });

  it("errors on an unknown name", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: {}, b: {} } });
    const c = cap();
    expect(await runInstances(["rm", "zzz"], {}, c.out, { home })).toBe(1);
    expect(c.text()).toMatch(/unknown instance 'zzz'/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/instances.test.ts`
Expected: FAIL — `rm` hits the "Unknown action" branch.

- [ ] **Step 3: Implement**

In `src/cli/instances.ts`:

```ts
function removeInstance(path: string, raw: RawConfig | null, name: string | undefined, out: Out): number {
  const cfg = requireFile(raw);
  const instances = instancesOf(cfg);
  const target = requireKnown(instances, name);
  const names = Object.keys(instances);
  if (names.length === 1) {
    out("error: cannot remove the only instance — a config must define at least one.");
    return 1;
  }
  const isDefault = cfg.defaultInstance === target;
  const remaining = names.filter((n) => n !== target);
  if (isDefault && remaining.length > 1) {
    out(`error: '${target}' is the default; set a new default first: coolify-mcp instances default <name>`);
    out(`       remaining: ${remaining.join(", ")}`);
    return 1;   // no write — file unchanged
  }
  delete instances[target];
  cfg.instances = instances;
  let note = "";
  if (isDefault) { cfg.defaultInstance = remaining[0]; note = ` (default is now '${remaining[0]}')`; }
  writeRawConfig(path, cfg);
  out(`✓ removed instance '${target}'${note}`);
  return 0;
}
```

Add routes to the `switch`:

```ts
      case "rm":
      case "remove":
        return removeInstance(path, raw, positional[1], out);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/instances.test.ts`
Expected: PASS (all list/default/rm cases).

- [ ] **Step 5: Commit**

```bash
git add src/cli/instances.ts src/cli/instances.test.ts
git commit -m "feat: add 'coolify-mcp instances rm <name>' with default/last-instance guards"
```

---

### Task 7: Wire `instances` into the CLI dispatcher

**Files:**
- Modify: `src/cli/index.ts` (`DispatchDeps`, `dispatch` routing)
- Test: `src/cli/index.test.ts` (add a routing case)

**Interfaces:**
- Consumes: `runInstances` (Tasks 4–6).
- Produces: `coolify-mcp instances ...` routes to `runInstances`; `DispatchDeps.runInstances?` is injectable for tests.

- [ ] **Step 1: Write the failing test**

Add to `src/cli/index.test.ts` inside `describe("dispatch", ...)`:

```ts
  it("routes 'instances' to runInstances with the remaining argv", async () => {
    const runInstances = vi.fn(async () => 0);
    const code = await dispatch(["instances", "rm", "stg"], { runDoctor: vi.fn(), runInit: vi.fn(), runServer: vi.fn(), runInstances });
    expect(runInstances).toHaveBeenCalledOnce();
    expect(runInstances.mock.calls[0][0]).toEqual(["rm", "stg"]);   // rest argv
    expect(code).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/index.test.ts`
Expected: FAIL — `runInstances` is never called (`instances` falls through to `runServer`).

- [ ] **Step 3: Implement**

In `src/cli/index.ts`, extend `DispatchDeps`:

```ts
interface DispatchDeps {
  runDoctor: (argv: string[], env: Record<string, string | undefined>, out: (l: string) => void) => Promise<number>;
  runInit: (argv: string[], env: Record<string, string | undefined>) => Promise<number>;
  runInstances: (argv: string[], env: Record<string, string | undefined>, out: (l: string) => void) => Promise<number>;
  runServer: () => Promise<void>;
}
```

Add the route after the `init` branch:

```ts
  if (sub === "instances") {
    const runInstances = deps?.runInstances ?? (await import("./instances.js")).runInstances;
    return runInstances(rest, env, (l) => process.stdout.write(l + "\n"));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/index.test.ts
git commit -m "feat: route 'coolify-mcp instances' subcommand"
```

---

### Task 8: `InstanceRegistry.summaries()`

**Files:**
- Modify: `src/core/registry.ts`
- Test: `src/core/registry.test.ts` (add a describe block)

**Interfaces:**
- Consumes: existing `AppConfig`/`InstanceConfig`.
- Produces:
  - `export interface InstanceSummary { name: string; baseUrl: string; isDefault: boolean; enableHostOps: boolean; allowDestructive: boolean; }`
  - `InstanceRegistry.summaries(): InstanceSummary[]` — secret-free, one entry per configured instance.

- [ ] **Step 1: Write the failing test**

Add to `src/core/registry.test.ts`:

```ts
import { InstanceRegistry } from "./registry.js";
import type { AppConfig } from "./config/schema.js";

describe("InstanceRegistry.summaries", () => {
  const cfg: AppConfig = {
    defaultInstance: "prod",
    instances: {
      prod: { name: "prod", baseUrl: "https://prod", token: "1|secret", extraHeaders: {}, enableHostOps: false, allowDestructive: false },
      stg:  { name: "stg",  baseUrl: "https://stg",  token: "2|secret", extraHeaders: {}, enableHostOps: true,  allowDestructive: true,
              ssh: { keyPath: "/k", passphrase: "pp" } },
    },
  };

  it("returns one secret-free summary per instance with the default marked", () => {
    const s = new InstanceRegistry(cfg).summaries();
    expect(s).toEqual([
      { name: "prod", baseUrl: "https://prod", isDefault: true,  enableHostOps: false, allowDestructive: false },
      { name: "stg",  baseUrl: "https://stg",  isDefault: false, enableHostOps: true,  allowDestructive: true },
    ]);
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(JSON.stringify(s)).not.toContain("pp");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/registry.test.ts`
Expected: FAIL — `summaries` is not a function.

- [ ] **Step 3: Implement**

In `src/core/registry.ts`, add the interface near `ResolvedInstance`:

```ts
export interface InstanceSummary {
  name: string;
  baseUrl: string;
  isDefault: boolean;
  enableHostOps: boolean;
  allowDestructive: boolean;
}
```

Add the method to `InstanceRegistry`:

```ts
  /** Secret-free summary of every configured instance (for list_instances). */
  summaries(): InstanceSummary[] {
    return Object.values(this.cfg.instances).map((c) => ({
      name: c.name,
      baseUrl: c.baseUrl,
      isDefault: c.name === this.cfg.defaultInstance,
      enableHostOps: c.enableHostOps,
      allowDestructive: c.allowDestructive,
    }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts src/core/registry.test.ts
git commit -m "feat: add InstanceRegistry.summaries() (secret-free)"
```

---

### Task 9: Inject instance summaries into `ToolContext`

**Files:**
- Modify: `src/mcp/tools/types.ts` (extend `ToolContext`)
- Modify: `src/mcp/dispatch.ts` (populate the new fields)
- Test: `src/mcp/dispatch.test.ts` (add a case)

**Interfaces:**
- Consumes: `InstanceSummary` + `registry.summaries()`/`registry.defaultName()` (Task 8).
- Produces: `ToolContext.instances?: InstanceSummary[]` and `ToolContext.defaultInstance?: string`, set by `dispatch` on every call.

- [ ] **Step 1: Write the failing test**

Add to `src/mcp/dispatch.test.ts` (a probe tool captures the ctx):

```ts
import type { ToolDef } from "./tools/types.js";

it("injects instance summaries and the default name into ctx", async () => {
  let seen: { instances?: unknown; defaultInstance?: string } = {};
  const probe: ToolDef = {
    name: "probe", description: "", tier: "api", inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_args, ctx) => { seen = { instances: ctx.instances, defaultInstance: ctx.defaultInstance }; return { status: "ok" }; },
  };
  const registry = {
    get: () => ({ name: "prod", config: { name: "prod" }, api: {}, resolver: {}, hostOps: async () => ({}) }),
    summaries: () => [{ name: "prod", baseUrl: "https://prod", isDefault: true, enableHostOps: false, allowDestructive: false }],
    defaultName: () => "prod",
    names: () => ["prod"],
  } as any;
  await dispatch("probe", {}, [probe], registry);
  expect(seen.defaultInstance).toBe("prod");
  expect(seen.instances).toEqual([{ name: "prod", baseUrl: "https://prod", isDefault: true, enableHostOps: false, allowDestructive: false }]);
});
```

(If `dispatch.test.ts` does not already import `dispatch`, add `import { dispatch } from "./dispatch.js";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/dispatch.test.ts`
Expected: FAIL — `ctx.instances`/`ctx.defaultInstance` are `undefined`.

- [ ] **Step 3: Implement**

In `src/mcp/tools/types.ts` add the import and two optional fields:

```ts
import type { InstanceSummary } from "../../core/registry.js";
```

```ts
export interface ToolContext {
  api: CoolifyApiClient;
  config: InstanceConfig;
  hostOps: () => Promise<HostOps>;
  resolver: ServerResolver;
  notifier?: Notifier;
  progressToken?: string | number;
  instances?: InstanceSummary[];   // all configured instances (secret-free), for list_instances
  defaultInstance?: string;        // the default instance name
}
```

In `src/mcp/dispatch.ts`, populate them when building `ctx`:

```ts
    const ctx: ToolContext = {
      api: inst.api,
      config: inst.config,
      hostOps: inst.hostOps,
      resolver: inst.resolver,
      notifier,
      progressToken,
      instances: registry.summaries(),
      defaultInstance: registry.defaultName(),
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/dispatch.test.ts`
Expected: PASS. Then `npm run lint`.

> Note: `instance-arg.test.ts`'s hand-rolled registry stub lacks `summaries`. Because dispatch now calls it, add `summaries: () => []` to the `reg()` stub object in `src/mcp/tools/instance-arg.test.ts` (one line) so those two tests keep passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/types.ts src/mcp/dispatch.ts src/mcp/dispatch.test.ts src/mcp/tools/instance-arg.test.ts
git commit -m "feat: inject instance summaries into ToolContext"
```

---

### Task 10: `list_instances` MCP tool + server registration

**Files:**
- Create: `src/mcp/tools/instances.ts`
- Modify: `src/mcp/server.ts` (import + spread into `getAllTools`)
- Test: `src/mcp/tools/instances.test.ts`

**Interfaces:**
- Consumes: `ctx.instances`/`ctx.defaultInstance` (Task 9), `ok` (`src/core/errors.js`), `ToolDef`/`ToolHandler`.
- Produces: `export const TOOLS: ToolDef[]` containing `list_instances` (tier `"api"`), returning `{ status: "ok", default, instances }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/mcp/tools/instances.test.ts
import { describe, it, expect } from "vitest";
import { TOOLS } from "./instances.js";
import type { ToolContext } from "./types.js";

const tool = TOOLS.find((t) => t.name === "list_instances")!;

function ctx(over: Partial<ToolContext>): ToolContext {
  return {
    api: {} as any, config: {} as any, hostOps: (async () => ({})) as any, resolver: {} as any,
    ...over,
  } as ToolContext;
}

describe("list_instances", () => {
  it("is registered as an api-tier tool with an optional instance arg", () => {
    expect(tool.tier).toBe("api");
    const props = (tool.inputSchema as any).properties ?? {};
    expect(props.instance).toMatchObject({ type: "string" });
    expect((tool.inputSchema as any).required ?? []).not.toContain("instance");
  });

  it("returns the default name and the secret-free summaries from ctx", async () => {
    const summaries = [
      { name: "prod", baseUrl: "https://prod", isDefault: true, enableHostOps: false, allowDestructive: false },
      { name: "stg",  baseUrl: "https://stg",  isDefault: false, enableHostOps: true,  allowDestructive: true },
    ];
    const res = await tool.handler({}, ctx({ instances: summaries, defaultInstance: "prod" }));
    expect(res).toEqual({ status: "ok", default: "prod", instances: summaries });
  });

  it("degrades to an empty list if ctx has no summaries", async () => {
    const res = await tool.handler({}, ctx({}));
    expect(res).toMatchObject({ status: "ok", instances: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/tools/instances.test.ts`
Expected: FAIL — cannot find module `./instances.js`.

- [ ] **Step 3: Implement the tool**

```ts
// src/mcp/tools/instances.ts
import { ok } from "../../core/errors.js";
import type { ToolDef, ToolHandler } from "./types.js";

const listInstances: ToolHandler = async (_args, ctx) => {
  return ok({ default: ctx.defaultInstance, instances: ctx.instances ?? [] });
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_instances",
    description: "List the Coolify instances this server is configured to drive (names, base URLs, default, and per-instance host-ops/destructive flags). Never returns tokens or other secrets. Pass an instance name as the 'instance' arg to any other tool to route to it.",
    tier: "api",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "Ignored — the instance list is global. Present for argument-shape consistency." },
      },
      required: [],
    },
    handler: listInstances,
  },
];
```

Register it in `src/mcp/server.ts`:

```ts
import { TOOLS as instanceTools } from "./tools/instances.js";
```

and add to the `all` array in `getAllTools`:

```ts
  const all = [
    ...deployTools, ...resourceTools, ...storageTools, ...backupTools, ...scheduledTaskTools,
    ...envTools, ...logTools, ...serverTools, ...projectTools, ...instanceTools, ...hostTools,
  ];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp/tools/instances.test.ts src/mcp/server.wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/instances.ts src/mcp/server.ts src/mcp/tools/instances.test.ts
git commit -m "feat: add read-only list_instances MCP tool"
```

---

### Task 11: Docs, version bump, full build

**Files:**
- Modify: `README.md` (§5 multi-instance, tool table)
- Modify: `package.json` (version `0.1.2` → `0.2.0`)
- Modify: `src/mcp/server.ts` (`new Server({ name: "coolify-mcp", version: "0.2.0" }, ...)`)
- Rebuild: `dist/cli/index.js` (+ `THIRD-PARTY-NOTICES.txt` if it changes)

**Interfaces:**
- Consumes: everything above.
- Produces: shipping docs + a fresh committed bundle.

- [ ] **Step 1: Update the version strings**

In `package.json` set `"version": "0.2.0"`. In `src/mcp/server.ts` (`buildServer`) change the `version: "0.1.2"` literal to `"0.2.0"`.

- [ ] **Step 2: Update README §5 and the tool table**

In README §5 ("Multi-instance + per-call `instance` selector"), append guidance for setup/management:

```markdown
#### Managing instances

`init` **merges** into your existing `~/.coolify-mcp/config.json` — re-run it to add another
instance (it asks for a name, whether to make it the default, and confirms before overwriting an
existing one; your other instances are left untouched).

```bash
coolify-mcp instances                 # list configured instances (* = default); never prints secrets
coolify-mcp instances default <name>  # set the default instance
coolify-mcp instances rm <name>       # remove an instance
```

`instances rm` refuses to remove the only instance, and refuses to remove the current default while
several remain (set a new default first with `instances default <name>`); removing the default when a
single instance is left auto-promotes the survivor.
```

In the **Deploy** tool table (or a small new "Instances" subsection of "## Tools"), add the new tool row:

```markdown
| `list_instances` | R | List configured Coolify instances (names, base URLs, default, tier flags). Never returns secrets. |
```

- [ ] **Step 3: Run the full suite + lint**

Run: `npm run lint && npm test`
Expected: PASS, including `src/__tests__/readme.test.ts` (the substrings it checks — `instance`, `config.json`, tiers — remain present).

- [ ] **Step 4: Rebuild the committed bundle**

Run: `npm run build`
Then verify the staleness gate passes after staging:

Run: `git add -A && git diff --cached --stat -- dist/ THIRD-PARTY-NOTICES.txt`
Expected: shows the regenerated `dist/cli/index.js` (and `THIRD-PARTY-NOTICES.txt` only if deps changed — none were added, so it likely won't).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: multi-instance management docs, list_instances, v0.2.0 + rebuild"
```

---

## Self-Review

**Spec coverage:**
- §1 shared config-path resolution → Task 1 (+ used in Tasks 3, 4–6).
- §2 init detect & merge → Task 3 (`buildInstanceObject`, merge, default prompt, reconfigure-confirm).
- §3 `instances` group: list → Task 4; default → Task 5; rm (all guards) → Task 6; dispatcher wiring → Task 7; file-required errors → Tasks 5–6 (`requireFile`).
- §4 `list_instances` tool → Task 10; `registry.summaries()` → Task 8; ctx injection → Task 9; registered on stdio + HTTP via `getAllTools` (Task 10) which both transports consume.
- §5 docs/tests/build → Task 11; tests are inline in every task; version bump in Task 11.
- Error-handling table → Tasks 5 (unknown name, no file), 6 (last-instance, default-with-many, unknown name), 2 (malformed file).

**Placeholder scan:** No TBD/TODO; every code/test step contains complete code; commands have expected output.

**Type consistency:** `InstanceSummary` defined in Task 8 (`registry.ts`), imported by Tasks 9 (`types.ts`) and used by Task 10. `RawConfig` defined in Task 2, used by Tasks 3–6. `resolveConfigPath` signature `(argv, env, home)` consistent across Tasks 1, 3, 4. `runInstances(argv, env, out, deps?)` consistent across Tasks 4–7. `readRawConfig`/`writeRawConfig` signatures consistent across Tasks 2–6. `buildInstanceObject`/`buildConfigObject` consistent in Task 3.

**Known test touch-ups folded into tasks:** `instance-arg.test.ts` registry stub gains `summaries: () => []` (Task 9 note); existing `init.test.ts` cases stay green via optional `readConfig` (Task 3 note).
