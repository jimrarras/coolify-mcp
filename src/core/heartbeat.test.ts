import { describe, it, expect, vi, beforeEach } from "vitest";
import { withHeartbeat } from "./heartbeat.js";
import type { Notifier } from "./heartbeat.js";

describe("withHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("resolves with the function's return value", async () => {
    const result = await withHeartbeat(undefined, async () => "hello");
    expect(result).toBe("hello");
  });

  it("propagates errors thrown by fn", async () => {
    await expect(
      withHeartbeat(undefined, async () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
  });

  it("sends notifications at intervalMs when notifier has sendNotification", async () => {
    const sendNotification = vi.fn(async (_n: { method: string; params?: unknown }) => {});
    const notifier: Notifier = { sendNotification };

    let resolve!: (v: string) => void;
    const p = withHeartbeat(
      notifier,
      () => new Promise<string>((res) => { resolve = res; }),
      { intervalMs: 1000, logger: "test" }
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect((sendNotification.mock.calls as Array<[{ method: string; params?: unknown }]>)[0][0]).toMatchObject({
      method: "notifications/progress",
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    resolve("done");
    const result = await p;
    expect(result).toBe("done");
  });

  it("clears the interval when fn resolves", async () => {
    const sendNotification = vi.fn(async () => {});
    const notifier: Notifier = { sendNotification };

    const p = withHeartbeat(
      notifier,
      async () => "finished",
      { intervalMs: 1000 }
    );
    const result = await p;
    expect(result).toBe("finished");

    // Advance time well past the interval — no more notifications
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendNotification).toHaveBeenCalledTimes(0);
  });

  it("clears the interval when fn rejects", async () => {
    const sendNotification = vi.fn(async () => {});
    const notifier: Notifier = { sendNotification };

    let reject!: (e: Error) => void;
    const p = withHeartbeat(
      notifier,
      () => new Promise<string>((_, rej) => { reject = rej; }),
      { intervalMs: 500 }
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    reject(new Error("fail"));
    await expect(p).rejects.toThrow("fail");

    await vi.advanceTimersByTimeAsync(2000);
    // Still only 1 notification; interval cleared after rejection
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("works when notifier is undefined (no notifications sent)", async () => {
    // Should not throw
    const result = await withHeartbeat(undefined, async () => 42, { intervalMs: 100 });
    expect(result).toBe(42);
  });

  it("works when notifier has no sendNotification method", async () => {
    const notifier: Notifier = {};
    const result = await withHeartbeat(notifier, async () => "ok", { intervalMs: 100 });
    expect(result).toBe("ok");
  });

  it("uses default intervalMs of 15000 when not specified", async () => {
    const sendNotification = vi.fn(async () => {});
    const notifier: Notifier = { sendNotification };

    let resolve!: (v: number) => void;
    const p = withHeartbeat(
      notifier,
      () => new Promise<number>((res) => { resolve = res; })
    );

    await vi.advanceTimersByTimeAsync(14999);
    expect(sendNotification).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    resolve(7);
    const result = await p;
    expect(result).toBe(7);
  });

  it("includes logger name in notification params", async () => {
    const sendNotification = vi.fn(async (_n: { method: string; params?: unknown }) => {});
    const notifier: Notifier = { sendNotification };

    let resolve!: (v: string) => void;
    const p = withHeartbeat(
      notifier,
      () => new Promise<string>((res) => { resolve = res; }),
      { intervalMs: 500, logger: "my-logger" }
    );

    await vi.advanceTimersByTimeAsync(500);
    const calls = sendNotification.mock.calls as Array<[{ method: string; params?: { logger?: string } }]>;
    const call = calls[0][0];
    expect(call.params).toMatchObject({ logger: "my-logger" });

    resolve("x");
    await p;
  });
});
