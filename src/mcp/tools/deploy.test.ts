import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch before importing modules
const fakeTriggerResult: import("../../core/api/deployments.js").DeployTriggerResult[] = [
  { message: "Deployment queued.", resource_uuid: "app123abc", deployment_uuid: "dep456xyz" },
];
const fakeDeployments: import("../../core/api/deployments.js").Deployment[] = [
  {
    id: 1,
    deployment_uuid: "dep456xyz",
    status: "in_progress",
    application_id: "app123abc",
  },
];

describe("deploy tool", () => {
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

  it("triggers a deploy and returns ok with deployment info", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/deploy")) {
        return new Response(JSON.stringify(fakeTriggerResult), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });
    const ctx = makeCtx({ api, config: { ...makeCtx().config, allowDestructive: true } as any });

    const { TOOLS } = await import("./deploy.js");
    const deployTool = TOOLS.find((t) => t.name === "deploy")!;
    expect(deployTool).toBeDefined();

    const result = await deployTool.handler({ uuid: "app123abc", confirm: true }, ctx);
    expect(result.status).toBe("ok");
    const r = result as any;
    expect(Array.isArray(r.deployments)).toBe(true);
    expect(r.deployments[0].resource_uuid).toBe("app123abc");
  });

  it("returns error for invalid uuid", async () => {
    const { TOOLS } = await import("./deploy.js");
    const deployTool = TOOLS.find((t) => t.name === "deploy")!;
    const result = await deployTool.handler({ uuid: "not valid uuid!!" }, makeCtx());
    expect(result.status).toBe("error");
    const r = result as any;
    expect(r.error.kind).toBe("invalid_input");
  });

  it("get_deployments returns list of active deployments", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/deployments")) {
        return new Response(JSON.stringify(fakeDeployments), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });
    const ctx = makeCtx({ api });

    const { TOOLS } = await import("./deploy.js");
    const getTool = TOOLS.find((t) => t.name === "get_deployments")!;
    expect(getTool).toBeDefined();

    const result = await getTool.handler({}, ctx);
    expect(result.status).toBe("ok");
    const r = result as any;
    expect(Array.isArray(r.deployments)).toBe(true);
  });

  it("get_deployments with app_uuid returns deployment history", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(fakeDeployments), { status: 200, headers: { "content-type": "application/json" } })
    ) as any;

    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });
    const ctx = makeCtx({ api });

    const { TOOLS } = await import("./deploy.js");
    const getTool = TOOLS.find((t) => t.name === "get_deployments")!;
    const result = await getTool.handler({ app_uuid: "app123abc" }, ctx);
    expect(result.status).toBe("ok");
  });

  it("cancel_deployment is blocked when allowDestructive is false", async () => {
    const { TOOLS } = await import("./deploy.js");
    const cancelTool = TOOLS.find((t) => t.name === "cancel_deployment")!;
    expect(cancelTool).toBeDefined();

    // allowDestructive: false (default makeCtx)
    const result = await cancelTool.handler({ deployment_uuid: "dep456xyz", confirm: true }, makeCtx());
    expect(result.status).toBe("error");
    const r = result as any;
    expect(r.error.kind).toBe("destructive_blocked");
  });

  it("cancel_deployment is blocked without confirm when allowDestructive is true", async () => {
    const { TOOLS } = await import("./deploy.js");
    const cancelTool = TOOLS.find((t) => t.name === "cancel_deployment")!;

    const ctx = makeCtx({ config: { ...makeCtx().config, allowDestructive: true } });
    const result = await cancelTool.handler({ deployment_uuid: "dep456xyz" }, ctx);
    expect(result.status).toBe("error");
    const r = result as any;
    expect(r.error.kind).toBe("confirmation_required");
  });

  it("cancel_deployment dry-runs when dry_run is true", async () => {
    const { TOOLS } = await import("./deploy.js");
    const cancelTool = TOOLS.find((t) => t.name === "cancel_deployment")!;

    const ctx = makeCtx({ config: { ...makeCtx().config, allowDestructive: true } });
    const result = await cancelTool.handler({ deployment_uuid: "dep456xyz", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    const r = result as any;
    expect(r.dry_run).toBe(true);
  });

  it("cancel_deployment cancels a deployment and returns ok when allowed + confirmed", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ deployment_uuid: "dep456xyz", status: "cancelled" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as any;

    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });
    const ctx = makeCtx({ api, config: { ...makeCtx().config, allowDestructive: true } as any });

    const { TOOLS } = await import("./deploy.js");
    const cancelTool = TOOLS.find((t) => t.name === "cancel_deployment")!;
    expect(cancelTool).toBeDefined();

    const result = await cancelTool.handler({ deployment_uuid: "dep456xyz", confirm: true }, ctx);
    expect(result.status).toBe("ok");
    const r = result as any;
    expect(r.deployment_uuid).toBe("dep456xyz");
    expect(r.deployment_status).toBe("cancelled");
  });

  it("cancel_deployment returns error for invalid uuid", async () => {
    const { TOOLS } = await import("./deploy.js");
    const cancelTool = TOOLS.find((t) => t.name === "cancel_deployment")!;
    const result = await cancelTool.handler({ deployment_uuid: "not valid!!" }, makeCtx());
    expect(result.status).toBe("error");
    const r = result as any;
    expect(r.error.kind).toBe("invalid_input");
  });

  it("TOOLS array has exactly the right tool names", async () => {
    const { TOOLS } = await import("./deploy.js");
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["cancel_deployment", "deploy", "deploy_watch", "get_deployments"]);
  });

  it("all deploy tools have tier api", async () => {
    const { TOOLS } = await import("./deploy.js");
    for (const t of TOOLS) {
      expect(t.tier).toBe("api");
    }
  });

  // H2R2 regression: deploy is fenced (code/credential write)
  it("deploy: destructive_blocked when allowDestructive is false", async () => {
    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy")!;
    const result = await tool.handler({ uuid: "app123abc" }, makeCtx());
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("deploy: confirmation_required when allowDestructive=true but no confirm", async () => {
    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy")!;
    const ctx = makeCtx({ config: { ...makeCtx().config, allowDestructive: true } });
    const result = await tool.handler({ uuid: "app123abc" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("deploy: dry_run returns preview without triggering", async () => {
    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy")!;
    const ctx = makeCtx({ config: { ...makeCtx().config, allowDestructive: true } });
    const result = await tool.handler({ uuid: "app123abc", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
  });

  it("deploy: succeeds when allowDestructive=true and confirm=true", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/deploy")) {
        return new Response(JSON.stringify(fakeTriggerResult), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });
    const ctx = makeCtx({ api, config: { ...makeCtx().config, allowDestructive: true } as any });

    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy")!;
    const result = await tool.handler({ uuid: "app123abc", confirm: true }, ctx);
    expect(result.status).toBe("ok");
  });

  // H2R2 regression: deploy_watch is fenced (code/credential write)
  it("deploy_watch: destructive_blocked when allowDestructive is false", async () => {
    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy_watch")!;
    const result = await tool.handler({ uuid: "app123abc" }, makeCtx());
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("destructive_blocked");
  });

  it("deploy_watch: confirmation_required when allowDestructive=true but no confirm", async () => {
    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy_watch")!;
    const ctx = makeCtx({ config: { ...makeCtx().config, allowDestructive: true } });
    const result = await tool.handler({ uuid: "app123abc" }, ctx);
    expect(result.status).toBe("error");
    expect((result as any).error.kind).toBe("confirmation_required");
  });

  it("deploy_watch: dry_run returns preview without triggering", async () => {
    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy_watch")!;
    const ctx = makeCtx({ config: { ...makeCtx().config, allowDestructive: true } });
    const result = await tool.handler({ uuid: "app123abc", dry_run: true }, ctx);
    expect(result.status).toBe("ok");
    expect((result as any).dry_run).toBe(true);
  });

  async function runWatchToStatus(deploymentStatus: string) {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      // /deployments/{uuid} (poll) must be checked before /deploy (trigger).
      if (u.includes("/deployments/")) {
        return new Response(
          JSON.stringify({ id: 1, deployment_uuid: "dep1", status: deploymentStatus }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify([{ message: "queued", resource_uuid: "app1", deployment_uuid: "dep1" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;
    const { CoolifyApiClient } = await import("../../core/api/client.js");
    const api = new CoolifyApiClient({ baseUrl: "http://localhost", token: "1|secret", extraHeaders: {} });
    const ctx = makeCtx({ api, config: { ...makeCtx().config, allowDestructive: true } as any });
    const { TOOLS } = await import("./deploy.js");
    const tool = TOOLS.find((t) => t.name === "deploy_watch")!;
    return tool.handler({ uuid: "app1", confirm: true, _sleep: async () => {} }, ctx);
  }

  it("deploy_watch: returns ok when all deployments finish", async () => {
    const result = await runWatchToStatus("finished");
    expect(result.status).toBe("ok");
  });

  it("deploy_watch: returns partial (not ok) when a deployment is cancelled", async () => {
    const result = await runWatchToStatus("cancelled");
    expect(result.status).toBe("partial");
  });
});
