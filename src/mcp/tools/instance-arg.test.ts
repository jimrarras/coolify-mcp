// src/mcp/tools/instance-arg.test.ts
import { describe, it, expect } from "vitest";
import { TOOLS as deployTools } from "./deploy.js";
import { TOOLS as resourceTools } from "./resources.js";
import { TOOLS as envTools } from "./env.js";
import { TOOLS as logTools } from "./logs.js";
import { TOOLS as serverTools } from "./servers.js";
import { TOOLS as projectTools } from "./projects.js";
import { TOOLS as hostTools } from "./host.js";
import { dispatch } from "../dispatch.js";

const all = [...deployTools, ...resourceTools, ...envTools, ...logTools, ...serverTools, ...projectTools, ...hostTools];

describe("instance selector", () => {
  it("every tool exposes an optional 'instance' string and never requires it", () => {
    for (const t of all) {
      const props = (t.inputSchema as any).properties ?? {};
      expect(props.instance, `${t.name} missing instance`).toMatchObject({ type: "string" });
      const req = (t.inputSchema as any).required ?? [];
      expect(req).not.toContain("instance");
    }
  });
});

// Per-instance gating test (A allows, B blocks the same delete)
const delResource = all.find((t) => t.name === "delete_resource")!;
function reg() {
  const mk = (allowDestructive: boolean) => ({
    name: "x", config: { name: "x", baseUrl: "https://x", enableHostOps: false, allowDestructive },
    api: { applications: { delete: async () => ({ message: "deleted" }) } }, resolver: {}, hostOps: async () => ({}),
  });
  const map: Record<string, any> = { prod: mk(false), staging: mk(true) };
  return { names: () => Object.keys(map), defaultName: () => "prod", get: (n?: string) => map[n ?? "prod"] } as any;
}
it("destructive op blocked on prod (allowDestructive:false) but permitted on staging", async () => {
  const blocked = await dispatch("delete_resource", { type: "applications", uuid: "abc123", confirm: true }, [delResource], reg());
  expect(JSON.parse(blocked.content[0].text)).toMatchObject({ status: "error", error: { kind: "destructive_blocked" } });
  const ok = await dispatch("delete_resource", { instance: "staging", type: "applications", uuid: "abc123", confirm: true }, [delResource], reg());
  expect(JSON.parse(ok.content[0].text).status).toBe("ok");
});
