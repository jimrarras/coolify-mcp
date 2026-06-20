import type { CoolifyApiClient } from "./client.js";
import type { ControlResult, EnvVar } from "./types.js";

export class ServicesApi {
  constructor(private readonly client: CoolifyApiClient) {}

  list(): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>("/services");
  }

  get(uuid: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(`/services/${encodeURIComponent(uuid)}`);
  }

  create(body: Record<string, unknown>): Promise<{ uuid: string }> {
    return this.client.request<{ uuid: string }>("/services", { method: "POST", body });
  }

  update(uuid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(`/services/${encodeURIComponent(uuid)}`, { method: "PATCH", body });
  }

  delete(uuid: string): Promise<{ message: string }> {
    return this.client.request<{ message: string }>(`/services/${encodeURIComponent(uuid)}`, { method: "DELETE" });
  }

  control(uuid: string, action: "start" | "stop" | "restart"): Promise<ControlResult> {
    return this.client.request<ControlResult>(`/services/${encodeURIComponent(uuid)}/${action}`, { method: "POST" });
  }

  listEnvs(uuid: string): Promise<EnvVar[]> {
    return this.client.request<EnvVar[]>(`/services/${encodeURIComponent(uuid)}/envs`);
  }

  upsertEnvsBulk(uuid: string, data: { key: string; value: string }[]): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/envs/bulk`, { method: "PATCH", body: { data } });
  }

  deleteEnv(uuid: string, envUuid: string): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/envs/${encodeURIComponent(envUuid)}`, { method: "DELETE" });
  }

  listStorages(uuid: string): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>(`/services/${encodeURIComponent(uuid)}/storages`);
  }

  createStorage(uuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/storages`, { method: "POST", body });
  }

  updateStorage(uuid: string, storageUuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/storages/${encodeURIComponent(storageUuid)}`, { method: "PATCH", body });
  }

  deleteStorage(uuid: string, storageUuid: string): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/storages/${encodeURIComponent(storageUuid)}`, { method: "DELETE" });
  }

  listScheduledTasks(uuid: string): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>(`/services/${encodeURIComponent(uuid)}/scheduled-tasks`);
  }

  createScheduledTask(uuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/scheduled-tasks`, { method: "POST", body });
  }

  updateScheduledTask(uuid: string, taskUuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}`, { method: "PATCH", body });
  }

  deleteScheduledTask(uuid: string, taskUuid: string): Promise<unknown> {
    return this.client.request<unknown>(`/services/${encodeURIComponent(uuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}`, { method: "DELETE" });
  }

  scheduledTaskExecutions(uuid: string, taskUuid: string): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>(`/services/${encodeURIComponent(uuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}/executions`);
  }
}
