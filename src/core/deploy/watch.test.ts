// src/core/deploy/watch.test.ts
import { describe, it, expect, vi } from "vitest";

describe("runDeployWatch", () => {
  async function load() {
    const mod = await import("./watch.js");
    return mod.runDeployWatch;
  }

  function makeSleepSpy() {
    return vi.fn(async (_ms: number) => {});
  }

  it("resolves immediately for a trigger with no deployment_uuid as 'skipped'", async () => {
    const runDeployWatch = await load();
    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      { message: "Nothing to deploy.", resource_uuid: "res1abc" },
    ];
    const fakeDeployments = {
      trigger: vi.fn(),
      listActive: vi.fn(),
      history: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    } as any;
    const fakeServers = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      validate: vi.fn(),
      resources: vi.fn(async (_uuid: string) => [
        { uuid: "res1abc", status: "stopped" },
      ]),
      domains: vi.fn(),
      create: vi.fn(),
      createHetzner: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as any;

    const results = await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: fakeDeployments,
      servers: fakeServers,
      sleep: makeSleepSpy(),
      timeoutMs: 5000,
    });

    expect(results).toHaveLength(1);
    expect(results[0].resource_uuid).toBe("res1abc");
    // No deployment_uuid — classified as skipped or unknown based on message heuristic
    expect(["skipped", "unknown"]).toContain(results[0].final_status);
  });

  it("polls to finished when deployment reaches finished status", async () => {
    const runDeployWatch = await load();

    let callCount = 0;
    const fakeDeployments = {
      get: vi.fn(async (_uuid: string) => {
        callCount++;
        if (callCount < 3) {
          return { id: 1, deployment_uuid: "dep1", status: "in_progress" };
        }
        return { id: 1, deployment_uuid: "dep1", status: "finished" };
      }),
      trigger: vi.fn(),
      listActive: vi.fn(),
      history: vi.fn(),
      cancel: vi.fn(),
    } as any;
    const fakeServers = {} as any;

    const sleepSpy = makeSleepSpy();
    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      { message: "Deployment queued.", resource_uuid: "app1abc", deployment_uuid: "dep1" },
    ];

    const results = await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: fakeDeployments,
      servers: fakeServers,
      sleep: sleepSpy,
      timeoutMs: 30_000,
    });

    expect(results).toHaveLength(1);
    expect(results[0].final_status).toBe("finished");
    expect(results[0].deployment_uuid).toBe("dep1");
    expect(results[0].resource_uuid).toBe("app1abc");
    expect(fakeDeployments.get).toHaveBeenCalledTimes(3);
    // sleep was called between polls
    expect(sleepSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("resolves as 'failed' when deployment reaches failed status", async () => {
    const runDeployWatch = await load();

    const fakeDeployments = {
      get: vi.fn(async () => ({
        id: 2,
        deployment_uuid: "dep2",
        status: "failed",
        logs: "Build error: exit 1",
      })),
      trigger: vi.fn(),
      listActive: vi.fn(),
      history: vi.fn(),
      cancel: vi.fn(),
    } as any;

    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      { message: "Deployment queued.", resource_uuid: "app2abc", deployment_uuid: "dep2" },
    ];

    const results = await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: fakeDeployments,
      servers: fakeDeployments,
      sleep: makeSleepSpy(),
      timeoutMs: 30_000,
    });

    expect(results[0].final_status).toBe("failed");
    expect(results[0].logs_tail).toContain("Build error");
  });

  it("times out and returns 'unknown' when deadline is exceeded", async () => {
    const runDeployWatch = await load();

    const fakeDeployments = {
      get: vi.fn(async () => ({
        id: 3,
        deployment_uuid: "dep3",
        status: "in_progress",
      })),
      trigger: vi.fn(),
      listActive: vi.fn(),
      history: vi.fn(),
      cancel: vi.fn(),
    } as any;

    let sleepCalls = 0;
    const sleepSpy = vi.fn(async (_ms: number) => {
      sleepCalls++;
      if (sleepCalls > 5) {
        // Simulate time passing by throwing — the watch should detect deadline via elapsed tracking.
        // Instead of throwing, we just let it run; timeoutMs=0 forces immediate timeout.
      }
    });

    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      { message: "Deployment queued.", resource_uuid: "app3abc", deployment_uuid: "dep3" },
    ];

    // timeoutMs=1 so the deadline is immediately exceeded after first check
    const results = await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: fakeDeployments,
      servers: {} as any,
      sleep: sleepSpy,
      timeoutMs: 1,
    });

    expect(results[0].final_status).toBe("unknown");
  });

  it("calls onProgress for each poll iteration", async () => {
    const runDeployWatch = await load();

    let callCount = 0;
    const fakeDeployments = {
      get: vi.fn(async () => {
        callCount++;
        if (callCount < 2) return { id: 4, deployment_uuid: "dep4", status: "in_progress" };
        return { id: 4, deployment_uuid: "dep4", status: "finished" };
      }),
      trigger: vi.fn(),
      listActive: vi.fn(),
      history: vi.fn(),
      cancel: vi.fn(),
    } as any;

    const progressEvents: Array<{ resource_uuid: string; status: string; lines: number }> = [];
    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      { message: "Deployment queued.", resource_uuid: "app4abc", deployment_uuid: "dep4" },
    ];

    await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: fakeDeployments,
      servers: {} as any,
      sleep: makeSleepSpy(),
      timeoutMs: 30_000,
      onProgress: (e) => progressEvents.push(e),
    });

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0].resource_uuid).toBe("app4abc");
  });

  it("handles multiple triggers in parallel", async () => {
    const runDeployWatch = await load();

    const statusMap: Record<string, string[]> = {
      dep_a: ["in_progress", "finished"],
      dep_b: ["in_progress", "failed"],
    };
    const callCounts: Record<string, number> = { dep_a: 0, dep_b: 0 };

    const fakeDeployments = {
      get: vi.fn(async (uuid: string) => {
        callCounts[uuid] = (callCounts[uuid] ?? 0) + 1;
        const statuses = statusMap[uuid] ?? ["finished"];
        const idx = Math.min(callCounts[uuid] - 1, statuses.length - 1);
        return { id: 0, deployment_uuid: uuid, status: statuses[idx] };
      }),
      trigger: vi.fn(),
      listActive: vi.fn(),
      history: vi.fn(),
      cancel: vi.fn(),
    } as any;

    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      { message: "queued", resource_uuid: "resA", deployment_uuid: "dep_a" },
      { message: "queued", resource_uuid: "resB", deployment_uuid: "dep_b" },
    ];

    const results = await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: fakeDeployments,
      servers: {} as any,
      sleep: makeSleepSpy(),
      timeoutMs: 30_000,
    });

    expect(results).toHaveLength(2);
    const byUuid = Object.fromEntries(results.map((r) => [r.resource_uuid, r]));
    expect(byUuid["resA"].final_status).toBe("finished");
    expect(byUuid["resB"].final_status).toBe("failed");
  });

  it("detects skipped trigger from message text", async () => {
    const runDeployWatch = await load();

    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      {
        message: "Nothing to deploy. Already up to date.",
        resource_uuid: "res_skip",
        // no deployment_uuid
      },
    ];

    const results = await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: {} as any,
      servers: {} as any,
      sleep: makeSleepSpy(),
      timeoutMs: 30_000,
    });

    expect(results[0].final_status).toBe("skipped");
  });

  it("tolerates a not-yet-visible 404 / transient poll error and keeps polling to a terminal status", async () => {
    const runDeployWatch = await load();
    let n = 0;
    const fakeDeployments = {
      get: vi.fn(async (_uuid: string) => {
        n++;
        if (n === 1) throw Object.assign(new Error("HTTP 404: Resource not found"), { kind: "not_found" });
        if (n === 2) throw Object.assign(new Error("HTTP 503: Transient error"), { kind: "transient_exhausted" });
        return { id: 1, deployment_uuid: "dep1", status: "finished" };
      }),
      trigger: vi.fn(), listActive: vi.fn(), history: vi.fn(), cancel: vi.fn(),
    } as any;
    const results = await runDeployWatch(
      [{ message: "queued", resource_uuid: "app1", deployment_uuid: "dep1" }],
      async () => "s",
      { deployments: fakeDeployments, servers: {} as any, sleep: makeSleepSpy(), timeoutMs: 30_000 },
    );
    expect(results[0].final_status).toBe("finished");
    expect(fakeDeployments.get).toHaveBeenCalledTimes(3);
  });

  it("gives up as 'unknown' after a bounded number of consecutive poll errors (not infinitely)", async () => {
    const runDeployWatch = await load();
    const fakeDeployments = {
      get: vi.fn(async () => { throw Object.assign(new Error("HTTP 503"), { kind: "transient_exhausted" }); }),
      trigger: vi.fn(), listActive: vi.fn(), history: vi.fn(), cancel: vi.fn(),
    } as any;
    const results = await runDeployWatch(
      [{ message: "queued", resource_uuid: "app1", deployment_uuid: "dep1" }],
      async () => "s",
      { deployments: fakeDeployments, servers: {} as any, sleep: makeSleepSpy(), timeoutMs: 30_000 },
    );
    expect(results[0].final_status).toBe("unknown");
    expect(results[0].error?.kind).toBe("transient_exhausted");
    // It retried (tolerance), but the retry count is bounded.
    expect(fakeDeployments.get.mock.calls.length).toBeGreaterThan(1);
    expect(fakeDeployments.get.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("does not let transient poll errors inflate the steady-state poll cadence (counters decoupled)", async () => {
    const runDeployWatch = await load();
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => { sleepCalls.push(ms); });
    let n = 0;
    const fakeDeployments = {
      get: vi.fn(async () => {
        n++;
        if (n <= 2) throw Object.assign(new Error("HTTP 503"), { kind: "transient_exhausted" });
        if (n <= 4) return { id: 1, deployment_uuid: "dep1", status: "in_progress" };
        return { id: 1, deployment_uuid: "dep1", status: "finished" };
      }),
      trigger: vi.fn(), listActive: vi.fn(), history: vi.fn(), cancel: vi.fn(),
    } as any;
    const results = await runDeployWatch(
      [{ message: "queued", resource_uuid: "app1", deployment_uuid: "dep1" }],
      async () => "s",
      { deployments: fakeDeployments, servers: {} as any, sleep, timeoutMs: 60_000 },
    );
    expect(results[0].final_status).toBe("finished");
    // sleeps: [err1=2000, err2=4000, firstSuccessfulPoll=2000, ...].
    // The first successful in-progress poll must ramp from BASE (2000ms), NOT be
    // inflated to ~8000ms by the two preceding transient errors.
    expect(sleepCalls[2]).toBe(2000);
  });

  it("settles a failing poll to 'unknown' with the error kind, without aborting siblings", async () => {
    const runDeployWatch = await load();

    const fakeDeployments = {
      get: vi.fn(async (uuid: string) => {
        if (uuid === "dep_bad") {
          throw Object.assign(new Error("HTTP 401: Unauthorized/Forbidden"), { kind: "auth" });
        }
        return { id: 0, deployment_uuid: uuid, status: "finished" };
      }),
      trigger: vi.fn(),
      listActive: vi.fn(),
      history: vi.fn(),
      cancel: vi.fn(),
    } as any;

    const triggers: import("../../core/api/deployments.js").DeployTriggerResult[] = [
      { message: "queued", resource_uuid: "resBad", deployment_uuid: "dep_bad" },
      { message: "queued", resource_uuid: "resOk", deployment_uuid: "dep_ok" },
    ];

    const results = await runDeployWatch(triggers, async () => "server1uuid", {
      deployments: fakeDeployments,
      servers: {} as any,
      sleep: makeSleepSpy(),
      timeoutMs: 30_000,
    });

    const byUuid = Object.fromEntries(results.map((r) => [r.resource_uuid, r]));
    // The failing poll is isolated and carries the error kind...
    expect(byUuid["resBad"].final_status).toBe("unknown");
    expect(byUuid["resBad"].error?.kind).toBe("auth");
    // ...and the sibling still settles to its real terminal status.
    expect(byUuid["resOk"].final_status).toBe("finished");
  });
});
