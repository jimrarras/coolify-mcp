// src/core/ssh/resolver.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServerResolver } from "./resolver.js";
import type { CoolifyApiClient } from "../api/client.js";

// Minimal mock of CoolifyApiClient
function makeApi(overrides: Partial<{
  serversGet: (uuid: string) => Promise<Record<string, unknown>>;
  serversList: () => Promise<Record<string, unknown>[]>;
  applicationsGet: (uuid: string) => Promise<Record<string, unknown>>;
  databasesGet: (uuid: string) => Promise<Record<string, unknown>>;
  servicesGet: (uuid: string) => Promise<Record<string, unknown>>;
}>): CoolifyApiClient {
  return {
    servers: {
      get: overrides.serversGet ?? vi.fn(),
      list: overrides.serversList ?? vi.fn(),
      validate: vi.fn(),
      resources: vi.fn(),
      domains: vi.fn(),
      create: vi.fn(),
      createHetzner: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    applications: {
      get: overrides.applicationsGet ?? vi.fn(),
      list: vi.fn(),
      createPublic: vi.fn(),
      createPrivateGithubApp: vi.fn(),
      createPrivateDeployKey: vi.fn(),
      createDockerfile: vi.fn(),
      createDockerimage: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      control: vi.fn(),
      logs: vi.fn(),
      listEnvs: vi.fn(),
      upsertEnvsBulk: vi.fn(),
      deleteEnv: vi.fn(),
      listStorages: vi.fn(),
      createStorage: vi.fn(),
      updateStorage: vi.fn(),
      deleteStorage: vi.fn(),
      listScheduledTasks: vi.fn(),
      createScheduledTask: vi.fn(),
      updateScheduledTask: vi.fn(),
      deleteScheduledTask: vi.fn(),
      scheduledTaskExecutions: vi.fn(),
      deletePreview: vi.fn(),
    },
    databases: {
      get: overrides.databasesGet ?? vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      control: vi.fn(),
      listEnvs: vi.fn(),
      upsertEnvsBulk: vi.fn(),
      deleteEnv: vi.fn(),
      listStorages: vi.fn(),
      createStorage: vi.fn(),
      updateStorage: vi.fn(),
      deleteStorage: vi.fn(),
      listBackups: vi.fn(),
      createBackup: vi.fn(),
      updateBackup: vi.fn(),
      deleteBackup: vi.fn(),
      backupExecutions: vi.fn(),
      deleteBackupExecution: vi.fn(),
    },
    services: {
      get: overrides.servicesGet ?? vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      control: vi.fn(),
      listEnvs: vi.fn(),
      upsertEnvsBulk: vi.fn(),
      deleteEnv: vi.fn(),
      listStorages: vi.fn(),
      createStorage: vi.fn(),
      updateStorage: vi.fn(),
      deleteStorage: vi.fn(),
      listScheduledTasks: vi.fn(),
      createScheduledTask: vi.fn(),
      updateScheduledTask: vi.fn(),
      deleteScheduledTask: vi.fn(),
      scheduledTaskExecutions: vi.fn(),
    },
  } as unknown as CoolifyApiClient;
}

const COOLIFY_HOST_UUID = "coolify0host";
const REMOTE_SERVER_UUID = "remoteABC";
const REMOTE_SERVER_IP = "10.0.0.5";

const coolifyHostServerRecord = {
  uuid: COOLIFY_HOST_UUID,
  name: "coolify-host",
  ip: "127.0.0.1",
  user: "root",
};

const remoteServerRecord = {
  uuid: REMOTE_SERVER_UUID,
  name: "remote-server",
  ip: REMOTE_SERVER_IP,
  user: "root",
};

/** Helper: an api stub where servers.list and servers.get return from the given array. */
function apiWith(servers: Record<string, unknown>[]) {
  return {
    servers: {
      list: vi.fn(async () => servers),
      get: vi.fn(async (u: string) => {
        const found = servers.find((s) => s.uuid === u);
        if (!found) return Promise.reject(Object.assign(new Error("not_found"), { kind: "not_found" }));
        return found;
      }),
    },
  } as any;
}

describe("ServerResolver", () => {
  describe("resolveByResource() for applications", () => {
    it("returns isCoolifyHost=true when resource server_uuid matches coolify host (after resolveControlHost)", async () => {
      const api = makeApi({
        applicationsGet: async (_uuid) => ({
          uuid: "app001",
          server_uuid: COOLIFY_HOST_UUID,
        }),
        serversGet: async (_uuid) => coolifyHostServerRecord,
        serversList: async () => [coolifyHostServerRecord],
      });

      const resolver = new ServerResolver(api, { hostServer: COOLIFY_HOST_UUID });
      await resolver.resolveControlHost();
      const target = await resolver.resolveByResource("applications", "app001");

      expect(target.serverUuid).toBe(COOLIFY_HOST_UUID);
      expect(target.isCoolifyHost).toBe(true);
      expect(target.dockerHost).toBeUndefined();
    });

    it("returns isCoolifyHost=false with dockerHost for a remote server", async () => {
      const api = makeApi({
        applicationsGet: async (_uuid) => ({
          uuid: "app002",
          server_uuid: REMOTE_SERVER_UUID,
        }),
        serversGet: async (_uuid) => remoteServerRecord,
      });

      const resolver = new ServerResolver(api);
      const target = await resolver.resolveByResource("applications", "app002");

      expect(target.serverUuid).toBe(REMOTE_SERVER_UUID);
      expect(target.isCoolifyHost).toBe(false);
      expect(target.dockerHost).toBe(`ssh://root@${REMOTE_SERVER_IP}`);
    });
  });

  describe("resolveByResource() for databases", () => {
    it("fetches from databases API when kind is 'databases'", async () => {
      const api = makeApi({
        databasesGet: async (_uuid) => ({
          uuid: "db001",
          server_uuid: COOLIFY_HOST_UUID,
        }),
        serversGet: async (_uuid) => coolifyHostServerRecord,
        serversList: async () => [coolifyHostServerRecord],
      });

      const resolver = new ServerResolver(api, { hostServer: COOLIFY_HOST_UUID });
      await resolver.resolveControlHost();
      const target = await resolver.resolveByResource("databases", "db001");

      expect(target.serverUuid).toBe(COOLIFY_HOST_UUID);
      expect(target.isCoolifyHost).toBe(true);
    });
  });

  describe("resolveByResource() for services", () => {
    it("fetches from services API when kind is 'services'", async () => {
      const api = makeApi({
        servicesGet: async (_uuid) => ({
          uuid: "svc001",
          server_uuid: REMOTE_SERVER_UUID,
        }),
        serversGet: async (_uuid) => remoteServerRecord,
      });

      const resolver = new ServerResolver(api);
      const target = await resolver.resolveByResource("services", "svc001");

      expect(target.serverUuid).toBe(REMOTE_SERVER_UUID);
      expect(target.isCoolifyHost).toBe(false);
      expect(target.dockerHost).toBe(`ssh://root@${REMOTE_SERVER_IP}`);
    });
  });

  describe("resolveByResource() caching", () => {
    it("calls the API only once for a repeated resource lookup", async () => {
      const appGet = vi.fn(async (_uuid: string) => ({
        uuid: "app003",
        server_uuid: COOLIFY_HOST_UUID,
      }));
      const serverGet = vi.fn(async (_uuid: string) => coolifyHostServerRecord);

      const api = makeApi({ applicationsGet: appGet, serversGet: serverGet });
      const resolver = new ServerResolver(api);

      await resolver.resolveByResource("applications", "app003");
      await resolver.resolveByResource("applications", "app003");

      expect(appGet).toHaveBeenCalledTimes(1);
      expect(serverGet).toHaveBeenCalledTimes(1);
    });
  });

  describe("_buildTarget() input validation (R2-hostops-quoting)", () => {
    it("rejects a poisoned IP with shell metacharacters (command injection via ip field)", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => ({
          uuid: REMOTE_SERVER_UUID,
          name: "evil-server",
          ip: "1.2.3.4 $(touch /tmp/x)",
          user: "root",
        }),
      });

      const resolver = new ServerResolver(api);
      await expect(resolver.resolveByServer(REMOTE_SERVER_UUID)).rejects.toMatchObject({
        kind: "invalid_input",
      });
    });

    it("rejects an IP with semicolon (stacked command injection)", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => ({
          uuid: REMOTE_SERVER_UUID,
          ip: "1.2.3.4; rm -rf /",
          user: "root",
        }),
      });

      const resolver = new ServerResolver(api);
      await expect(resolver.resolveByServer(REMOTE_SERVER_UUID)).rejects.toMatchObject({
        kind: "invalid_input",
      });
    });

    it("rejects a user field with shell metacharacters", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => ({
          uuid: REMOTE_SERVER_UUID,
          ip: "10.0.0.5",
          user: "root$(id)",
        }),
      });

      const resolver = new ServerResolver(api);
      await expect(resolver.resolveByServer(REMOTE_SERVER_UUID)).rejects.toMatchObject({
        kind: "invalid_input",
      });
    });

    it("rejects a user field with spaces (word-splitting injection)", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => ({
          uuid: REMOTE_SERVER_UUID,
          ip: "10.0.0.5",
          user: "root evil",
        }),
      });

      const resolver = new ServerResolver(api);
      await expect(resolver.resolveByServer(REMOTE_SERVER_UUID)).rejects.toMatchObject({
        kind: "invalid_input",
      });
    });

    it("accepts a clean IPv4 address and a normal unix username", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => ({
          uuid: REMOTE_SERVER_UUID,
          ip: "10.0.0.5",
          user: "deploy_user",
        }),
      });

      const resolver = new ServerResolver(api);
      const target = await resolver.resolveByServer(REMOTE_SERVER_UUID);
      expect(target.dockerHost).toBe("ssh://deploy_user@10.0.0.5");
    });

    it("accepts a hostname with hyphens and dots", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => ({
          uuid: REMOTE_SERVER_UUID,
          ip: "my-server.example.com",
          user: "root",
        }),
      });

      const resolver = new ServerResolver(api);
      const target = await resolver.resolveByServer(REMOTE_SERVER_UUID);
      expect(target.dockerHost).toBe("ssh://root@my-server.example.com");
    });

    it("accepts an IPv6 address in bracket notation", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => ({
          uuid: REMOTE_SERVER_UUID,
          ip: "[::1]",
          user: "root",
        }),
      });

      const resolver = new ServerResolver(api);
      const target = await resolver.resolveByServer(REMOTE_SERVER_UUID);
      expect(target.dockerHost).toBe("ssh://root@[::1]");
    });
  });

  describe("resolveByServer()", () => {
    it("resolves by server UUID and returns isCoolifyHost=true after resolveControlHost", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => coolifyHostServerRecord,
        serversList: async () => [coolifyHostServerRecord],
      });

      const resolver = new ServerResolver(api, { hostServer: COOLIFY_HOST_UUID });
      await resolver.resolveControlHost();
      const target = await resolver.resolveByServer(COOLIFY_HOST_UUID);

      expect(target.serverUuid).toBe(COOLIFY_HOST_UUID);
      expect(target.isCoolifyHost).toBe(true);
    });

    it("resolves by server UUID and returns isCoolifyHost=false for remote servers", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => remoteServerRecord,
      });

      const resolver = new ServerResolver(api);
      const target = await resolver.resolveByServer(REMOTE_SERVER_UUID);

      expect(target.serverUuid).toBe(REMOTE_SERVER_UUID);
      expect(target.isCoolifyHost).toBe(false);
      expect(target.dockerHost).toBe(`ssh://root@${REMOTE_SERVER_IP}`);
    });

    it("falls back to listing servers and matching by name when UUID lookup returns not_found", async () => {
      const serverGetFn = vi.fn(async (uuid: string) => {
        if (uuid === "my-server-name") {
          throw Object.assign(new Error("not found"), { kind: "not_found" });
        }
        return remoteServerRecord;
      });
      const serverListFn = vi.fn(async () => [
        { ...remoteServerRecord, name: "my-server-name" },
      ]);

      const api = {
        ...makeApi({ serversGet: serverGetFn }),
        servers: {
          ...makeApi({}).servers,
          get: serverGetFn,
          list: serverListFn,
        },
      } as unknown as CoolifyApiClient;

      const resolver = new ServerResolver(api);
      const target = await resolver.resolveByServer("my-server-name");

      expect(target.serverUuid).toBe(REMOTE_SERVER_UUID);
      expect(target.isCoolifyHost).toBe(false);
    });

    it("throws when no server matches by name either", async () => {
      const serverGetFn = vi.fn(async (_uuid: string) => {
        throw Object.assign(new Error("not found"), { kind: "not_found" });
      });
      const serverListFn = vi.fn(async () => [
        { uuid: "other", name: "other-server", ip: "5.5.5.5", user: "root" },
      ]);

      const api = {
        ...makeApi({ serversGet: serverGetFn }),
        servers: {
          ...makeApi({}).servers,
          get: serverGetFn,
          list: serverListFn,
        },
      } as unknown as CoolifyApiClient;

      const resolver = new ServerResolver(api);
      await expect(resolver.resolveByServer("nonexistent-server")).rejects.toThrow();
    });

    it("no hint: isCoolifyHost=false for all servers", async () => {
      const api = makeApi({
        serversGet: async (_uuid) => coolifyHostServerRecord,
      });

      const resolver = new ServerResolver(api); // no hint
      const target = await resolver.resolveByServer(COOLIFY_HOST_UUID);

      expect(target.isCoolifyHost).toBe(false);
    });
  });
});

