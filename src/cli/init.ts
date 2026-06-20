import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IO } from "./io.js";
import { defaultIO } from "./io.js";
import { CoolifyApiClient } from "../core/api/client.js";
import { ServerResolver } from "../core/ssh/resolver.js";
import { SshClient } from "../core/ssh/client.js";
import { scanSshDir, discoverWorkingKey } from "./ssh-discover.js";

export interface InitConfigInput {
  instanceName: string;
  baseUrl: string;
  enableHostOps: boolean;
  ssh?: { keyPath: string; hostServer?: string; host?: string; hasPassphrase: boolean; fingerprint?: string };
  db?: { readonlyUser: string };
}

export function buildConfigObject(input: InitConfigInput): unknown {
  const inst: Record<string, unknown> = {
    baseUrl: input.baseUrl,
    token: "${COOLIFY_TOKEN}",
    enableHostOps: input.enableHostOps,
    allowDestructive: false,
  };
  if (input.ssh) {
    const ssh: Record<string, unknown> = { keyPath: input.ssh.keyPath };
    if (input.ssh.host) ssh.host = input.ssh.host;
    if (input.ssh.hostServer) ssh.hostServer = input.ssh.hostServer;
    if (input.ssh.fingerprint) ssh.fingerprint = input.ssh.fingerprint;
    if (input.ssh.hasPassphrase) ssh.passphrase = "${COOLIFY_SSH_KEY_PASSPHRASE}";
    inst.ssh = ssh;
  }
  if (input.db) {
    inst.db = { readonlyUser: input.db.readonlyUser, readonlyPassword: "${COOLIFY_DB_RO_PASSWORD}" };
  }
  return { defaultInstance: input.instanceName, instances: { [input.instanceName]: inst } };
}

export function generatePassword(bytes = 24): string {
  // Over-generate so stripping +/= still leaves >= 32 chars, then take exactly 32.
  return randomBytes(bytes + 12).toString("base64").replace(/[+/=]/g, "").slice(0, 32);
}

/** A PostgreSQL role name safe to interpolate into the generated SQL (letters, digits, underscore; not digit-led). */
export function isValidDbRoleName(user: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(user);
}

export function generateDbRoleSql(user: string, password: string): string {
  if (!isValidDbRoleName(user)) {
    throw new Error(`invalid DB role name ${JSON.stringify(user)} — use letters, digits, and underscores (must not start with a digit)`);
  }
  return [
    `CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;`,
    `GRANT CONNECT ON DATABASE coolify TO ${user};`,
    `GRANT USAGE ON SCHEMA public TO ${user};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${user};`,
    `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM ${user};`,
  ].join("\n");
}

export interface InitDeps {
  io: IO;
  env: Record<string, string | undefined>;
  makeApi: (baseUrl: string, token: string) => { health(): Promise<unknown>; version(): Promise<string> };
  resolveControlHost: (baseUrl: string, token: string, hostServer?: string) => Promise<{ serverUuid: string; host: string; user: string; port: number }>;
  listServers: (baseUrl: string, token: string) => Promise<Array<{ uuid: string; name?: string }>>;
  discoverKey: (host: string, user: string, port: number) => Promise<{ path: string; passphrase?: string } | { ppkOnly: true } | null>;
  getFingerprint: (host: string, port: number) => Promise<string>;
  writeConfig: (obj: unknown) => string;
}

