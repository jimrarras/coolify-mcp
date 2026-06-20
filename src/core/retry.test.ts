import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isTransientCoolifyError } from "./retry.js";
import { CoolifyError } from "./errors.js";

describe("isTransientCoolifyError", () => {
  it("returns true for CoolifyError with status 429", () => {
    expect(isTransientCoolifyError(new CoolifyError("transient_exhausted", "rate limited", { status: 429 }))).toBe(true);
  });

  it("returns true for CoolifyError with status 500", () => {
    expect(isTransientCoolifyError(new CoolifyError("transient_exhausted", "server error", { status: 500 }))).toBe(true);
  });

  it("returns true for CoolifyError with status 502", () => {
    expect(isTransientCoolifyError(new CoolifyError("transient_exhausted", "bad gateway", { status: 502 }))).toBe(true);
  });

  it("returns true for CoolifyError with status 503", () => {
    expect(isTransientCoolifyError(new CoolifyError("transient_exhausted", "unavailable", { status: 503 }))).toBe(true);
  });

  it("returns true for CoolifyError with status 504", () => {
    expect(isTransientCoolifyError(new CoolifyError("transient_exhausted", "timeout", { status: 504 }))).toBe(true);
  });

  it("returns false for CoolifyError with status 404", () => {
    expect(isTransientCoolifyError(new CoolifyError("not_found", "not found", { status: 404 }))).toBe(false);
  });

  it("returns false for CoolifyError with status 422", () => {
    expect(isTransientCoolifyError(new CoolifyError("invalid_input", "unprocessable", { status: 422 }))).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isTransientCoolifyError(new Error("something"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isTransientCoolifyError(null)).toBe(false);
  });
});

describe("withRetry", () => {
  let sleepCalls: number[];
  let sleep: (ms: number) => Promise<void>;

  beforeEach(() => {
    sleepCalls = [];
    sleep = vi.fn(async (ms: number) => { sleepCalls.push(ms); });
  });

  it("resolves immediately if fn succeeds on the first attempt", async () => {
    const fn = vi.fn(async () => "success");
    const result = await withRetry(fn, {
      isRetryable: () => true,
      sleep,
    });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toHaveLength(0);
  });

  it("retries on retryable error and succeeds on second attempt", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new CoolifyError("transient_exhausted", "oops", { status: 503 });
      return "ok";
    });
    const result = await withRetry(fn, {
      isRetryable: isTransientCoolifyError,
      baseDelayMs: 100,
      sleep,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(100);
  });

  it("applies exponential backoff", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 4) throw new CoolifyError("transient_exhausted", "oops", { status: 503 });
      return "done";
    });
    const result = await withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      isRetryable: isTransientCoolifyError,
      sleep,
    });
    expect(result).toBe("done");
    expect(sleepCalls).toEqual([100, 200, 400]);
  });

  it("throws after maxAttempts are exhausted", async () => {
    const err = new CoolifyError("transient_exhausted", "always fails", { status: 503 });
    const fn = vi.fn(async () => { throw err; });
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 50,
        isRetryable: isTransientCoolifyError,
        sleep,
      })
    ).rejects.toThrow(CoolifyError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry if isRetryable returns false", async () => {
    const err = new CoolifyError("not_found", "not found", { status: 404 });
    const fn = vi.fn(async () => { throw err; });
    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 50,
        isRetryable: isTransientCoolifyError,
        sleep,
      })
    ).rejects.toThrow(CoolifyError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toHaveLength(0);
  });

  it("honors retryAfter from CoolifyError for sleep duration", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new CoolifyError("transient_exhausted", "rate limited", { status: 429, retryAfter: 5 });
      }
      return "ok";
    });
    const result = await withRetry(fn, {
      baseDelayMs: 100,
      isRetryable: isTransientCoolifyError,
      sleep,
    });
    expect(result).toBe("ok");
    // retryAfter=5s should override exponential delay
    expect(sleepCalls[0]).toBe(5000);
  });

  it("caps an absurd retryAfter so a hostile header cannot pin the client", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new CoolifyError("transient_exhausted", "rate limited", { status: 429, retryAfter: 86_400 });
      }
      return "ok";
    });
    const result = await withRetry(fn, { isRetryable: isTransientCoolifyError, sleep });
    expect(result).toBe("ok");
    // 86_400s would be 86_400_000ms; bounded to the 5-minute Retry-After ceiling.
    expect(sleepCalls[0]).toBe(300_000);
  });

  it("honors a legitimate medium Retry-After verbatim (not clipped to the exponential cap)", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new CoolifyError("transient_exhausted", "rate limited", { status: 429, retryAfter: 60 });
      }
      return "ok";
    });
    const result = await withRetry(fn, { isRetryable: isTransientCoolifyError, sleep });
    expect(result).toBe("ok");
    // A 60s rate-limit window must be waited out fully, not truncated to 30s.
    expect(sleepCalls[0]).toBe(60_000);
  });

  it("defaults to maxAttempts=4", async () => {
    const fn = vi.fn(async () => { throw new CoolifyError("transient_exhausted", "fail", { status: 503 }); });
    await expect(
      withRetry(fn, {
        isRetryable: isTransientCoolifyError,
        sleep,
      })
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
