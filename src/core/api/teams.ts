import type { CoolifyApiClient } from "./client.js";

export class TeamsApi {
  constructor(private readonly client: CoolifyApiClient) {}

  list(): Promise<Record<string, unknown>[]> { return this.client.request("/teams"); }
  get(id: number): Promise<Record<string, unknown>> { return this.client.request(`/teams/${encodeURIComponent(id)}`); }
  members(id: number): Promise<Record<string, unknown>[]> { return this.client.request(`/teams/${encodeURIComponent(id)}/members`); }
  current(): Promise<Record<string, unknown>> { return this.client.request("/teams/current"); }
  currentMembers(): Promise<Record<string, unknown>[]> { return this.client.request("/teams/current/members"); }
}
