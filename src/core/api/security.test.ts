import { describe, it, expect, vi } from "vitest";
import { SecurityApi } from "./security.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("SecurityApi private key methods", () => {
  it("listKeys calls GET /security/keys", async () => {
    const client = makeClient(200, [{ uuid: "key1" }]);
    const api = new SecurityApi(client);
    await api.listKeys();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/security/keys");
    expect(url).not.toMatch(/\/keys\/.+/);
  });

  it("getKey calls GET /security/keys/{uuid}", async () => {
    const client = makeClient(200, { uuid: "key1", name: "my-key" });
    const api = new SecurityApi(client);
    await api.getKey("key1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/security/keys/key1");
  });

  it("createKey calls POST /security/keys", async () => {
    const client = makeClient(200, { uuid: "key2" });
    const api = new SecurityApi(client);
    const result = await api.createKey({ name: "new-key", private_key: "..." });
    expect(result).toEqual({ uuid: "key2" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/security/keys");
    expect(init.method).toBe("POST");
  });

  it("updateKey calls PATCH /security/keys with uuid in body", async () => {
    const client = makeClient(200, {});
    const api = new SecurityApi(client);
    await api.updateKey({ uuid: "key1", name: "renamed" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/security/keys");
    expect(url).not.toMatch(/\/keys\/.+/);
    expect(init.method).toBe("PATCH");
  });

  it("deleteKey calls DELETE /security/keys/{uuid}", async () => {
    const client = makeClient(200, {});
    const api = new SecurityApi(client);
    await api.deleteKey("key1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/security/keys/key1");
    expect(init.method).toBe("DELETE");
  });
});

describe("SecurityApi cloud token methods", () => {
  it("listCloudTokens calls GET /cloud-tokens", async () => {
    const client = makeClient(200, [{ uuid: "ct1" }]);
    const api = new SecurityApi(client);
    await api.listCloudTokens();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/cloud-tokens");
  });

  it("createCloudToken calls POST /cloud-tokens", async () => {
    const client = makeClient(200, { uuid: "ct2" });
    const api = new SecurityApi(client);
    await api.createCloudToken({ name: "my-token" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/cloud-tokens");
    expect(init.method).toBe("POST");
  });

  it("updateCloudToken calls PATCH /cloud-tokens/{uuid}", async () => {
    const client = makeClient(200, {});
    const api = new SecurityApi(client);
    await api.updateCloudToken("ct1", { name: "renamed" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/cloud-tokens/ct1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteCloudToken calls DELETE /cloud-tokens/{uuid}", async () => {
    const client = makeClient(200, {});
    const api = new SecurityApi(client);
    await api.deleteCloudToken("ct1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/cloud-tokens/ct1");
    expect(init.method).toBe("DELETE");
  });

  it("validateCloudToken calls POST /cloud-tokens/{uuid}/validate", async () => {
    const client = makeClient(200, { valid: true });
    const api = new SecurityApi(client);
    await api.validateCloudToken("ct1");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/cloud-tokens/ct1/validate");
    expect(init.method).toBe("POST");
  });
});
