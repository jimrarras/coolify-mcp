import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApplicationsApi } from "./applications.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("ApplicationsApi.list", () => {
  it("calls GET /applications", async () => {
    const body = [{ uuid: "app1" }];
    const client = makeClient(200, body);
    const api = new ApplicationsApi(client);
    const result = await api.list();
    expect(result).toEqual(body);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications");
    expect(url).not.toMatch(/\/applications\/.+/);
  });
});

describe("ApplicationsApi.get", () => {
  it("calls GET /applications/{uuid}", async () => {
    const body = { uuid: "app1", name: "My App" };
    const client = makeClient(200, body);
    const api = new ApplicationsApi(client);
    const result = await api.get("app1");
    expect(result).toEqual(body);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1");
  });
});

describe("ApplicationsApi create variants", () => {
  it("createPublic calls POST /applications/public", async () => {
    const client = makeClient(200, { uuid: "new1" });
    const api = new ApplicationsApi(client);
    await api.createPublic({ name: "test" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/public");
    expect(init.method).toBe("POST");
  });

  it("createPrivateGithubApp calls POST /applications/private-github-app", async () => {
    const client = makeClient(200, { uuid: "new2" });
    const api = new ApplicationsApi(client);
    await api.createPrivateGithubApp({ name: "test" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/private-github-app");
  });

  it("createPrivateDeployKey calls POST /applications/private-deploy-key", async () => {
    const client = makeClient(200, { uuid: "new3" });
    const api = new ApplicationsApi(client);
    await api.createPrivateDeployKey({ name: "test" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/private-deploy-key");
  });

  it("createDockerfile calls POST /applications/dockerfile", async () => {
    const client = makeClient(200, { uuid: "new4" });
    const api = new ApplicationsApi(client);
    await api.createDockerfile({ name: "test" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/dockerfile");
  });

  it("createDockerimage calls POST /applications/dockerimage", async () => {
    const client = makeClient(200, { uuid: "new5" });
    const api = new ApplicationsApi(client);
    await api.createDockerimage({ name: "test" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/dockerimage");
  });
});

describe("ApplicationsApi.update", () => {
  it("calls PATCH /applications/{uuid}", async () => {
    const client = makeClient(200, { uuid: "app1", name: "updated" });
    const api = new ApplicationsApi(client);
    await api.update("app1", { name: "updated" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1");
    expect(init.method).toBe("PATCH");
  });
});

describe("ApplicationsApi.delete", () => {
  it("calls DELETE /applications/{uuid}", async () => {
    const client = makeClient(200, { message: "deleted" });
    const api = new ApplicationsApi(client);
    await api.delete("app1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1");
    expect(init.method).toBe("DELETE");
  });
});

describe("ApplicationsApi.control", () => {
  it("calls POST /applications/{uuid}/start", async () => {
    const client = makeClient(200, { message: "started" });
    const api = new ApplicationsApi(client);
    await api.control("app1", "start");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/start");
    expect(init.method).toBe("POST");
  });

  it("calls POST /applications/{uuid}/restart with instant_deploy", async () => {
    const client = makeClient(200, { message: "restarting", deployment_uuid: "dep1" });
    const api = new ApplicationsApi(client);
    const result = await api.control("app1", "restart", { instant_deploy: true });
    expect(result).toMatchObject({ message: "restarting" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/restart");
    expect(url).toContain("instant_deploy=true");
  });
});

describe("ApplicationsApi.logs", () => {
  it("calls GET /applications/{uuid}/logs with lines param", async () => {
    const client = makeClient(200, { logs: "line1\nline2" });
    const api = new ApplicationsApi(client);
    const result = await api.logs("app1", 100);
    expect(result).toEqual({ logs: "line1\nline2" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/logs");
    expect(url).toContain("lines=100");
  });
});

describe("ApplicationsApi env methods", () => {
  it("listEnvs calls GET /applications/{uuid}/envs", async () => {
    const body = [{ uuid: "env1", key: "FOO", value: "bar" }];
    const client = makeClient(200, body);
    const api = new ApplicationsApi(client);
    const result = await api.listEnvs("app1");
    expect(result).toEqual(body);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/envs");
  });

  it("upsertEnvsBulk calls PATCH /applications/{uuid}/envs/bulk", async () => {
    const client = makeClient(200, { message: "updated" });
    const api = new ApplicationsApi(client);
    await api.upsertEnvsBulk("app1", [{ key: "FOO", value: "bar" }]);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/envs/bulk");
    expect(init.method).toBe("PATCH");
  });

  it("deleteEnv calls DELETE /applications/{uuid}/envs/{env_uuid}", async () => {
    const client = makeClient(200, { message: "deleted" });
    const api = new ApplicationsApi(client);
    await api.deleteEnv("app1", "env1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/envs/env1");
    expect(init.method).toBe("DELETE");
  });
});

describe("ApplicationsApi storage methods", () => {
  it("listStorages calls GET /applications/{uuid}/storages", async () => {
    const client = makeClient(200, [{ uuid: "st1" }]);
    const api = new ApplicationsApi(client);
    await api.listStorages("app1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/storages");
  });

  it("createStorage calls POST /applications/{uuid}/storages", async () => {
    const client = makeClient(200, { uuid: "st2" });
    const api = new ApplicationsApi(client);
    await api.createStorage("app1", { name: "vol" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/storages");
    expect(init.method).toBe("POST");
  });

  it("updateStorage calls PATCH /applications/{uuid}/storages/{storageUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ApplicationsApi(client);
    await api.updateStorage("app1", "st1", { name: "vol2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/storages/st1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteStorage calls DELETE /applications/{uuid}/storages/{storageUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ApplicationsApi(client);
    await api.deleteStorage("app1", "st1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/storages/st1");
    expect(init.method).toBe("DELETE");
  });
});

describe("ApplicationsApi scheduled task methods", () => {
  it("listScheduledTasks calls GET /applications/{uuid}/scheduled-tasks", async () => {
    const client = makeClient(200, [{ uuid: "task1" }]);
    const api = new ApplicationsApi(client);
    await api.listScheduledTasks("app1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/scheduled-tasks");
  });

  it("createScheduledTask calls POST /applications/{uuid}/scheduled-tasks", async () => {
    const client = makeClient(200, { uuid: "task2" });
    const api = new ApplicationsApi(client);
    await api.createScheduledTask("app1", { name: "my-task" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/scheduled-tasks");
    expect(init.method).toBe("POST");
  });

  it("updateScheduledTask calls PATCH /applications/{uuid}/scheduled-tasks/{taskUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ApplicationsApi(client);
    await api.updateScheduledTask("app1", "task1", { name: "updated" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/scheduled-tasks/task1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteScheduledTask calls DELETE /applications/{uuid}/scheduled-tasks/{taskUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ApplicationsApi(client);
    await api.deleteScheduledTask("app1", "task1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/scheduled-tasks/task1");
    expect(init.method).toBe("DELETE");
  });

  it("scheduledTaskExecutions calls GET /applications/{uuid}/scheduled-tasks/{taskUuid}/executions", async () => {
    const client = makeClient(200, [{ uuid: "exec1" }]);
    const api = new ApplicationsApi(client);
    await api.scheduledTaskExecutions("app1", "task1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/scheduled-tasks/task1/executions");
  });
});

describe("ApplicationsApi.deletePreview", () => {
  it("calls DELETE /applications/{uuid}/previews/{pr}", async () => {
    const client = makeClient(200, {});
    const api = new ApplicationsApi(client);
    await api.deletePreview("app1", 42);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/applications/app1/previews/42");
    expect(init.method).toBe("DELETE");
  });
});
