import { describe, it, expect, vi } from "vitest";
import { TeamsApi } from "./teams.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("TeamsApi.list", () => {
  it("calls GET /teams", async () => {
    const client = makeClient(200, [{ id: 1, name: "My Team" }]);
    const api = new TeamsApi(client);
    const result = await api.list();
    expect(result).toEqual([{ id: 1, name: "My Team" }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/teams");
    expect(url).not.toMatch(/\/teams\/.+/);
  });
});

describe("TeamsApi.get", () => {
  it("calls GET /teams/{id}", async () => {
    const client = makeClient(200, { id: 1, name: "My Team" });
    const api = new TeamsApi(client);
    await api.get(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/teams/1");
  });
});

describe("TeamsApi.members", () => {
  it("calls GET /teams/{id}/members", async () => {
    const client = makeClient(200, [{ id: 5, name: "Alice" }]);
    const api = new TeamsApi(client);
    await api.members(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/teams/1/members");
  });
});

describe("TeamsApi.current", () => {
  it("calls GET /teams/current", async () => {
    const client = makeClient(200, { id: 2, name: "Current Team" });
    const api = new TeamsApi(client);
    await api.current();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/teams/current");
  });
});

describe("TeamsApi.currentMembers", () => {
  it("calls GET /teams/current/members", async () => {
    const client = makeClient(200, [{ id: 10, name: "Bob" }]);
    const api = new TeamsApi(client);
    await api.currentMembers();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/teams/current/members");
  });
});