export async function runInitFlow(deps: InitDeps): Promise<number> {
  const { io, env } = deps;
  io.print("coolify-mcp setup\n");

  // 1. API
  const baseUrl = await io.prompt("Coolify base URL", env.COOLIFY_BASE_URL);
  const token = await io.prompt("API token (<id>|<secret>)", env.COOLIFY_TOKEN);
  try {
    const api = deps.makeApi(baseUrl, token);
    await api.health();
    const version = await api.version();
    io.print(`✓ connected — Coolify ${version}`);
  } catch (e) {
    io.print(`✗ could not authenticate: ${e instanceof Error ? e.message : String(e)}`);
    io.print("  The token must be '<id>|<secret>' with scope: write + read:sensitive.");
    return 1;
  }

  const instanceName = await io.prompt("Instance name", "default");

  // 2. host-ops
  let ssh: InitConfigInput["ssh"];
  let enableHostOps = false;
  if (await io.confirm("Enable host-ops (SSH/Docker/live logs)?", false)) {
    let hostServer: string | undefined;
    let ch: { serverUuid: string; host: string; user: string; port: number } | undefined;
    try {
      ch = await deps.resolveControlHost(baseUrl, token);
    } catch {
      const servers = await deps.listServers(baseUrl, token);
      io.print("Could not auto-detect the control host. Servers:");
      servers.forEach((s, i) => io.print(`  ${i + 1}. ${s.name ?? s.uuid} (${s.uuid})`));
      const pick = await io.prompt("Which server is the Coolify control host? (uuid or name)");
      hostServer = pick;
      try {
        ch = await deps.resolveControlHost(baseUrl, token, hostServer);
      } catch (e) {
        io.print(`Could not resolve server '${hostServer}': ${e instanceof Error ? e.message : String(e)} — skipping host-ops.`);
      }
    }
    if (ch) {
      const found = await deps.discoverKey(ch.host, ch.user, ch.port);
      if (found && "ppkOnly" in found) {
        io.print("Found only a PuTTY .ppk key. Export an OpenSSH key first:");
        io.print("  puttygen GUI → Load your .ppk → Conversions → Export OpenSSH key");
        io.print("Then re-run 'coolify-mcp init' to finish host-ops. Continuing with API only.");
      } else if (found) {
        const fingerprint = await deps.getFingerprint(ch.host, ch.port);
        io.print(`Host key fingerprint: ${fingerprint}`);
        if (await io.confirm("Pin this fingerprint (verify it matches your host)?", false)) {
          enableHostOps = true;
          ssh = { keyPath: found.path, hostServer, host: undefined, hasPassphrase: !!found.passphrase, fingerprint };
          io.print(`✓ host-ops will use ${found.path}`);
        } else {
          io.print("Fingerprint not confirmed — skipping host-ops.");
        }
      } else {
        io.print("No working SSH key found in ~/.ssh — skipping host-ops. (See README host-ops section.)");
      }
    }
  }

  // 3. DB role
  let db: InitConfigInput["db"];
  if (enableHostOps && (await io.confirm("Enable query_coolify_db (raw read-only SQL)?", false))) {
    let user = await io.prompt("Read-only DB role name", "coolify_ro");
    if (!isValidDbRoleName(user)) {
      io.print(`Invalid role name '${user}' — using 'coolify_ro' instead.`);
      user = "coolify_ro";
    }
    const password = generatePassword();
    db = { readonlyUser: user };
    io.print("\nRun this SQL on your Coolify Postgres (psql -U postgres coolify):\n");
    io.print(generateDbRoleSql(user, password));
    io.print(`\nThen set: COOLIFY_DB_RO_PASSWORD=${password}\n`);
  }

  // 4. write config
  const obj = buildConfigObject({ instanceName, baseUrl, enableHostOps, ssh, db });
  const path = deps.writeConfig(obj);
  io.print(`\n✓ wrote ${path}`);

  // 5. handoff
  io.print("\nSet these environment variables (values shown once):");
  io.print(`  COOLIFY_TOKEN=${token}`);
  if (ssh?.hasPassphrase) io.print("  COOLIFY_SSH_KEY_PASSPHRASE=<the passphrase you entered>");
  io.print("\nMCP client config:");
  io.print(JSON.stringify({ mcpServers: { coolify: { command: "coolify-mcp", args: [], env: { COOLIFY_TOKEN: "<your token>" } } } }, null, 2));
  io.print("\nVerify any time with:  coolify-mcp doctor");
  return 0;
}

export async function runInit(_argv: string[], env: Record<string, string | undefined>, io: IO = defaultIO): Promise<number> {
  try {
    return await runInitFlowWithRealDeps(io, env);
  } finally {
    io.close?.();
  }
}

function runInitFlowWithRealDeps(io: IO, env: Record<string, string | undefined>): Promise<number> {
  return runInitFlow({
    io,
    env,
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
    writeConfig: (obj) => {
      const dir = join(homedir(), ".coolify-mcp");
      mkdirSync(dir, { recursive: true });
      const cfgPath = join(dir, "config.json");
      if (existsSync(cfgPath)) copyFileSync(cfgPath, cfgPath + ".bak");
      writeFileSync(cfgPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
      return cfgPath;
    },
  });
}
