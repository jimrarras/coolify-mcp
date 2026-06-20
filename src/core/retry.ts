import { CoolifyError } from "./errors.js";

export interface RetryOptions {
  maxAttempts?: number;       // default 4
  baseDelayMs?: number;       // default 1000
  isRetryable: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

// Ceiling for the exponential-backoff branch.
const MAX_RETRY_DELAY_MS = 30_000;
// Separate, higher ceiling for a server-supplied Retry-After: honor real rate-limit
// windows (which can legitimately exceed 30s) while still bounding a hostile/absurd
// value (e.g. `Retry-After: 86400`) so it cannot pin the client for hours.
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function isTransientCoolifyError(e: unknown): boolean {
  if (!(e instanceof CoolifyError)) return false;
  if (e.status !== undefined && TRANSIENT_STATUSES.has(e.status)) return true;
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!opts.isRetryable(e)) throw e;
      if (attempt === maxAttempts - 1) break;

      // Use retryAfter from CoolifyError if present, else exponential backoff.
      // Each branch is bounded by its own ceiling so neither blocks indefinitely,
      // while a legitimate (medium) Retry-After is still honored in full.
      let delayMs: number;
      if (e instanceof CoolifyError && e.retryAfter !== undefined) {
        delayMs = Math.min(e.retryAfter * 1000, MAX_RETRY_AFTER_MS);
      } else {
        delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}
