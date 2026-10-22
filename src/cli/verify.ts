// Post-edit verification: after `instances set/unset/edit` writes the config,
// confirm the edited instance still works — API health always, SSH connect only
// when ssh fields changed. Unresolvable ${ENV} refs skip rather than fail.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandEnvRefs, expandHome } from '../core/config/env-expand.js';
import { CoolifyApiClient } from '../core/api/client.js';
import { SshClient } from '../core/ssh/client.js';

export type VerifyResult = { ok: boolean; detail: string } | { skipped: string };

export type VerifyFn = (
  name: string,
  instRaw: Record<string, unknown>,
  opts: { sshChanged: boolean },
) => Promise<VerifyResult>;

/** Expand every ${ENV} ref in a raw instance's string fields (recursively). Throws on unresolved refs. */
function expandStrings(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === 'string') return expandEnvRefs(v, env);
  if (Array.isArray(v)) return v.map((x) => expandStrings(x, env));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = expandStrings(val, env);
    return out;
  }
  return v;
}

export function makeVerifier(env: Record<string, string | undefined>, home = homedir()): VerifyFn {
  return async (name, instRaw, opts) => {
    let inst: Record<string, unknown>;
    try {
      inst = expandStrings(instRaw, env) as Record<string, unknown>;
    } catch (e) {
      return {
        skipped: `unresolved env reference (${e instanceof Error ? e.message : String(e)})`,
      };
    }
    const baseUrl = typeof inst.baseUrl === 'string' ? inst.baseUrl : '';
    const token = typeof inst.token === 'string' ? inst.token : '';
    if (!baseUrl || !token) return { skipped: 'instance has no baseUrl/token to verify' };
    try {
      const api = new CoolifyApiClient({ baseUrl, token, extraHeaders: {} });
      await api.health();
      const version = await api.version();
      let detail = `API ok (Coolify ${version})`;
      const ssh = inst.ssh as Record<string, unknown> | undefined;
      if (opts.sshChanged && ssh && typeof ssh.keyPath === 'string') {
        const c = new SshClient({
          host: typeof ssh.host === 'string' ? ssh.host : new URL(baseUrl).hostname,
          user: typeof ssh.user === 'string' ? ssh.user : 'root',
          port: typeof ssh.port === 'number' ? ssh.port : 22,
          keyPath: expandHome(ssh.keyPath, home),
          passphrase: typeof ssh.passphrase === 'string' ? ssh.passphrase : undefined,
          hostFingerprint: typeof ssh.fingerprint === 'string' ? ssh.fingerprint : undefined,
          knownHostsPath:
            typeof ssh.knownHostsPath === 'string'
              ? expandHome(ssh.knownHostsPath, home)
              : join(home, '.ssh', 'known_hosts'),
        });
        await c.connect();
        await c.close();
        detail += ', SSH ok';
      }
      return { ok: true, detail };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  };
}
