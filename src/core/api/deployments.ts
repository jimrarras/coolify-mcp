import type { CoolifyApiClient } from './client.js';

export type ResourceKind = 'applications' | 'databases' | 'services';

export interface DeployTriggerResult {
  message: string;
  resource_uuid: string;
  deployment_uuid?: string;
}

export interface Deployment {
  id: number;
  deployment_uuid: string;
  // Observed terminal values live: "finished" | "failed" | "cancelled";
  // in-flight: "queued" | "in_progress" (also "running" on /deployments).
  status: string;
  application_id?: string; // stringified integer, e.g. "7"
  pull_request_id?: number;
  force_rebuild?: boolean;
  commit?: string;
  is_webhook?: boolean;
  created_at?: string;
  updated_at?: string;
  logs?: string; // JSON-encoded string of {command,output,type,timestamp,...} entries
  [k: string]: unknown;
}

// GET /deployments/applications/{uuid} returns this wrapper, NOT a bare array
// (confirmed live against Coolify 4.1.2 — the v1 design spec mistyped it as Application[]).
export interface DeploymentHistory {
  count: number;
  deployments: Deployment[];
}

export class DeploymentsApi {
  constructor(private readonly client: CoolifyApiClient) {}

  async trigger(params: {
    uuid?: string;
    tag?: string;
    force?: boolean;
    pr?: number;
  }): Promise<DeployTriggerResult[]> {
    // POST /deploy — Coolify dropped the GET route in 4.2.0 (GET has 405'd since;
    // confirmed live against 4.3.10). POST is accepted on every supported version:
    // 4.1.x registered Route::match(['get','post']). Params stay in the query
    // string — the controller reads $request->input(), which merges query + body.
    // POST is non-idempotent by default, so a transient 5xx is never auto-retried
    // (a retry would queue duplicate deploys).
    const raw = await this.client.request<unknown>('/deploy', {
      method: 'POST',
      query: params as Record<string, string | number | boolean | undefined>,
    });
    // POST /deploy returns { deployments: [...] }, NOT a bare array (confirmed live
    // against Coolify 4.1.2). Normalize defensively so deploy/deploy_watch handlers
    // receive an array; tolerate a bare array (mocks / older versions) and odd bodies.
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { deployments?: unknown }).deployments)
    ) {
      return (raw as { deployments: DeployTriggerResult[] }).deployments;
    }
    if (Array.isArray(raw)) return raw as DeployTriggerResult[];
    return [];
  }

  async listActive(): Promise<Deployment[]> {
    const raw = await this.client.request<unknown>('/deployments');
    // Normalize defensively, mirroring trigger()/history(): tolerate a
    // { deployments: [...] } wrapper (Coolify may wrap this like the sibling
    // endpoints — the live shape is unconfirmed), a bare array, or an odd body.
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { deployments?: unknown }).deployments)
    ) {
      return (raw as { deployments: Deployment[] }).deployments;
    }
    if (Array.isArray(raw)) return raw as Deployment[];
    return [];
  }

  async history(
    appUuid: string,
    opts?: { skip?: number; take?: number },
  ): Promise<DeploymentHistory> {
    const raw = await this.client.request<unknown>(
      `/deployments/applications/${encodeURIComponent(appUuid)}`,
      { query: opts as Record<string, number | undefined> },
    );
    // Coolify 4.1.x returns { count, deployments: [...] }. Normalize defensively:
    // tolerate a bare array (older/edge responses) or an unexpected body.
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { deployments?: unknown }).deployments)
    ) {
      const r = raw as { count?: number; deployments: Deployment[] };
      return {
        count: typeof r.count === 'number' ? r.count : r.deployments.length,
        deployments: r.deployments,
      };
    }
    if (Array.isArray(raw)) return { count: raw.length, deployments: raw as Deployment[] };
    return { count: 0, deployments: [] };
  }

  get(uuid: string): Promise<Deployment> {
    return this.client.request(`/deployments/${encodeURIComponent(uuid)}`);
  }

  cancel(uuid: string): Promise<{ deployment_uuid: string; status: string }> {
    return this.client.request(`/deployments/${encodeURIComponent(uuid)}/cancel`, {
      method: 'POST',
    });
  }
}
