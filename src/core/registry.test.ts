// src/core/registry.test.ts
import { describe, it, expect } from "vitest";
import { InstanceRegistry } from "./registry.js";
import type { AppConfig } from "./config/schema.js";

const cfg: AppConfig = {
  defaultInstance: "prod",
  instances: {
    prod: { name: "prod", baseUrl: "https://p", token: "1|s", extraHeaders: {}, enableHostOps: false, allowDestructive: false },
    staging: { name: "staging", baseUrl: "https://s", token: "2|s", extraHeaders: {}, enableHostOps: false, allowDestructive: false },
  },
};

describe("InstanceRegistry", () => {
  it("returns the default instance when no name is given", () => {
    const r = new InstanceRegistry(cfg);
    expect(r.get().name).toBe("prod");
    expect(r.defaultName()).toBe("prod");
    expect(r.names().sort()).toEqual(["prod", "staging"]);
  });
  it("returns a named instance", () => {
    expect(new InstanceRegistry(cfg).get("staging").config.baseUrl).toBe("https://s");
  });
  it("caches the resolved instance (same api object)", () => {
    const r = new InstanceRegistry(cfg);
    expect(r.get("prod").api).toBe(r.get("prod").api);
  });
  it("throws invalid_input listing known names on unknown instance", () => {
    expect(() => new InstanceRegistry(cfg).get("nope")).toThrow(/prod.*staging|staging.*prod/);
  });
  it("hostOps thunk rejects with host_ops_disabled when instance has host-ops off", async () => {
    const r = new InstanceRegistry(cfg);
    await expect(r.get("prod").hostOps()).rejects.toMatchObject({ kind: "host_ops_disabled" });
  });
});
