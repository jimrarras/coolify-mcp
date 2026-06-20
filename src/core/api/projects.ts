import type { CoolifyApiClient } from "./client.js";

export class ProjectsApi {
  constructor(private readonly client: CoolifyApiClient) {}

  list(): Promise<Record<string, unknown>[]> { return this.client.request("/projects"); }
  get(uuid: string): Promise<Record<string, unknown>> { return this.client.request(`/projects/${encodeURIComponent(uuid)}`); }
  create(body: { name: string; description?: string }): Promise<{ uuid: string }> { return this.client.request("/projects", { method: "POST", body }); }
  update(uuid: string, body: { name?: string; description?: string }): Promise<Record<string, unknown>> { return this.client.request(`/projects/${encodeURIComponent(uuid)}`, { method: "PATCH", body }); }
  delete(uuid: string): Promise<{ message: string }> { return this.client.request(`/projects/${encodeURIComponent(uuid)}`, { method: "DELETE" }); }
  listEnvironments(uuid: string): Promise<Record<string, unknown>[]> { return this.client.request(`/projects/${encodeURIComponent(uuid)}/environments`); }
  createEnvironment(uuid: string, body: { name: string }): Promise<unknown> { return this.client.request(`/projects/${encodeURIComponent(uuid)}/environments`, { method: "POST", body }); }
  getEnvironment(uuid: string, nameOrUuid: string): Promise<Record<string, unknown>> { return this.client.request(`/projects/${encodeURIComponent(uuid)}/environments/${encodeURIComponent(nameOrUuid)}`); }
  deleteEnvironment(uuid: string, nameOrUuid: string): Promise<unknown> { return this.client.request(`/projects/${encodeURIComponent(uuid)}/environments/${encodeURIComponent(nameOrUuid)}`, { method: "DELETE" }); }
}
