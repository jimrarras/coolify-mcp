// src/core/batch.ts
import type { ToolError } from "./errors.js";

export interface BatchItemResult {
  index: number;
  status: "ok" | "error";
  result?: unknown;
  error?: ToolError;
}

export interface BatchEnvelope {
  total: number;
  ok: number;
  failed: number;
  results: BatchItemResult[];
}

function toToolError(e: unknown): ToolError {
  if (e instanceof Error) {
    return { kind: "unknown", message: e.message };
  }
  return { kind: "unknown", message: String(e) };
}

export async function runBatch<I>(
  items: I[],
  concurrency: number,
  worker: (item: I, index: number) => Promise<unknown>,
): Promise<BatchEnvelope> {
  const results: BatchItemResult[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      try {
        const result = await worker(item, index);
        results[index] = { index, status: "ok", result };
      } catch (e) {
        results[index] = { index, status: "error", error: toToolError(e) };
      }
    }
  }

  const slots = Math.min(concurrency, items.length);
  if (slots > 0) {
    const runners = Array.from({ length: slots }, () => runWorker());
    await Promise.all(runners);
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "error").length;

  return {
    total: items.length,
    ok,
    failed,
    results,
  };
}
