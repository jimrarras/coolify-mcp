import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoolifyApiClient } from "./client.js";
import { CoolifyError } from "../errors.js";
import type { ApiConfig } from "../config.js";

const BASE_CFG: ApiConfig = {
  baseUrl: "https://cool.example.com",
  token: "123|abc",
  extraHeaders: {},
};

function makeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "content-type": "application/json", ...headers },
      },
    ),
  ) as typeof globalThis.fetch;
}

describe("CoolifyApiClient.request", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes /api/v1, adds Authorization header, returns parsed JSON", async () => {
    const payload = { uuid: "abc123", name: "my-app" };
    globalThis.fetch = makeFetch(200, payload);
    const client = new CoolifyApiClient(BASE_CFG);
    const result = await client.request<typeof payload>("/applications/abc123");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cool.example.com/api/v1/applications/abc123");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer 123|abc");
    expect(result).toEqual(payload);
  });

  it("appends query string parameters, omitting undefined values", async () => {
    globalThis.fetch = makeFetch(200, []);
    const client = new CoolifyApiClient(BASE_CFG);
    await client.request("/applications", { query: { lines: 50, tag: undefined, force: false } });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("lines=50");
    expect(url).toContain("force=false");
    expect(url).not.toContain("tag=");
  });

  it("sends JSON body for POST", async () => {
    globalThis.fetch = makeFetch(200, { uuid: "new1" });
    const client = new CoolifyApiClient(BASE_CFG);
    await client.request("/applications/public", { method: "POST", body: { name: "test" } });
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "test" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("forwards extraHeaders", async () => {
    globalThis.fetch = makeFetch(200, {});
    const cfg: ApiConfig = { ...BASE_CFG, extraHeaders: { "X-Custom": "yes" } };
    const client = new CoolifyApiClient(cfg);
    await client.request("/foo");
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Custom"]).toBe("yes");
  });

  it("maps 401 to CoolifyError auth", async () => {
    globalThis.fetch = makeFetch(401, { message: "Unauthenticated" });
    const client = new CoolifyApiClient(BASE_CFG);
    await expect(client.request("/foo")).rejects.toSatisfy(
      (e: unknown) => e instanceof CoolifyError && (e as CoolifyError).kind === "auth" && (e as CoolifyError).status === 401,
    );
  });

  it("maps 403 to CoolifyError auth", async () => {
    globalThis.fetch = makeFetch(403, { message: "Forbidden" });
    const client = new CoolifyApiClient(BASE_CFG);
    await expect(client.request("/foo")).rejects.toSatisfy(
      (e: unknown) => e instanceof CoolifyError && (e as CoolifyError).kind === "auth",
    );
  });

  it("maps 404 to CoolifyError not_found", async () => {
    globalThis.fetch = makeFetch(404, { message: "Not found" });
    const client = new CoolifyApiClient(BASE_CFG);
    await expect(client.request("/foo")).rejects.toSatisfy(
      (e: unknown) => e instanceof CoolifyError && (e as CoolifyError).kind === "not_found",
    );
  });

  it("maps 422 to CoolifyError invalid_input", async () => {
    globalThis.fetch = makeFetch(422, { message: "Validation error" });
    const client = new CoolifyApiClient(BASE_CFG);
    await expect(client.request("/foo")).rejects.toSatisfy(
      (e: unknown) => e instanceof CoolifyError && (e as CoolifyError).kind === "invalid_input",
    );
  });

  it("maps 400 to CoolifyError invalid_input", async () => {
    globalThis.fetch = makeFetch(400, { message: "Bad request" });
    const client = new CoolifyApiClient(BASE_CFG);
    await expect(client.request("/foo")).rejects.toSatisfy(
      (e: unknown) => e instanceof CoolifyError && (e as CoolifyError).kind === "invalid_input",
    );
  });

  it("maps 500 to CoolifyError transient_exhausted after retries", async () => {
    // withRetry will retry maxAttempts times; mock always returns 500
    globalThis.fetch = makeFetch(500, { message: "Internal Server Error" });
    const client = new CoolifyApiClient(BASE_CFG, { maxAttempts: 2, baseDelayMs: 0, sleep: async () => {} });
    await expect(client.request("/foo")).rejects.toSatisfy(
      (e: unknown) => e instanceof CoolifyError && (e as CoolifyError).kind === "transient_exhausted",
    );
    // 2 attempts total
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("maps 429 with Retry-After to CoolifyError transient_exhausted with retryAfter", async () => {
    globalThis.fetch = makeFetch(429, { message: "Too Many Requests" }, { "Retry-After": "5" });
    const client = new CoolifyApiClient(BASE_CFG, { maxAttempts: 2, baseDelayMs: 0, sleep: async () => {} });
    await expect(client.request("/foo")).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CoolifyError &&
        (e as CoolifyError).kind === "transient_exhausted" &&
        (e as CoolifyError).retryAfter === 5,
    );
  });

  it("does NOT retry a GET marked idempotent:false (side-effecting /deploy) on a 5xx", async () => {
    // /deploy is a side-effecting GET; retrying it would queue duplicate deployments.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ message: "boom" }), { status: 503, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(BASE_CFG, { maxAttempts: 4, baseDelayMs: 0, sleep: async () => {} });
    await expect(client.request("/deploy", { idempotent: false })).rejects.toThrow(CoolifyError);
    expect(calls).toBe(1);
  });

  it("throws (not silently returns undefined) when a 2xx body is non-JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>proxy error</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(BASE_CFG);
    await expect(client.request("/applications/x")).rejects.toSatisfy(
      (e: unknown) => e instanceof CoolifyError && (e as CoolifyError).kind === "unknown",
    );
  });

  it("does NOT throw on an empty 2xx body (success with no content, e.g. a 204 DELETE)", async () => {
    // A successful empty-body response must not be reported as an error.
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(BASE_CFG);
    await expect(client.request("/applications/x", { method: "DELETE" })).resolves.toBe("");
  });

  it("returns the raw text body when allowNonJsonBody is set (version() path)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("4.1.2", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(BASE_CFG);
    const r = await client.request<string>("/version", { allowNonJsonBody: true });
    expect(r).toBe("4.1.2");
  });

  it("retries on transient error and succeeds on second attempt", async () => {
    const okBody = { uuid: "xyz" };
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ message: "err" }), { status: 500, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(okBody), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(BASE_CFG, { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} });
    const result = await client.request("/foo");
    expect(result).toEqual(okBody);
    expect(calls).toBe(2);
  });
});

