import { CoolifyError } from "../errors.js";
import { withRetry, isTransientCoolifyError } from "../retry.js";
import type { ApiConfig } from "../config.js";
import { ApplicationsApi } from "./applications.js";
import { DatabasesApi } from "./databases.js";
import { ServicesApi } from "./services.js";
import { DeploymentsApi } from "./deployments.js";
import { ServersApi } from "./servers.js";
import { ProjectsApi } from "./projects.js";
import { SecurityApi } from "./security.js";
import { HetznerApi } from "./hetzner.js";
import { TeamsApi } from "./teams.js";

// Sub-clients are statically imported (each imports CoolifyApiClient *type-only*,
// so there is no runtime import cycle) and lazily instantiated on first getter
// access. This works identically under tsx, compiled dist, and vitest — unlike
// the previous createRequire("./x.js") shim, which only resolved under tsx/dist.

export interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  // Override idempotency for retry purposes. Defaults to (method === "GET").
  // Coolify's deploy trigger is a SIDE-EFFECTING GET, so DeploymentsApi.trigger()
  // sets this false to prevent a transient-error retry from duplicating a deploy.
  idempotent?: boolean;
  // Permit a non-JSON 2xx body (e.g. /version may return plain text). When false
  // (default), a successful response whose body is not JSON throws rather than
  // casting a string/empty body to T and surfacing undefined fields as success.
  allowNonJsonBody?: boolean;
}

export interface RetryOverrides {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${base}/api/v1${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function mapStatusToError(status: number, body: unknown, retryAfter?: number): CoolifyError {
  if (status === 401 || status === 403) {
    return new CoolifyError("auth", `HTTP ${status}: Unauthorized/Forbidden`, { status, raw_response: body });
  }
  if (status === 404) {
    return new CoolifyError("not_found", `HTTP 404: Resource not found`, { status, raw_response: body });
  }
  if (status === 400 || status === 422) {
    return new CoolifyError("invalid_input", `HTTP ${status}: Invalid input`, { status, raw_response: body });
  }
  if (status === 429 || (status >= 500 && status <= 599)) {
    return new CoolifyError("transient_exhausted", `HTTP ${status}: Transient error`, {
      status,
      raw_response: body,
      retryAfter,
    });
  }
  return new CoolifyError("unknown", `HTTP ${status}: Unexpected error`, { status, raw_response: body });
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return res.text();
}

export class CoolifyApiClient {
  private readonly cfg: ApiConfig;
  private readonly retryOpts: RetryOverrides;

  // Sub-clients are lazily initialised on first access to avoid circular
  // import issues during construction.
  private _applications?: ApplicationsApi;
  private _databases?: DatabasesApi;
  private _services?: ServicesApi;
  private _deployments?: DeploymentsApi;
  private _servers?: ServersApi;
  private _projects?: ProjectsApi;
  private _security?: SecurityApi;
  private _hetzner?: HetznerApi;
  private _teams?: TeamsApi;

  constructor(cfg: ApiConfig, retryOpts: RetryOverrides = {}) {
    this.cfg = cfg;
    this.retryOpts = retryOpts;
  }

  async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const { method = "GET", query, body } = opts;
    const url = buildUrl(this.cfg.baseUrl, path, query);

    const headers: Record<string, string> = {
      ...this.cfg.extraHeaders,
      Authorization: `Bearer ${this.cfg.token}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const doFetch = async (): Promise<T> => {
      const res = await globalThis.fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const parsed = await parseBody(res);

      if (!res.ok) {
        let retryAfter: number | undefined;
        const raHeader = res.headers.get("Retry-After");
        if (raHeader) {
          const parsed2 = parseInt(raHeader, 10);
          if (!isNaN(parsed2)) retryAfter = parsed2;
        }
        throw mapStatusToError(res.status, parsed, retryAfter);
      }

      // A 2xx whose body is NON-EMPTY but not JSON (a proxy text/HTML page, etc.)
      // must not be cast to T — handlers would read undefined fields and report
      // success. Fail loudly on that. An EMPTY body (e.g. a 204 No Content / empty
      // 200 from a DELETE) is a legitimate success and is passed through. Callers
      // that legitimately accept non-JSON text (e.g. /version) opt out entirely.
      if (!opts.allowNonJsonBody) {
        const ct = res.headers.get("content-type") ?? "";
        const isEmptyBody = parsed === null || parsed === "";
        if (!isEmptyBody && !ct.includes("application/json")) {
          throw new CoolifyError(
            "unknown",
            `Expected a JSON response body from ${path} but received ${ct || "a non-JSON body"} (HTTP ${res.status}).`,
            { status: res.status, raw_response: typeof parsed === "string" ? parsed : undefined },
          );
        }
      }

      return parsed as T;
    };

    // Only retry idempotent requests. A transient 5xx/429 on a non-idempotent
    // request (e.g. a POST create, or Coolify's side-effecting GET /deploy) may
    // have already been applied server-side before a gateway timed out, so a retry
    // would duplicate the side effect. Defaults to GET-is-idempotent; callers
    // override via opts.idempotent for side-effecting GETs.
    const isIdempotent = opts.idempotent ?? (method === "GET");
    return withRetry(doFetch, {
      maxAttempts: this.retryOpts.maxAttempts ?? 4,
      baseDelayMs: this.retryOpts.baseDelayMs ?? 1000,
      isRetryable: (e) => isIdempotent && isTransientCoolifyError(e),
      sleep: this.retryOpts.sleep,
    });
  }

  async health(): Promise<unknown> {
    const url = `${this.cfg.baseUrl}/api/health`;
    const res = await globalThis.fetch(url, {
      headers: {
        ...this.cfg.extraHeaders,
        Authorization: `Bearer ${this.cfg.token}`,
      },
    });
    return parseBody(res);
  }

  async version(): Promise<string> {
    // /version may return a plain-text body on some Coolify builds; accept it.
    const result = await this.request<unknown>("/version", { allowNonJsonBody: true });
    if (result !== null && typeof result === "object" && "version" in (result as Record<string, unknown>)) {
      return String((result as Record<string, unknown>)["version"]);
    }
    return String(result);
  }

  async resources(): Promise<unknown[]> {
    const result = await this.request<unknown>("/resources");
    if (Array.isArray(result)) return result;
    return [];
  }

  get applications(): ApplicationsApi {
    if (!this._applications) this._applications = new ApplicationsApi(this);
    return this._applications;
  }

  get databases(): DatabasesApi {
    if (!this._databases) this._databases = new DatabasesApi(this);
    return this._databases;
  }

  get services(): ServicesApi {
    if (!this._services) this._services = new ServicesApi(this);
    return this._services;
  }

  get deployments(): DeploymentsApi {
    if (!this._deployments) this._deployments = new DeploymentsApi(this);
    return this._deployments;
  }

  get servers(): ServersApi {
    if (!this._servers) this._servers = new ServersApi(this);
    return this._servers;
  }

  get projects(): ProjectsApi {
    if (!this._projects) this._projects = new ProjectsApi(this);
    return this._projects;
  }

  get security(): SecurityApi {
    if (!this._security) this._security = new SecurityApi(this);
    return this._security;
  }

  get hetzner(): HetznerApi {
    if (!this._hetzner) this._hetzner = new HetznerApi(this);
    return this._hetzner;
  }

  get teams(): TeamsApi {
    if (!this._teams) this._teams = new TeamsApi(this);
    return this._teams;
  }
}
