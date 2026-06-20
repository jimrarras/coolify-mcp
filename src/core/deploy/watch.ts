// src/core/deploy/watch.ts
import type { DeploymentsApi, DeployTriggerResult } from "../api/deployments.js";
import type { ServersApi } from "../api/servers.js";

export interface DeployWatchResult {
  resource_uuid: string;
  deployment_uuid?: string;
  final_status: "finished" | "failed" | "cancelled" | "skipped" | "unknown";
  logs_tail?: string;
  // Set when polling threw (final_status "unknown" via the independent-settling
  // catch below) — preserves the error kind so a single-resource watch can still
  // tell an auth/not_found failure apart from a genuinely indeterminate deploy.
  error?: { kind: string; message: string };
}

export interface DeployWatchDeps {
  deployments: DeploymentsApi;
  servers: ServersApi;
  onProgress?: (e: { resource_uuid: string; status: string; lines: number }) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

type TerminalStatus = "finished" | "failed" | "cancelled" | "skipped" | "unknown";
const TERMINAL_STATUSES = new Set<string>(["finished", "failed", "cancelled", "error", "skipped"]);

// Per-poll fault tolerance: a status GET may fail because the deployment record
// is not yet visible just after trigger (404) or due to a transient gateway/5xx.
// Tolerate a bounded number of CONSECUTIVE such failures before settling to
// "unknown"; permanent errors (auth, invalid_input) settle immediately.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
const TOLERABLE_POLL_ERROR_KINDS = new Set<string>(["not_found", "transient_exhausted"]);

function errorKindOf(e: unknown): string {
  return typeof (e as { kind?: unknown })?.kind === "string" ? (e as { kind: string }).kind : "unknown";
}

function isSkippedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("nothing to deploy") ||
    lower.includes("already up to date") ||
    lower.includes("skipped") ||
    lower.includes("no change")
  );
}

function mapTerminalStatus(raw: string): TerminalStatus {
  if (raw === "finished") return "finished";
  if (raw === "failed" || raw === "error") return "failed";
  if (raw === "cancelled") return "cancelled";
  if (raw === "skipped") return "skipped";
  return "unknown";
}

function cap(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function watchSingleDeployment(
  trigger: DeployTriggerResult,
  deps: DeployWatchDeps,
  deadline: number,
): Promise<DeployWatchResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { resource_uuid, deployment_uuid, message } = trigger;

  // No deployment_uuid: classify from message or use server resource polling
  if (!deployment_uuid) {
    if (isSkippedMessage(message)) {
      return { resource_uuid, final_status: "skipped" };
    }
    return { resource_uuid, final_status: "unknown" };
  }

  let attempt = 0;
  let consecutiveErrors = 0;
  let lastError: { kind: string; message: string } | undefined;
  const BASE_DELAY_MS = 2_000;
  const MAX_DELAY_MS = 10_000;

  while (true) {
    if (Date.now() >= deadline) {
      return { resource_uuid, deployment_uuid, final_status: "unknown", ...(lastError ? { error: lastError } : {}) };
    }

    let deployment: Awaited<ReturnType<typeof deps.deployments.get>>;
    try {
      deployment = await deps.deployments.get(deployment_uuid);
      consecutiveErrors = 0; // a successful poll clears the error streak
    } catch (e) {
      const kind = errorKindOf(e);
      lastError = { kind, message: e instanceof Error ? e.message : String(e) };
      consecutiveErrors++;
      // Permanent errors settle immediately; tolerable ones (not-yet-visible 404 /
      // transient 5xx) keep polling until the streak or the deadline is exceeded.
      if (!TOLERABLE_POLL_ERROR_KINDS.has(kind) || consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        return { resource_uuid, deployment_uuid, final_status: "unknown", error: lastError };
      }
      // Back off on the ERROR streak (which resets on a successful poll), kept
      // separate from `attempt` so transient blips don't inflate the steady-state
      // poll cadence once polling resumes.
      const backoff = cap(BASE_DELAY_MS * Math.pow(2, consecutiveErrors - 1), BASE_DELAY_MS, MAX_DELAY_MS);
      await sleep(backoff);
      continue;
    }

    const status = deployment.status ?? "unknown";

    const logText = typeof deployment.logs === "string" ? deployment.logs : undefined;
    const logLines = logText ? logText.split("\n").length : 0;

    if (deps.onProgress) {
      deps.onProgress({ resource_uuid, status, lines: logLines });
    }

    if (TERMINAL_STATUSES.has(status)) {
      const final_status = mapTerminalStatus(status);
      const logs_tail = logText ? logText.split("\n").slice(-50).join("\n") : undefined;
      return { resource_uuid, deployment_uuid, final_status, logs_tail };
    }

    const delay = cap(BASE_DELAY_MS * Math.pow(2, attempt), BASE_DELAY_MS, MAX_DELAY_MS);
    await sleep(delay);
    attempt++;
  }
}

export async function runDeployWatch(
  triggers: DeployTriggerResult[],
  _serverUuidFor: (resourceUuid: string) => Promise<string>,
  deps: DeployWatchDeps,
): Promise<DeployWatchResult[]> {
  const timeoutMs = deps.timeoutMs ?? 1_800_000;
  const deadline = Date.now() + timeoutMs;

  // Settle each deployment independently: a poll failure for one resource (a
  // transient 5xx exhausted, an auth error, or a 404 on a not-yet-visible
  // record) must not abort watching of its siblings in a tag fan-out. A
  // throwing watch resolves to final_status "unknown" instead of rejecting
  // the whole batch and discarding the already-computed sibling results.
  const results = await Promise.all(
    triggers.map((trigger) =>
      watchSingleDeployment(trigger, deps, deadline).catch(
        (e: unknown): DeployWatchResult => ({
          resource_uuid: trigger.resource_uuid,
          deployment_uuid: trigger.deployment_uuid,
          final_status: "unknown",
          error: {
            kind: typeof (e as { kind?: unknown })?.kind === "string" ? (e as { kind: string }).kind : "unknown",
            message: e instanceof Error ? e.message : String(e),
          },
        }),
      ),
    ),
  );

  return results;
}