describe("R11 header hardening — Authorization cannot be overridden by extraHeaders", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("R11 request(): extraHeaders Authorization is overwritten by the real token", async () => {
    // Attack: extraHeaders contains a spoofed Authorization. The real token must win.
    globalThis.fetch = makeFetch(200, {});
    const cfg: ApiConfig = {
      ...BASE_CFG,
      token: "real|token",
      extraHeaders: { Authorization: "Bearer evil-spoof" },
    };
    const client = new CoolifyApiClient(cfg);
    await client.request("/foo");
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer real|token");
    expect((init.headers as Record<string, string>)["Authorization"]).not.toContain("evil-spoof");
  });

  it("R11 health(): extraHeaders Authorization is overwritten by the real token", async () => {
    // Attack: same as above but for the health() path.
    globalThis.fetch = makeFetch(200, { status: "ok" });
    const cfg: ApiConfig = {
      ...BASE_CFG,
      token: "real|token",
      extraHeaders: { Authorization: "Bearer evil-spoof" },
    };
    const client = new CoolifyApiClient(cfg);
    await client.health();
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer real|token");
    expect((init.headers as Record<string, string>)["Authorization"]).not.toContain("evil-spoof");
  });

  it("R11 request(): safe extraHeaders (X-Custom) are still forwarded", async () => {
    globalThis.fetch = makeFetch(200, {});
    const cfg: ApiConfig = {
      ...BASE_CFG,
      extraHeaders: { "X-Custom": "yes", Authorization: "Bearer evil-spoof" },
    };
    const client = new CoolifyApiClient(cfg);
    await client.request("/foo");
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Custom"]).toBe("yes");
    // Real token must still win
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer 123|abc");
  });
});

describe("CoolifyApiClient.health", () => {
  it("calls /api/health (not /api/v1/health)", async () => {
    globalThis.fetch = makeFetch(200, { status: "ok" });
    const client = new CoolifyApiClient(BASE_CFG);
    await client.health();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cool.example.com/api/health");
  });
});

describe("CoolifyApiClient.version", () => {
  it("returns version string from /api/v1/version", async () => {
    globalThis.fetch = makeFetch(200, { version: "4.0.0-beta.470" });
    const client = new CoolifyApiClient(BASE_CFG);
    const v = await client.version();
    expect(v).toBe("4.0.0-beta.470");
  });

  it("falls back to string body if version key absent", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("4.0.0-beta.470", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(BASE_CFG);
    const v = await client.version();
    expect(typeof v).toBe("string");
  });
});

describe("CoolifyApiClient.resources", () => {
  it("returns array from /resources", async () => {
    const data = [{ uuid: "a" }, { uuid: "b" }];
    globalThis.fetch = makeFetch(200, data);
    const client = new CoolifyApiClient(BASE_CFG);
    const result = await client.resources();
    expect(result).toEqual(data);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cool.example.com/api/v1/resources");
  });

  it("returns [] defensively if response body is a string (not array)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify("some string"), { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof globalThis.fetch;
    const client = new CoolifyApiClient(BASE_CFG);
    const result = await client.resources();
    expect(result).toEqual([]);
  });

  it("returns [] defensively if response body is an object (not array)", async () => {
    globalThis.fetch = makeFetch(200, { unexpected: true });
    const client = new CoolifyApiClient(BASE_CFG);
    const result = await client.resources();
    expect(result).toEqual([]);
  });
});
