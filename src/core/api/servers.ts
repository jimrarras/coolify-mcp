import type { CoolifyApiClient } from "./client.js";

export class ServersApi {
  constructor(private readonly client: CoolifyApiClient) {}

  list(): Promise<Record<string, unknown>[]> { return this.client.request("/servers"); }
  get(uuid: string): Promise<Record<string, unknown>> { return this.client.request(`/servers/${encodeURIComponent(uuid)}`); }
  validate(uuid: string): Promise<unknown> { return this.client.request(`/servers/${encodeURIComponent(uuid)}/validate`); }
  resources(uuid: string): Promise<Record<string, unknown>[]> { return this.client.request(`/servers/${encodeURIComponent(uuid)}/resources`); }
  domains(uuid: string): Promise<unknown> { return this.client.request(`/servers/${encodeURIComponent(uuid)}/domains`); }
  create(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/servers", { method: "POST", body }); }
  createHetzner(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/servers/hetzner", { method: "POST", body }); }
  update(uuid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> { return this.client.request(`/servers/${encodeURIComponent(uuid)}`, { method: "PATCH", body }); }
  delete(uuid: string): Promise<{ message: string }> { return this.client.request(`/servers/${encodeURIComponent(uuid)}`, { method: "DELETE" }); }
}
