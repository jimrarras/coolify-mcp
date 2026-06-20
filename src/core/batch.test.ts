import { describe, it, expect, vi } from "vitest";
import { runBatch } from "./batch.js";
import type { BatchEnvelope } from "./batch.js";

describe("runBatch", () => {
  it("returns a BatchEnvelope with correct totals for all-success case", async () => {
    const items = [1, 2, 3];
    const worker = vi.fn(async (item: number) => item * 10);
    const env: BatchEnvelope = await runBatch(items, 2, worker);

    expect(env.total).toBe(3);
    expect(env.ok).toBe(3);
    expect(env.failed).toBe(0);
    expect(env.results).toHaveLength(3);
    expect(env.results[0]).toMatchObject({ index: 0, status: "ok", result: 10 });
    expect(env.results[1]).toMatchObject({ index: 1, status: "ok", result: 20 });
    expect(env.results[2]).toMatchObject({ index: 2, status: "ok", result: 30 });
  });

  it("captures errors without short-circuiting", async () => {
    const items = ["a", "b", "c"];
    const worker = vi.fn(async (item: string) => {
      if (item === "b") throw new Error("b failed");
      return item.toUpperCase();
    });
    const env: BatchEnvelope = await runBatch(items, 3, worker);

    expect(env.total).toBe(3);
    expect(env.ok).toBe(2);
    expect(env.failed).toBe(1);

    const aResult = env.results.find((r) => r.index === 0)!;
    expect(aResult.status).toBe("ok");
    expect(aResult.result).toBe("A");

    const bResult = env.results.find((r) => r.index === 1)!;
    expect(bResult.status).toBe("error");
    expect(bResult.error).toMatchObject({ kind: "unknown", message: "b failed" });

    const cResult = env.results.find((r) => r.index === 2)!;
    expect(cResult.status).toBe("ok");
    expect(cResult.result).toBe("C");
  });

  it("preserves original index ordering in results", async () => {
    const items = [50, 10, 30];
    // Each item's delay is the item value ms — item[1]=10 finishes before item[0]=50
    let resolvers: Array<() => void> = [];

    const worker = vi.fn(async (item: number, index: number) => {
      await new Promise<void>((res) => {
        resolvers[index] = res;
      });
      return index;
    });

    const p = runBatch(items, 3, worker);

    // Resolve out of order: 1, 2, 0
    resolvers[1]();
    resolvers[2]();
    resolvers[0]();

    const env = await p;
    expect(env.results[0].index).toBe(0);
    expect(env.results[1].index).toBe(1);
    expect(env.results[2].index).toBe(2);
    expect(env.results[0].result).toBe(0);
    expect(env.results[1].result).toBe(1);
    expect(env.results[2].result).toBe(2);
  });

  it("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const items = [1, 2, 3, 4, 5];

    const worker = async (item: number) => {
      concurrent++;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      await new Promise<void>((res) => setTimeout(res, 10));
      concurrent--;
      return item;
    };

    await runBatch(items, 2, worker);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("handles an empty items array", async () => {
    const env = await runBatch([], 4, async () => "x");
    expect(env.total).toBe(0);
    expect(env.ok).toBe(0);
    expect(env.failed).toBe(0);
    expect(env.results).toEqual([]);
  });

  it("handles concurrency greater than items length", async () => {
    const items = [1, 2];
    const worker = vi.fn(async (item: number) => item * 2);
    const env = await runBatch(items, 10, worker);
    expect(env.ok).toBe(2);
    expect(env.results[0].result).toBe(2);
    expect(env.results[1].result).toBe(4);
  });

  it("wraps non-Error thrown values into ToolError with kind unknown", async () => {
    const items = ["x"];
    const worker = async () => { throw "string-error"; };
    const env = await runBatch(items, 1, worker);
    expect(env.failed).toBe(1);
    expect(env.results[0].error?.kind).toBe("unknown");
    expect(env.results[0].error?.message).toContain("string-error");
  });

  it("passes the correct index to the worker", async () => {
    const items = ["a", "b", "c"];
    const indices: number[] = [];
    await runBatch(items, 1, async (_item, idx) => { indices.push(idx); });
    expect(indices).toEqual([0, 1, 2]);
  });
});
