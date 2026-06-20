// src/core/registry.ts
import { CoolifyApiClient } from "./api/client.js";
import { ServerResolver } from "./ssh/resolver.js";
import { SshClient } from "./ssh/client.js";
import { HostOps } from "./ssh/host-ops.js";
import { CoolifyError } from "./errors.js";
import type { AppConfig, InstanceConfig } from "./config/schema.js";

export interface ResolvedInstance {
  name: string;
  config: InstanceConfig;
  api: CoolifyApiClient;
  resolver: ServerResolver;
  hostOps: () => Promise<HostOps>;
}

export class InstanceRegistry {
  private readonly cfg: AppConfig;
  private readonly cache = new Map<string, ResolvedInstance>();
  constructor(cfg: AppConfig) { this.cfg = cfg; }

  names(): string[] { return Object.keys(this.cfg.instances); }
  defaultName(): string { return this.cfg.defaultInstance; }

  get(name?: string): ResolvedInstance {
    const key = name ?? this.cfg.defaultInstance;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const config = this.cfg.instances[key];
    if (!config) {
      throw new CoolifyError("invalid_input", `Unknown instance '${key}'; known: ${this.names().join(", ")}`);
    }
    const api = new CoolifyApiClient({ baseUrl: config.baseUrl, token: config.token, extraHeaders: config.extraHeaders });
    const resolver = new ServerResolver(api, { baseUrl: config.baseUrl, hostServer: config.ssh?.hostServer });
    const hostOps = makeInstanceHostOps(config, api, resolver);
    const resolved: ResolvedInstance = { name: key, config, api, resolver, hostOps };
    this.cache.set(key, resolved);
    return resolved;
  }
}

/** Lazy async HostOps builder for one instance. Resolves the control host via the API on first use. */
export function makeInstanceHostOps(config: InstanceConfig, api: CoolifyApiClient, resolver: ServerResolver): () => Promise<HostOps> {
  void api;
  let instance: HostOps | undefined;
  return async (): Promise<HostOps> => {
    if (!config.enableHostOps) {
      throw new CoolifyError("host_ops_disabled", `Host-ops is disabled for instance '${config.name}'. Set enableHostOps:true (and ssh.keyPath) to use this tool.`);
    }
    if (!instance) {
      if (!config.ssh) throw new CoolifyError("invalid_input", `Instance '${config.name}' has enableHostOps but no ssh.keyPath configured.`);
      const ch = await resolver.resolveControlHost();
      const ssh = new SshClient({
        host: config.ssh.host ?? ch.host,
        user: config.ssh.user ?? ch.user,
        port: config.ssh.port ?? ch.port,
        keyPath: config.ssh.keyPath,
        hostFingerprint: config.ssh.fingerprint,
        knownHostsPath: config.ssh.knownHostsPath,
        passphrase: config.ssh.passphrase,
      });
      // Establish the SSH connection now (fail-closed host-key verification runs
      // here). HostOps' exec/stream/sftp calls all require an already-connected
      // client — without this the first host-op throws "SshClient: not connected".
      await ssh.connect();
      instance = new HostOps(ssh, resolver, config.db?.readonlyUser, config.db?.readonlyPassword);
    }
    return instance;
  };
}
