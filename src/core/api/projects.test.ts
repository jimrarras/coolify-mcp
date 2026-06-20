import { describe, it, expect, vi } from "vitest";
import { ProjectsApi } from "./projects.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("ProjectsApi.list", () => {
  it("calls GET /projects", async () => {
    const client = makeClient(200, [{ uuid: "proj1" }]);
    const api = new ProjectsApi(client);
    const result = await api.list();
    expect(result).toEqual([{ uuid: "proj1" }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects");
    expect(url).not.toMatch(/\/projects\/.+/);
  });
});

describe("ProjectsApi.get", () => {
  it("calls GET /projects/{uuid}", async () => {
    const client = makeClient(200, { uuid: "proj1", name: "My Project" });
    const api = new ProjectsApi(client);
    await api.get("proj1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/proj1");
  });
});

describe("ProjectsApi.create", () => {
  it("calls POST /projects", async () => {
    const client = makeClient(200, { uuid: "proj2" });
    const api = new ProjectsApi(client);
    const result = await api.create({ name: "New Project" });
    expect(result).toEqual({ uuid: "proj2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects");
    expect(init.method).toBe("POST");
  });
});

describe("ProjectsApi.update", () => {
  it("calls PATCH /projects/{uuid}", async () => {
    const client = makeClient(200, { uuid: "proj1", name: "Renamed" });
    const api = new ProjectsApi(client);
    await api.update("proj1", { name: "Renamed" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/proj1");
    expect(init.method).toBe("PATCH");
  });
});

describe("ProjectsApi.delete", () => {
  it("calls DELETE /projects/{uuid}", async () => {
    const client = makeClient(200, { message: "deleted" });
    const api = new ProjectsApi(client);
    await api.delete("proj1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/proj1");
    expect(init.method).toBe("DELETE");
  });
});

describe("ProjectsApi environment methods", () => {
  it("listEnvironments calls GET /projects/{uuid}/environments", async () => {
    const client = makeClient(200, [{ name: "production" }]);
    const api = new ProjectsApi(client);
    await api.listEnvironments("proj1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/proj1/environments");
  });

  it("createEnvironment calls POST /projects/{uuid}/environments", async () => {
    const client = makeClient(200, { name: "staging" });
    const api = new ProjectsApi(client);
    await api.createEnvironment("proj1", { name: "staging" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/proj1/environments");
    expect(init.method).toBe("POST");
  });

  it("getEnvironment calls GET /projects/{uuid}/environments/{nameOrUuid}", async () => {
    const client = makeClient(200, { name: "production", uuid: "env1" });
    const api = new ProjectsApi(client);
    await api.getEnvironment("proj1", "production");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/proj1/environments/production");
  });

  it("deleteEnvironment calls DELETE /projects/{uuid}/environments/{nameOrUuid}", async () => {
    const client = makeClient(200, {});
    const api = new ProjectsApi(client);
    await api.deleteEnvironment("proj1", "staging");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/proj1/environments/staging");
    expect(init.method).toBe("DELETE");
  });
});

// R8 — REST path traversal regression tests
describe("ProjectsApi path traversal hardening", () => {
  it("getEnvironment encodes slashes in nameOrUuid so the URL contains %2F and does not resolve to /servers/...", async () => {
    const client = makeClient(200, { name: "x" });
    const api = new ProjectsApi(client);
    await api.getEnvironment("proj1", "../../servers/x/disable");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    // Must contain the percent-encoded slash
    expect(url).toContain("%2F");
    // Must NOT allow traversal to /servers/
    expect(url).not.toMatch(/\/servers\//);
    // The literal encoded payload must appear in the URL
    expect(url).toContain("..%2F..%2Fservers%2Fx%2Fdisable");
  });

  it("deleteEnvironment encodes slashes in nameOrUuid preventing path traversal", async () => {
    const client = makeClient(200, {});
    const api = new ProjectsApi(client);
    await api.deleteEnvironment("proj1", "../../admin/disable");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("%2F");
    expect(url).not.toMatch(/\/admin\//);
    expect(init.method).toBe("DELETE");
  });

  it("get encodes slashes in project uuid preventing path traversal", async () => {
    const client = makeClient(200, {});
    const api = new ProjectsApi(client);
    await api.get("proj1/../servers");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("%2F");
    expect(url).not.toMatch(/\/servers(?:\/|$)/);
  });
});