describe("resolveControlHost", () => {
  it("matches the server whose ip equals the baseUrl host", async () => {
    const r = new ServerResolver(apiWith([
      { uuid: "s1", ip: "10.0.0.9", user: "root", port: 22 },
      { uuid: "s2", ip: "203.0.113.5", user: "deploy", port: 2222 },
    ]), { baseUrl: "https://203.0.113.5" });
    const ch = await r.resolveControlHost();
    expect(ch).toMatchObject({ serverUuid: "s2", host: "203.0.113.5", user: "deploy", port: 2222 });
  });
  it("uses ssh.hostServer override when provided", async () => {
    const r = new ServerResolver(apiWith([{ uuid: "primary", ip: "10.1.1.1", user: "root", port: 22 }]), { baseUrl: "https://coolify.example.com", hostServer: "primary" });
    expect((await r.resolveControlHost()).host).toBe("10.1.1.1");
  });
  it("throws invalid_input instructing ssh.hostServer when no server matches the baseUrl host", async () => {
    const r = new ServerResolver(apiWith([{ uuid: "s1", ip: "10.0.0.9", user: "root" }]), { baseUrl: "https://coolify.example.com" });
    await expect(r.resolveControlHost()).rejects.toMatchObject({ kind: "invalid_input" });
  });

  // Non-routable control-host ip (e.g. host.docker.internal on a standard self-hosted
  // install) → substitute the operator-configured baseUrl host. The server must still
  // be selected by an explicit ssh.hostServer or an exact match (anti-hijack preserved).
  it("substitutes the baseUrl host when the resolved control-host ip is host.docker.internal (via ssh.hostServer)", async () => {
    const r = new ServerResolver(
      apiWith([{ uuid: "primary", ip: "host.docker.internal", user: "root", port: 22 }]),
      { baseUrl: "https://coolify.jimrarras.space", hostServer: "primary" },
    );
    const ch = await r.resolveControlHost();
    expect(ch.serverUuid).toBe("primary");
    expect(ch.host).toBe("coolify.jimrarras.space");
    expect(ch.user).toBe("root");
  });

  it("substitutes the baseUrl host for a loopback ip on an exact name match", async () => {
    const r = new ServerResolver(
      apiWith([{ uuid: "primary", ip: "127.0.0.1", name: "coolify.example.com", user: "root" }]),
      { baseUrl: "https://coolify.example.com" },
    );
    expect((await r.resolveControlHost()).host).toBe("coolify.example.com");
  });

  it("keeps a routable control-host ip unchanged", async () => {
    const r = new ServerResolver(
      apiWith([{ uuid: "primary", ip: "203.0.113.5", user: "root", port: 22 }]),
      { baseUrl: "https://203.0.113.5" },
    );
    expect((await r.resolveControlHost()).host).toBe("203.0.113.5");
  });
});
