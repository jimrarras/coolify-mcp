// src/mcp/tools/deploy_watch.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("deploy_watch tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function makeCtx(overrides: Partial<import("../tools/types.js").ToolContext> = {}): import("../tools/types.js").ToolContext {
    return {
      api: {} as any,
      config: {
        name: "default",
        baseUrl: "http://localhost",
        token: "1|secret",
        extraHeaders: {},
        enableHostOps: false,
        allowDestructive: false,
      },
      hostOps: async () => { throw new Error("disabled"); },
      resolver: {} as any,
      ...overrides,
    };
  }

  it("deploy_watch tool is present in TOOLS", async () => {
    const { TOOLS } = await import("./deploy.js");
    const watchTool = TOOLS.find((t) => t.name === "deploy_watch");
    expect(watchTool).toBeDefined();
    expect(watchTool!.tier).toBe("api");
  });

  it("returns error when uuid is invalid", async () => {
    const { TOOLS } = await import("./deploy.js");
    const watchTool = TOOLS.find((t) => t.name === "deploy_watch")!;
    const result = await watchTool.handler({ uuid: "not valid!!" }, makeCtx());
    expect(result.status).toBe("error");
    const r = result as any;
    expect(r.error.kind).toBe("invalid_input");
  });

  it("triggers deploy then polls and returns watch results", async () => {
    const fakeTrigger = [
      { message: "Deployment queued.", resource_uuid: "app1abc", deployment_uuid: "dep1" },
    ];

    let deployFetchCount = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/deployments/dep1")) {
        deployFetchCount++;
        const status = deployFetchCount >= 2 ? "finished" : "in_progress";
        return new Response(
          JSON.stringify({ id: 1, deployment_uuid: "dep1", status }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (u.endsWith("/deploy") || u.includes("/deploy?")) {
        return new Response(JSON.stringify(fakeTrigger), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });

    const notifier = {
      sendNotification: vi.fn(async () => {}),
    };

    const ctx = makeCtx({ api, notifier, progressToken: "tok1", config: { ...makeCtx().config, allowDestructive: true } as any });

    const { TOOLS } = await import("./deploy.js");
    const watchTool = TOOLS.find((t) => t.name === "deploy_watch")!;

    const result = await watchTool.handler(
      { uuid: "app1abc", timeout_seconds: 30, _sleep: async () => {}, confirm: true },
      ctx,
    );

    expect(result.status).toBe("ok");
    const r = result as any;
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results[0].final_status).toBe("finished");
  });

  it("emits progress notifications when notifier and progressToken are present", async () => {
    const fakeTrigger = [
      { message: "Queued.", resource_uuid: "app2abc", deployment_uuid: "dep2" },
    ];

    let depCallCount = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/deployments/dep2")) {
        depCallCount++;
        const status = depCallCount >= 2 ? "finished" : "in_progress";
        return new Response(
          JSON.stringify({ id: 2, deployment_uuid: "dep2", status }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (u.endsWith("/deploy") || u.includes("/deploy?")) {
        return new Response(JSON.stringify(fakeTrigger), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });
    const sendNotification = vi.fn(async () => {});
    const ctx = makeCtx({ api, notifier: { sendNotification }, progressToken: "tok2", config: { ...makeCtx().config, allowDestructive: true } as any });

    const { TOOLS } = await import("./deploy.js");
    const watchTool = TOOLS.find((t) => t.name === "deploy_watch")!;

    await watchTool.handler(
      { uuid: "app2abc", timeout_seconds: 30, _sleep: async () => {}, confirm: true },
      ctx,
    );

    expect(sendNotification.mock.calls.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstCall = (sendNotification.mock.calls as any[][])[0][0];
    expect(firstCall.method).toBe("notifications/progress");
    expect(firstCall.params.progressToken).toBe("tok2");
  });
});
