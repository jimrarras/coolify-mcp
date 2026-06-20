// src/core/ssh/resolver.ts
import type { CoolifyApiClient } from "../api/client.js";
import type { ResourceKind } from "../api/deployments.js";
import { CoolifyError } from "../errors.js";

export interface ServerTarget {
  serverUuid: string;
  isCoolifyHost: boolean;
  dockerHost?: string;
}

export interface ControlHost {
  serverUuid: string;
  host: string;
  user: string;
  port: number;
}

/**
 * True for addresses that an external workstation cannot reach over SSH — the
 * Coolify "localhost" server commonly reports one of these as its `ip`
 * (e.g. `host.docker.internal` when Coolify talks to the host's Docker socket).
 */
function isNonRoutableHost(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    h === "host.docker.internal" ||
    h === "gateway.docker.internal" ||
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    /^127\./.test(h)
  );
}

export class ServerResolver {
  private readonly api: CoolifyApiClient;
  private readonly baseUrl: string | undefined;
  private readonly hostServerHint: string | undefined;
  private coolifyHostUuid: string | undefined;
  // Cache: key -> ServerTarget
  private readonly cache = new Map<string, ServerTarget>();

  constructor(api: CoolifyApiClient, opts?: { baseUrl?: string; hostServer?: string }) {
    this.api = api;
    this.baseUrl = opts?.baseUrl;
    this.hostServerHint = opts?.hostServer;
  }

  async resolveControlHost(): Promise<ControlHost> {
    let record: Record<string, unknown> | undefined;
    if (this.hostServerHint) {
      const t = await this.resolveByServer(this.hostServerHint);
      record = await this.api.servers.get(t.serverUuid);
    } else {
      if (!this.baseUrl) {
        throw new CoolifyError(
          "invalid_input",
          "control-host resolution requires baseUrl or ssh.hostServer",
        );
      }
      const wantHost = new URL(this.baseUrl).hostname.toLowerCase();
      const all = await this.api.servers.list();
      record = all.find((s) => {
        const ip = String(s["ip"] ?? "").toLowerCase();
        const name = String(s["name"] ?? "").toLowerCase();
        const fqdn = String(s["fqdn"] ?? s["domain"] ?? "").toLowerCase();
        // Exact matches only. A substring (`includes`) match would let a
        // compromised Coolify API hijack control-host selection with a record
        // whose fqdn merely *contains* the real host (e.g. "evil-coolify.example.com"),
        // redirecting the SSH target. Require an exact ip/name/fqdn match.
        return ip === wantHost || name === wantHost || fqdn === wantHost;
      });
      if (!record) {
        throw new CoolifyError(
          "invalid_input",
          `Could not identify the Coolify control host for ${this.baseUrl} among the API's servers. Set ssh.hostServer to the control server's uuid or name (or ssh.host to its reachable address).`,
        );
      }
    }
    const serverUuid = String(record["uuid"] ?? "");
    this.coolifyHostUuid = serverUuid;
    // Invalidate any cached entry for this uuid so _buildTarget rebuilds it with isCoolifyHost=true.
    this.cache.delete(`server:${serverUuid}`);
    const rawIp = String(record["ip"] ?? "");
    const user = String(record["user"] ?? "root");
    const port = typeof record["port"] === "number" ? (record["port"] as number) : 22;
    // If the resolved control host's ip is a non-routable alias (host.docker.internal,
    // loopback, …) an external workstation cannot SSH to it. Substitute the
    // operator-configured baseUrl host: it is provably reachable (the REST API is
    // served over it) and is operator-trusted, NOT API-influenced — so a compromised
    // API cannot use this to redirect the SSH target (the server was still selected
    // by an exact match or an explicit ssh.hostServer). An explicit `ssh.host`
    // override (applied by registry.ts) takes precedence over this.
    let host = rawIp;
    if (isNonRoutableHost(rawIp) && this.baseUrl) {
      host = new URL(this.baseUrl).hostname;
    }
    const IP_RE = /^[A-Za-z0-9.\-:\[\]]+$/;
    const USER_RE = /^[A-Za-z0-9_.-]+$/;
    if (!IP_RE.test(host)) {
      throw new CoolifyError(
        "invalid_input",
        `control host has invalid ip/host: ${JSON.stringify(host)}`,
      );
    }
    if (!USER_RE.test(user)) {
      throw new CoolifyError(
        "invalid_input",
        `control host has invalid user: ${JSON.stringify(user)}`,
      );
    }
    return { serverUuid, host, user, port };
  }

