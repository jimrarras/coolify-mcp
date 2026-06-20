// src/core/api/databases.test.ts
import { describe, it, expect, vi } from "vitest";
import { DatabasesApi } from "./databases.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("DatabasesApi.list", () => {
  it("calls GET /databases", async () => {
    const client = makeClient(200, [{ uuid: "db1" }]);
    const api = new DatabasesApi(client);
    const result = await api.list();
    expect(result).toEqual([{ uuid: "db1" }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases");
    expect(url).not.toMatch(/\/databases\/.+/);
  });
});

describe("DatabasesApi.get", () => {
  it("calls GET /databases/{uuid}", async () => {
    const client = makeClient(200, { uuid: "db1", type: "postgresql" });
    const api = new DatabasesApi(client);
    const result = await api.get("db1");
    expect(result).toMatchObject({ uuid: "db1" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1");
  });
});

describe("DatabasesApi.create", () => {
  it("calls POST /databases/{engine}", async () => {
    const client = makeClient(200, { uuid: "db2" });
    const api = new DatabasesApi(client);
    const result = await api.create("postgresql", { name: "mydb" });
    expect(result).toEqual({ uuid: "db2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/postgresql");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "mydb" });
  });
});

describe("DatabasesApi.update", () => {
  it("calls PATCH /databases/{uuid}", async () => {
    const client = makeClient(200, { uuid: "db1", name: "updated" });
    const api = new DatabasesApi(client);
    await api.update("db1", { name: "updated" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1");
    expect(init.method).toBe("PATCH");
  });
});

describe("DatabasesApi.delete", () => {
  it("calls DELETE /databases/{uuid}", async () => {
    const client = makeClient(200, { message: "deleted" });
    const api = new DatabasesApi(client);
    const result = await api.delete("db1");
    expect(result).toEqual({ message: "deleted" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1");
    expect(init.method).toBe("DELETE");
  });
});

describe("DatabasesApi.control", () => {
  it("calls POST /databases/{uuid}/stop", async () => {
    const client = makeClient(200, { message: "stopped" });
    const api = new DatabasesApi(client);
    await api.control("db1", "stop");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/stop");
    expect(init.method).toBe("POST");
  });
});

describe("DatabasesApi env methods", () => {
  it("listEnvs calls GET /databases/{uuid}/envs", async () => {
    const client = makeClient(200, [{ uuid: "e1", key: "DB_PASS", value: "secret" }]);
    const api = new DatabasesApi(client);
    await api.listEnvs("db1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/envs");
  });

  it("upsertEnvsBulk calls PATCH /databases/{uuid}/envs/bulk", async () => {
    const client = makeClient(200, {});
    const api = new DatabasesApi(client);
    await api.upsertEnvsBulk("db1", [{ key: "K", value: "V" }]);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/envs/bulk");
    expect(init.method).toBe("PATCH");
  });

  it("deleteEnv calls DELETE /databases/{uuid}/envs/{env_uuid}", async () => {
    const client = makeClient(200, {});
    const api = new DatabasesApi(client);
    await api.deleteEnv("db1", "env1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/envs/env1");
    expect(init.method).toBe("DELETE");
  });
});

describe("DatabasesApi storage methods", () => {
  it("listStorages calls GET /databases/{uuid}/storages", async () => {
    const client = makeClient(200, []);
    const api = new DatabasesApi(client);
    await api.listStorages("db1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/storages");
  });

  it("createStorage calls POST /databases/{uuid}/storages", async () => {
    const client = makeClient(200, { uuid: "st1" });
    const api = new DatabasesApi(client);
    await api.createStorage("db1", { name: "vol" });
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  it("updateStorage calls PATCH /databases/{uuid}/storages/{storageUuid}", async () => {
    const client = makeClient(200, {});
    const api = new DatabasesApi(client);
    await api.updateStorage("db1", "st1", { name: "vol2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/storages/st1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteStorage calls DELETE /databases/{uuid}/storages/{storageUuid}", async () => {
    const client = makeClient(200, {});
    const api = new DatabasesApi(client);
    await api.deleteStorage("db1", "st1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/storages/st1");
    expect(init.method).toBe("DELETE");
  });
});

describe("DatabasesApi backup methods", () => {
  it("listBackups calls GET /databases/{uuid}/backups", async () => {
    const client = makeClient(200, []);
    const api = new DatabasesApi(client);
    await api.listBackups("db1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/backups");
  });

  it("createBackup calls POST /databases/{uuid}/backups", async () => {
    const client = makeClient(200, { uuid: "bk1" });
    const api = new DatabasesApi(client);
    await api.createBackup("db1", { schedule: "daily" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/backups");
    expect(init.method).toBe("POST");
  });

  it("updateBackup calls PATCH /databases/{uuid}/backups/{sbUuid}", async () => {
    const client = makeClient(200, {});
    const api = new DatabasesApi(client);
    await api.updateBackup("db1", "bk1", { schedule: "weekly" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/backups/bk1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteBackup calls DELETE /databases/{uuid}/backups/{sbUuid}", async () => {
    const client = makeClient(200, {});
    const api = new DatabasesApi(client);
    await api.deleteBackup("db1", "bk1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/backups/bk1");
    expect(init.method).toBe("DELETE");
  });

  it("backupExecutions calls GET /databases/{uuid}/backups/{sbUuid}/executions", async () => {
    const client = makeClient(200, []);
    const api = new DatabasesApi(client);
    await api.backupExecutions("db1", "bk1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/backups/bk1/executions");
  });

  it("deleteBackupExecution calls DELETE /databases/{uuid}/backups/{sbUuid}/executions/{execUuid}", async () => {
    const client = makeClient(200, {});
    const api = new DatabasesApi(client);
    await api.deleteBackupExecution("db1", "bk1", "exec1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/databases/db1/backups/bk1/executions/exec1");
    expect(init.method).toBe("DELETE");
  });
});
