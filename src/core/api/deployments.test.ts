import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeploymentsApi } from "./deployments.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown, headers: Record<string, string> = {}): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("DeploymentsApi.trigger", () => {
  it("calls GET /deploy with uuid query param", async () => {
    const body = [{ message: "ok", resource_uuid: "app1", deployment_uuid: "dep1" }];
    const client = makeClient(200, body);
    const api = new DeploymentsApi(client);
    const result = await api.trigger({ uuid: "app1", force: true });
    expect(result).toEqual(body);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/deploy");
    expect(url).toContain("uuid=app1");
    expect(url).toContain("force=true");
  });

  it("calls GET /deploy with tag query param", async () => {
    const body = [{ message: "ok", resource_uuid: "app2" }];
    const client = makeClient(200, body);
    const api = new DeploymentsApi(client);
    await api.trigger({ tag: "production" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("tag=production");
  });

  // Regression (found in live bring-up): /deploy returns { deployments: [...] },
  // NOT a bare array. trigger() must unwrap it so deploy/deploy_watch get an array.
  it("unwraps the { deployments: [...] } wrapper from POST /deploy", async () => {
    const body = { deployments: [{ message: "queued", resource_uuid: "app1", deployment_uuid: "dep1" }] };
    const client = makeClient(200, body);
    const result = await new DeploymentsApi(client).trigger({ uuid: "app1" });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(body.deployments);
  });

  it("tolerates a bare-array /deploy response (older/mocked)", async () => {
    const body = [{ message: "queued", resource_uuid: "app1", deployment_uuid: "dep1" }];
    const client = makeClient(200, body);
    const result = await new DeploymentsApi(client).trigger({ uuid: "app1" });
    expect(result).toEqual(body);
  });

  // /deploy is a side-effecting GET: a transient 5xx after Coolify accepted the
  // deploy must NOT be retried, or the client would queue duplicate deployments.
  it("does NOT retry GET /deploy on a transient 5xx", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () =>
      (calls++, new Response(JSON.stringify({ message: "bad gateway" }), { status: 502, headers: { "content-type": "application/json" } })),
    ) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(CFG, { maxAttempts: 4, baseDelayMs: 0, sleep: async () => {} });
    await expect(new DeploymentsApi(client).trigger({ uuid: "app1" })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("DeploymentsApi.listActive", () => {
  it("calls GET /deployments", async () => {
    const body = [{ id: 1, deployment_uuid: "dep1", status: "running" }];
    const client = makeClient(200, body);
    const api = new DeploymentsApi(client);
    const result = await api.listActive();
    expect(result).toEqual(body);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/deployments");
    expect(url).not.toContain("applications");
  });

  it("unwraps a { deployments: [...] } wrapper if Coolify wraps the response", async () => {
    const body = { deployments: [{ id: 1, deployment_uuid: "dep1", status: "running" }] };
    const client = makeClient(200, body);
    const result = await new DeploymentsApi(client).listActive();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(body.deployments);
  });

  it("returns [] for an unexpected (non-array, non-wrapper) body", async () => {
    const client = makeClient(200, { error: "nope" });
    const result = await new DeploymentsApi(client).listActive();
    expect(result).toEqual([]);
  });
});

describe("DeploymentsApi.history", () => {
  it("calls GET /deployments/applications/{uuid} with skip/take", async () => {
    const body = [{ id: 2, deployment_uuid: "dep2", status: "finished" }];
    const client = makeClient(200, body);
    const api = new DeploymentsApi(client);
    await api.history("appUuid1", { skip: 0, take: 10 });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/deployments/applications/appUuid1");
    expect(url).toContain("skip=0");
    expect(url).toContain("take=10");
  });

  it("calls GET /deployments/applications/{uuid} without pagination when opts omitted", async () => {
    const client = makeClient(200, []);
    const api = new DeploymentsApi(client);
    await api.history("appUuid2");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("skip=");
    expect(url).not.toContain("take=");
  });

  // Regression (found in live bring-up): the endpoint returns { count, deployments:[...] },
  // NOT a bare array (the v1 spec mistyped it as Application[]).
  it("returns the { count, deployments } wrapper", async () => {
    const body = {
      count: 2,
      deployments: [
        { id: 1, deployment_uuid: "d1", status: "finished" },
        { id: 2, deployment_uuid: "d2", status: "failed" },
      ],
    };
    const client = makeClient(200, body);
    const result = await new DeploymentsApi(client).history("app1");
    expect(result.count).toBe(2);
    expect(result.deployments).toHaveLength(2);
    expect(result.deployments[0]!.deployment_uuid).toBe("d1");
  });

  it("normalizes a bare-array history response into the wrapper", async () => {
    const body = [{ id: 1, deployment_uuid: "d1", status: "finished" }];
    const client = makeClient(200, body);
    const result = await new DeploymentsApi(client).history("app1");
    expect(result.count).toBe(1);
    expect(result.deployments).toEqual(body);
  });
});

describe("DeploymentsApi.get", () => {
  it("calls GET /deployments/{uuid}", async () => {
    const body = { id: 3, deployment_uuid: "dep3", status: "finished" };
    const client = makeClient(200, body);
    const api = new DeploymentsApi(client);
    const result = await api.get("dep3");
    expect(result).toEqual(body);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/deployments/dep3");
  });
});

describe("DeploymentsApi.cancel", () => {
  it("calls POST /deployments/{uuid}/cancel", async () => {
    const body = { deployment_uuid: "dep4", status: "cancelled" };
    const client = makeClient(200, body);
    const api = new DeploymentsApi(client);
    const result = await api.cancel("dep4");
    expect(result).toEqual(body);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/deployments/dep4/cancel");
    expect(init.method).toBe("POST");
  });
});
