import type { CoolifyApiClient } from "./client.js";

export interface ControlResult { message: string; deployment_uuid?: string; }

// Shape confirmed live against Coolify 4.1.2. With a read:sensitive token both
// `value` and `real_value` are returned DECRYPTED (plaintext) over REST — note
// the raw DB column is Laravel-`encrypted`, so query_coolify_db sees ciphertext.
export interface EnvVar {
  uuid: string;
  key: string;
  value: string;
  real_value?: string;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_preview?: boolean;
  is_shown_once?: boolean;
  is_required?: boolean;
  is_really_required?: boolean;
  is_runtime?: boolean;
  is_buildtime?: boolean;
  is_shared?: boolean;
  is_coolify?: boolean;
  is_buildpack_control?: boolean;
  comment?: string | null;
  order?: number;
  version?: string;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export class ApplicationsApi {
  constructor(private readonly client: CoolifyApiClient) {}

  list(): Promise<Record<string, unknown>[]> { return this.client.request("/applications"); }
  get(uuid: string): Promise<Record<string, unknown>> { return this.client.request(`/applications/${encodeURIComponent(uuid)}`); }
  createPublic(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/applications/public", { method: "POST", body }); }
  createPrivateGithubApp(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/applications/private-github-app", { method: "POST", body }); }
  createPrivateDeployKey(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/applications/private-deploy-key", { method: "POST", body }); }
  createDockerfile(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/applications/dockerfile", { method: "POST", body }); }
  createDockerimage(body: Record<string, unknown>): Promise<{ uuid: string }> { return this.client.request("/applications/dockerimage", { method: "POST", body }); }
  update(uuid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> { return this.client.request(`/applications/${encodeURIComponent(uuid)}`, { method: "PATCH", body }); }
  delete(uuid: string): Promise<{ message: string }> { return this.client.request(`/applications/${encodeURIComponent(uuid)}`, { method: "DELETE" }); }
  control(uuid: string, action: "start" | "stop" | "restart", opts?: { instant_deploy?: boolean }): Promise<ControlResult> {
    return this.client.request(`/applications/${encodeURIComponent(uuid)}/${action}`, {
      method: "POST",
      query: { instant_deploy: opts?.instant_deploy },
    });
  }
  logs(uuid: string, lines: number): Promise<{ logs: string }> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/logs`, { query: { lines } }); }
  listEnvs(uuid: string): Promise<EnvVar[]> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/envs`); }
  upsertEnvsBulk(uuid: string, data: { key: string; value: string }[]): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/envs/bulk`, { method: "PATCH", body: { data } }); }
  deleteEnv(uuid: string, envUuid: string): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/envs/${encodeURIComponent(envUuid)}`, { method: "DELETE" }); }
  listStorages(uuid: string): Promise<Record<string, unknown>[]> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/storages`); }
  createStorage(uuid: string, body: Record<string, unknown>): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/storages`, { method: "POST", body }); }
  updateStorage(uuid: string, storageUuid: string, body: Record<string, unknown>): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/storages/${encodeURIComponent(storageUuid)}`, { method: "PATCH", body }); }
  deleteStorage(uuid: string, storageUuid: string): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/storages/${encodeURIComponent(storageUuid)}`, { method: "DELETE" }); }
  listScheduledTasks(uuid: string): Promise<Record<string, unknown>[]> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/scheduled-tasks`); }
  createScheduledTask(uuid: string, body: Record<string, unknown>): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/scheduled-tasks`, { method: "POST", body }); }
  updateScheduledTask(uuid: string, taskUuid: string, body: Record<string, unknown>): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}`, { method: "PATCH", body }); }
  deleteScheduledTask(uuid: string, taskUuid: string): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}`, { method: "DELETE" }); }
  scheduledTaskExecutions(uuid: string, taskUuid: string): Promise<Record<string, unknown>[]> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}/executions`); }
  deletePreview(uuid: string, prId: number): Promise<unknown> { return this.client.request(`/applications/${encodeURIComponent(uuid)}/previews/${encodeURIComponent(String(prId))}`, { method: "DELETE" }); }
}
