import type { CoolifyApiClient } from "./client.js";

export class SecurityApi {
  constructor(private readonly client: CoolifyApiClient) {}

  listKeys(): Promise<Record<string, unknown>[]> { return this.client.request("/security/keys"); }
  getKey(uuid: string): Promise<Record<string, unknown>> { return this.client.request(`/security/keys/${encodeURIComponent(uuid)}`); }
  createKey(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/security/keys", { method: "POST", body }); }
  updateKey(body: Record<string, unknown>): Promise<unknown> { return this.client.request("/security/keys", { method: "PATCH", body }); }
  deleteKey(uuid: string): Promise<unknown> { return this.client.request(`/security/keys/${encodeURIComponent(uuid)}`, { method: "DELETE" }); }
  listCloudTokens(): Promise<Record<string, unknown>[]> { return this.client.request("/cloud-tokens"); }
  createCloudToken(body: Record<string, unknown>): Promise<unknown> { return this.client.request("/cloud-tokens", { method: "POST", body }); }
  updateCloudToken(uuid: string, body: Record<string, unknown>): Promise<unknown> { return this.client.request(`/cloud-tokens/${encodeURIComponent(uuid)}`, { method: "PATCH", body }); }
  deleteCloudToken(uuid: string): Promise<unknown> { return this.client.request(`/cloud-tokens/${encodeURIComponent(uuid)}`, { method: "DELETE" }); }
  validateCloudToken(uuid: string): Promise<unknown> { return this.client.request(`/cloud-tokens/${encodeURIComponent(uuid)}/validate`, { method: "POST" }); }
}
