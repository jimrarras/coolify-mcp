import type { CoolifyApiClient } from "../core/api/client.js";
import type { ServerResolver, ControlHost } from "../core/ssh/resolver.js";
import type { InstanceConfig } from "../core/config/schema.js";
import type { ResolvedInstance } from "../core/registry.js";
import { SshClient } from "../core/ssh/client.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export async function checkApi(api: CoolifyApiClient): Promise<CheckResult> {
  try {
    await api.health();
    const version = await api.version();
    return { name: "api", status: "ok", detail: `Coolify ${version} reachable` };
  } catch (e) {
    const err = e as { kind?: string; message?: string };
    if (err.kind === "auth") {
      return {
        name: "api",
        status: "fail",
        detail: "authentication failed (401/403)",
        fix: "COOLIFY_TOKEN must be '<id>|<secret>' with scope: write + read:sensitive.",
      };
    }
    return {
      name: "api",
      status: "fail",
      detail: err.message ?? String(e),
      fix: "Check COOLIFY_BASE_URL is the bare host URL (no /api, no trailing slash) and is reachable.",
    };
  }
}

export async function checkControlHost(
  resolver: Pick<ServerResolver, "resolveControlHost">,
  baseUrl: string,
  enableHostOps: boolean,
): Promise<CheckResult> {
  if (!enableHostOps) return { name: "control_host", status: "skip", detail: "host-ops disabled" };
  try {
    const ch = await resolver.resolveControlHost();
    let note = "";
    try {
      if (ch.host === new URL(baseUrl).hostname) note = " (using baseUrl host)";
    } catch { /* ignore URL parse */ }
    return { name: "control_host", status: "ok", detail: `${ch.user}@${ch.host}:${ch.port}${note}` };
  } catch (e) {
    const err = e as { message?: string };
    return {
      name: "control_host",
      status: "fail",
      detail: err.message ?? String(e),
      fix: "Set ssh.hostServer (the control server's uuid or name), or ssh.host (its reachable address).",
    };
  }
}

export type SshConnectProbe = (cfg: {
  host: string; user: string; port: number; keyPath: string;
  passphrase?: string; fingerprint?: string; knownHostsPath?: string;
}) => Promise<void>;

export function classifySshError(e: unknown, keyPath: string): CheckResult {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.toLowerCase();
  if (keyPath.toLowerCase().endsWith(".ppk") || m.includes("unsupported key format") || m.includes("cannot parse privatekey")) {
    return { name: "ssh", status: "fail", detail: msg,
      fix: "Key is not OpenSSH format (PuTTY .ppk?). Export an OpenSSH key (puttygen GUI: Conversions → Export OpenSSH key) and set ssh.keyPath to it." };
  }
  // Order matters: passphrase before host-key before auth (messages overlap).
  if (m.includes("passphrase") || m.includes("encrypted private key") || m.includes("integrity check")) {
    return { name: "ssh", status: "fail", detail: msg,
      fix: "Key is passphrase-protected. Set ssh.passphrase (e.g. ${COOLIFY_SSH_KEY_PASSPHRASE})." };
  }
  if (m.includes("hostverifier") || m.includes("host key verification") || m.includes("host key mismatch") || m.includes("known_hosts")) {
    return { name: "ssh", status: "fail", detail: msg,
      fix: "Host key not trusted. Pin ssh.fingerprint (SHA256:...) or add a literal entry to ~/.ssh/known_hosts." };
  }
  if (m.includes("authentication") || m.includes("publickey")) {
    return { name: "ssh", status: "fail", detail: msg,
      fix: "Auth rejected. Ensure the key's public half is in the host user's authorized_keys and ssh.user is correct." };
  }
  return { name: "ssh", status: "fail", detail: msg,
    fix: "Could not connect. Check the host is reachable on the SSH port and ssh.host/ssh.port are correct." };
}

export async function checkSsh(
  ch: ControlHost,
  ssh: InstanceConfig["ssh"],
  probe: SshConnectProbe,
  enableHostOps: boolean,
): Promise<CheckResult> {
  if (!enableHostOps) return { name: "ssh", status: "skip", detail: "host-ops disabled" };
  if (!ssh?.keyPath) {
    return { name: "ssh", status: "fail", detail: "no ssh.keyPath configured",
      fix: "Set ssh.keyPath to an OpenSSH private key authorized on the host." };
  }
  const host = ssh.host ?? ch.host;
  const user = ssh.user ?? ch.user;
  const port = ssh.port ?? ch.port;
  try {
    await probe({ host, user, port, keyPath: ssh.keyPath, passphrase: ssh.passphrase, fingerprint: ssh.fingerprint, knownHostsPath: ssh.knownHostsPath });
    return { name: "ssh", status: "ok", detail: `SSH ${user}@${host}:${port} OK` };
  } catch (e) {
    return classifySshError(e, ssh.keyPath);
  }
}

export async function checkDbRole(inst: ResolvedInstance, enableHostOps: boolean): Promise<CheckResult> {
  if (!enableHostOps || !inst.config.db?.readonlyUser) {
    return { name: "db_role", status: "skip", detail: "query_coolify_db not configured" };
  }
  try {
    const hostOps = await inst.hostOps();
    await hostOps.psqlReadOnly("SELECT 1");
    return { name: "db_role", status: "ok", detail: `read-only role '${inst.config.db.readonlyUser}' works` };
  } catch (e) {
    return { name: "db_role", status: "fail", detail: e instanceof Error ? e.message : String(e),
      fix: "Provision the hardened read-only role (see README §4 'query_coolify_db')." };
  }
}

// Real SSH probe used by doctor; tests inject their own.
export const defaultSshProbe: SshConnectProbe = async (cfg) => {
  const client = new SshClient({
    host: cfg.host, user: cfg.user, port: cfg.port, keyPath: cfg.keyPath,
    hostFingerprint: cfg.fingerprint, knownHostsPath: cfg.knownHostsPath, passphrase: cfg.passphrase,
  });
  // SshClient.connect() runs the fail-closed host-key verification internally.
  await client.connect();
  await client.exec("true");
  await client.close();
};

export async function runAllChecks(inst: ResolvedInstance, probe: SshConnectProbe = defaultSshProbe): Promise<CheckResult[]> {
  const enableHostOps = inst.config.enableHostOps;
  const results: CheckResult[] = [];
  results.push(await checkApi(inst.api));
  results.push(await checkControlHost(inst.resolver, inst.config.baseUrl, enableHostOps));
  let ch: ControlHost = { serverUuid: "", host: "", user: "root", port: 22 };
  if (enableHostOps) {
    try { ch = await inst.resolver.resolveControlHost(); } catch { /* control_host check already reported */ }
  }
  results.push(await checkSsh(ch, inst.config.ssh, probe, enableHostOps));
  results.push(await checkDbRole(inst, enableHostOps));
  return results;
}
