// src/core/api/services.test.ts
import { describe, it, expect, vi } from "vitest";
import { ServicesApi } from "./services.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("ServicesApi.list", () => {
  it("calls GET /services", async () => {
    const client = makeClient(200, [{ uuid: "svc1" }]);
    const api = new ServicesApi(client);
    const result = await api.list();
    expect(result).toEqual([{ uuid: "svc1" }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services");
    expect(url).not.toMatch(/\/services\/.+/);
  });
});

describe("ServicesApi.get", () => {
  it("calls GET /services/{uuid}", async () => {
    const client = makeClient(200, { uuid: "svc1" });
    const api = new ServicesApi(client);
    await api.get("svc1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1");
  });
});

describe("ServicesApi.create", () => {
  it("calls POST /services", async () => {
    const client = makeClient(200, { uuid: "svc2" });
    const api = new ServicesApi(client);
    const result = await api.create({ type: "plausible-analytics" });
    expect(result).toEqual({ uuid: "svc2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services");
    expect(init.method).toBe("POST");
  });
});

describe("ServicesApi.update", () => {
  it("calls PATCH /services/{uuid}", async () => {
    const client = makeClient(200, { uuid: "svc1" });
    const api = new ServicesApi(client);
    await api.update("svc1", { name: "updated" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1");
    expect(init.method).toBe("PATCH");
  });
});

describe("ServicesApi.delete", () => {
  it("calls DELETE /services/{uuid}", async () => {
    const client = makeClient(200, { message: "deleted" });
    const api = new ServicesApi(client);
    await api.delete("svc1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1");
    expect(init.method).toBe("DELETE");
  });
});

describe("ServicesApi.control", () => {
  it("calls POST /services/{uuid}/restart", async () => {
    const client = makeClient(200, { message: "restarting" });
    const api = new ServicesApi(client);
    await api.control("svc1", "restart");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/restart");
    expect(init.method).toBe("POST");
  });
});

describe("ServicesApi env methods", () => {
  it("listEnvs calls GET /services/{uuid}/envs", async () => {
    const client = makeClient(200, []);
    const api = new ServicesApi(client);
    await api.listEnvs("svc1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/envs");
  });

  it("upsertEnvsBulk calls PATCH /services/{uuid}/envs/bulk", async () => {
    const client = makeClient(200, {});
    const api = new ServicesApi(client);
    await api.upsertEnvsBulk("svc1", [{ key: "K", value: "V" }]);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/envs/bulk");
    expect(init.method).toBe("PATCH");
  });

  it("deleteEnv calls DELETE /services/{uuid}/envs/{env_uuid}", async () => {
    const client = makeClient(200, {});
    const api = new ServicesApi(client);
    await api.deleteEnv("svc1", "env1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/envs/env1");
    expect(init.method).toBe("DELETE");
  });
});

describe("ServicesApi storage methods", () => {
  it("listStorages calls GET /services/{uuid}/storages", async () => {
    const client = makeClient(200, []);
    const api = new ServicesApi(client);
    await api.listStorages("svc1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/storages");
  });

  it("createStorage calls POST /services/{uuid}/storages", async () => {
    const client = makeClient(200, {});
    const api = new ServicesApi(client);
    await api.createStorage("svc1", { name: "vol" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/storages");
    expect(init.method).toBe("POST");
  });

  it("updateStorage calls PATCH /services/{uuid}/storages/{storageUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ServicesApi(client);
    await api.updateStorage("svc1", "st1", { name: "vol2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/storages/st1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteStorage calls DELETE /services/{uuid}/storages/{storageUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ServicesApi(client);
    await api.deleteStorage("svc1", "st1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/storages/st1");
    expect(init.method).toBe("DELETE");
  });
});

describe("ServicesApi scheduled task methods", () => {
  it("listScheduledTasks calls GET /services/{uuid}/scheduled-tasks", async () => {
    const client = makeClient(200, []);
    const api = new ServicesApi(client);
    await api.listScheduledTasks("svc1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/scheduled-tasks");
  });

  it("createScheduledTask calls POST /services/{uuid}/scheduled-tasks", async () => {
    const client = makeClient(200, { uuid: "t1" });
    const api = new ServicesApi(client);
    await api.createScheduledTask("svc1", { name: "cleanup" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/scheduled-tasks");
    expect(init.method).toBe("POST");
  });

  it("updateScheduledTask calls PATCH /services/{uuid}/scheduled-tasks/{taskUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ServicesApi(client);
    await api.updateScheduledTask("svc1", "t1", { name: "cleanup2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/scheduled-tasks/t1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteScheduledTask calls DELETE /services/{uuid}/scheduled-tasks/{taskUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ServicesApi(client);
    await api.deleteScheduledTask("svc1", "t1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/scheduled-tasks/t1");
    expect(init.method).toBe("DELETE");
  });

  it("scheduledTaskExecutions calls GET /services/{uuid}/scheduled-tasks/{taskUuid}/executions", async () => {
    const client = makeClient(200, []);
    const api = new ServicesApi(client);
    await api.scheduledTaskExecutions("svc1", "t1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/services/svc1/scheduled-tasks/t1/executions");
  });
});
