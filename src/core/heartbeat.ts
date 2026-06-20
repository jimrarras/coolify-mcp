// src/core/heartbeat.ts
export type Notifier = {
  sendNotification?: (n: { method: string; params?: unknown }) => Promise<unknown>;
};

export interface WithHeartbeatOptions {
  intervalMs?: number;   // default 15000
  logger?: string;       // default "coolify"
}

export async function withHeartbeat<T>(
  extra: Notifier | undefined,
  fn: () => Promise<T>,
  options?: WithHeartbeatOptions,
): Promise<T> {
  const intervalMs = options?.intervalMs ?? 15_000;
  const logger = options?.logger ?? "coolify";
  const notify = extra?.sendNotification?.bind(extra);

  let handle: ReturnType<typeof setInterval> | undefined;

  if (notify) {
    handle = setInterval(() => {
      void notify({
        method: "notifications/progress",
        params: { logger, message: "still running…" },
      });
    }, intervalMs);
  }

  try {
    return await fn();
  } finally {
    if (handle !== undefined) clearInterval(handle);
  }
}
