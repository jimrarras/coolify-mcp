// Barrel smoke-tests: verify that src/core/config.ts re-exports the full public API
// from the config/* sub-modules. Detailed behavioral tests are in config/load.test.ts
// and config/schema.test.ts.
import { describe, it, expect } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, validateAppConfig, type AppConfig, type InstanceConfig } from "./config.js";

// A home dir that does not exist, so env-fallback isn't contaminated by a real
// ~/.coolify-mcp/config.json on the developer's machine.
const NO_HOME = join(tmpdir(), "coolify-mcp-no-such-home");

describe("config barrel re-exports", () => {
  it("loadConfig is a function", () => {
    expect(typeof loadConfig).toBe("function");
  });

  it("validateAppConfig is a function", () => {
    expect(typeof validateAppConfig).toBe("function");
  });

  it("loadConfig produces an AppConfig with instances + defaultInstance", () => {
    const cfg: AppConfig = loadConfig([], { COOLIFY_BASE_URL: "https://example.com", COOLIFY_TOKEN: "1|secret" }, { home: NO_HOME });
    expect(cfg.defaultInstance).toBe("default");
    expect(cfg.instances.default.baseUrl).toBe("https://example.com");
  });

  it("InstanceConfig has the expected shape (type check via runtime properties)", () => {
    const cfg = loadConfig([], { COOLIFY_BASE_URL: "https://example.com", COOLIFY_TOKEN: "1|secret" }, { home: NO_HOME });
    const inst: InstanceConfig = cfg.instances.default;
    expect(inst.name).toBe("default");
    expect(inst.enableHostOps).toBe(false);
    expect(inst.allowDestructive).toBe(false);
    expect(inst.extraHeaders).toEqual({});
  });
});