  async resolveByResource(kind: ResourceKind, resourceUuid: string): Promise<ServerTarget> {
    const cacheKey = `${kind}:${resourceUuid}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let resource: Record<string, unknown>;
    if (kind === "applications") {
      resource = await this.api.applications.get(resourceUuid);
    } else if (kind === "databases") {
      resource = await this.api.databases.get(resourceUuid);
    } else if (kind === "services") {
      resource = await this.api.services.get(resourceUuid);
    } else {
      throw new CoolifyError("invalid_input", `Unknown resource kind: ${String(kind)}`);
    }

    const serverUuid = resource["server_uuid"];
    if (typeof serverUuid !== "string" || serverUuid === "") {
      throw new CoolifyError(
        "not_found",
        `Resource ${resourceUuid} has no server_uuid`,
      );
    }

    const target = await this._resolveServerRecord(serverUuid);
    this.cache.set(cacheKey, target);
    return target;
  }

  async resolveByServer(serverUuidOrName: string): Promise<ServerTarget> {
    const cacheKey = `server:${serverUuidOrName}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let serverRecord: Record<string, unknown> | undefined;
    try {
      serverRecord = await this.api.servers.get(serverUuidOrName);
    } catch (e) {
      // not_found: try matching by name via list
      const err = e as { kind?: string };
      if (err.kind === "not_found") {
        const all = await this.api.servers.list();
        const match = all.find(
          (s) => typeof s["name"] === "string" && s["name"] === serverUuidOrName,
        );
        if (!match) {
          throw new CoolifyError(
            "not_found",
            `No server found with UUID or name: ${serverUuidOrName}`,
          );
        }
        serverRecord = match;
      } else {
        throw e;
      }
    }

    const uuid = String(serverRecord!["uuid"] ?? "");
    const target = this._buildTarget(uuid, serverRecord!);
    this.cache.set(cacheKey, target);
    return target;
  }

  private async _resolveServerRecord(serverUuid: string): Promise<ServerTarget> {
    const serverCacheKey = `server:${serverUuid}`;
    if (this.cache.has(serverCacheKey)) {
      return this.cache.get(serverCacheKey)!;
    }
    const record = await this.api.servers.get(serverUuid);
    const target = this._buildTarget(serverUuid, record);
    this.cache.set(serverCacheKey, target);
    return target;
  }

  private _buildTarget(serverUuid: string, record: Record<string, unknown>): ServerTarget {
    const isCoolifyHost =
      this.coolifyHostUuid !== undefined && serverUuid === this.coolifyHostUuid;

    if (isCoolifyHost) {
      return { serverUuid, isCoolifyHost: true };
    }

    const ip = String(record["ip"] ?? "");
    const user = String(record["user"] ?? "root");

    // Validate ip/host: allow only characters safe in a URI authority / SSH host
    // (alphanumerics, dots, hyphens, colons for IPv6, brackets for [::1] notation)
    const IP_RE = /^[A-Za-z0-9.\-:\[\]]+$/;
    if (!IP_RE.test(ip)) {
      throw new CoolifyError(
        "invalid_input",
        `Server record contains an invalid ip/host value: ${JSON.stringify(ip)}`,
      );
    }

    // Validate user: allow only characters safe as a Unix username
    const USER_RE = /^[A-Za-z0-9_.-]+$/;
    if (!USER_RE.test(user)) {
      throw new CoolifyError(
        "invalid_input",
        `Server record contains an invalid user value: ${JSON.stringify(user)}`,
      );
    }

    const dockerHost = `ssh://${user}@${ip}`;
    return { serverUuid, isCoolifyHost: false, dockerHost };
  }
}
