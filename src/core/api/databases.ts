import type { CoolifyApiClient } from "./client.js";
import type { ControlResult, EnvVar, DbEngine } from "./types.js";

export type { DbEngine };

export class DatabasesApi {
  constructor(private readonly client: CoolifyApiClient) {}

  list(): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>("/databases");
  }

  get(uuid: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(`/databases/${encodeURIComponent(uuid)}`);
  }

  create(engine: DbEngine, body: Record<string, unknown>): Promise<{ uuid: string }> {
    return this.client.request<{ uuid: string }>(`/databases/${encodeURIComponent(engine)}`, { method: "POST", body });
  }

  update(uuid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(`/databases/${encodeURIComponent(uuid)}`, { method: "PATCH", body });
  }

  delete(uuid: string): Promise<{ message: string }> {
    return this.client.request<{ message: string }>(`/databases/${encodeURIComponent(uuid)}`, { method: "DELETE" });
  }

  control(uuid: string, action: "start" | "stop" | "restart"): Promise<ControlResult> {
    return this.client.request<ControlResult>(`/databases/${encodeURIComponent(uuid)}/${action}`, { method: "POST" });
  }

  listEnvs(uuid: string): Promise<EnvVar[]> {
    return this.client.request<EnvVar[]>(`/databases/${encodeURIComponent(uuid)}/envs`);
  }

  upsertEnvsBulk(uuid: string, data: { key: string; value: string }[]): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/envs/bulk`, { method: "PATCH", body: { data } });
  }

  deleteEnv(uuid: string, envUuid: string): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/envs/${encodeURIComponent(envUuid)}`, { method: "DELETE" });
  }

  listStorages(uuid: string): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>(`/databases/${encodeURIComponent(uuid)}/storages`);
  }

  createStorage(uuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/storages`, { method: "POST", body });
  }

  updateStorage(uuid: string, storageUuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/storages/${encodeURIComponent(storageUuid)}`, { method: "PATCH", body });
  }

  deleteStorage(uuid: string, storageUuid: string): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/storages/${encodeURIComponent(storageUuid)}`, { method: "DELETE" });
  }

  listBackups(uuid: string): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>(`/databases/${encodeURIComponent(uuid)}/backups`);
  }

  createBackup(uuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/backups`, { method: "POST", body });
  }

  updateBackup(uuid: string, sbUuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(sbUuid)}`, { method: "PATCH", body });
  }

  deleteBackup(uuid: string, sbUuid: string): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(sbUuid)}`, { method: "DELETE" });
  }

  backupExecutions(uuid: string, sbUuid: string): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>(`/databases/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(sbUuid)}/executions`);
  }

  deleteBackupExecution(uuid: string, sbUuid: string, execUuid: string): Promise<unknown> {
    return this.client.request<unknown>(`/databases/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(sbUuid)}/executions/${encodeURIComponent(execUuid)}`, {
      method: "DELETE",
    });
  }
}
