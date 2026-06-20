import { describe, it, expect, vi } from "vitest";
import { HetznerApi } from "./hetzner.js";
import { CoolifyApiClient } from "./client.js";
import type { ApiConfig } from "../config.js";
import type { HetznerResource } from "./types.js";

const CFG: ApiConfig = { baseUrl: "https://cool.example.com", token: "1|tok", extraHeaders: {} };

function makeClient(status: number, body: unknown): CoolifyApiClient {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof globalThis.fetch;
  return new CoolifyApiClient(CFG, { maxAttempts: 1, baseDelayMs: 0 });
}

describe("HetznerApi.list", () => {
  const resources: HetznerResource[] = ["locations", "server-types", "images", "ssh-keys"];

  for (const resource of resources) {
    it(`calls GET /hetzner/${resource}`, async () => {
      const client = makeClient(200, [{ id: 1, name: "item" }]);
      const api = new HetznerApi(client);
      const result = await api.list(resource);
      expect(result).toEqual([{ id: 1, name: "item" }]);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toContain(`/api/v1/hetzner/${resource}`);
    });
  }
});
