import { describe, it, expect, vi } from "vitest";
import { ServersApi } from "./servers.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("ServersApi.list", () => {
  it("calls GET /servers", async () => {
    const client = makeClient(200, [{ uuid: "srv1" }]);
    const api = new ServersApi(client);
    const result = await api.list();
    expect(result).toEqual([{ uuid: "srv1" }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers");
    expect(url).not.toMatch(/\/servers\/.+/);
  });
});

describe("ServersApi.get", () => {
  it("calls GET /servers/{uuid}", async () => {
    const client = makeClient(200, { uuid: "srv1", name: "My Server" });
    const api = new ServersApi(client);
    await api.get("srv1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers/srv1");
  });
});

describe("ServersApi.validate", () => {
  it("calls GET /servers/{uuid}/validate", async () => {
    const client = makeClient(200, { message: "ok" });
    const api = new ServersApi(client);
    await api.validate("srv1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers/srv1/validate");
  });
});

describe("ServersApi.resources", () => {
  it("calls GET /servers/{uuid}/resources", async () => {
    const client = makeClient(200, [{ uuid: "app1", type: "application" }]);
    const api = new ServersApi(client);
    await api.resources("srv1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers/srv1/resources");
  });
});

describe("ServersApi.domains", () => {
  it("calls GET /servers/{uuid}/domains", async () => {
    const client = makeClient(200, [{ domain: "example.com" }]);
    const api = new ServersApi(client);
    await api.domains("srv1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers/srv1/domains");
  });
});

describe("ServersApi.create", () => {
  it("calls POST /servers", async () => {
    const client = makeClient(200, { uuid: "srv2" });
    const api = new ServersApi(client);
    const result = await api.create({ name: "new-server", ip: "1.2.3.4" });
    expect(result).toEqual({ uuid: "srv2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers");
    expect(url).not.toContain("hetzner");
    expect(init.method).toBe("POST");
  });
});

describe("ServersApi.createHetzner", () => {
  it("calls POST /servers/hetzner", async () => {
    const client = makeClient(200, { uuid: "srv3" });
    const api = new ServersApi(client);
    await api.createHetzner({ name: "htz-server" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers/hetzner");
    expect(init.method).toBe("POST");
  });
});

describe("ServersApi.update", () => {
  it("calls PATCH /servers/{uuid}", async () => {
    const client = makeClient(200, { uuid: "srv1" });
    const api = new ServersApi(client);
    await api.update("srv1", { name: "renamed" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers/srv1");
    expect(init.method).toBe("PATCH");
  });
});

describe("ServersApi.delete", () => {
  it("calls DELETE /servers/{uuid}", async () => {
    const client = makeClient(200, { message: "deleted" });
    const api = new ServersApi(client);
    await api.delete("srv1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/servers/srv1");
    expect(init.method).toBe("DELETE");
  });
});
