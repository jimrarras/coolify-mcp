import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveConfigPath } from "./path.js";

describe("resolveConfigPath", () => {
  const home = "/home/u";
  const def = join(home, ".coolify-mcp", "config.json");

  it("defaults to <home>/.coolify-mcp/config.json", () => {
    expect(resolveConfigPath([], {}, home)).toBe(def);
  });
  it("uses COOLIFY_CONFIG when set", () => {
    expect(resolveConfigPath([], { COOLIFY_CONFIG: "/etc/c.json" }, home)).toBe("/etc/c.json");
  });
  it("prefers --config over COOLIFY_CONFIG and the default", () => {
    expect(resolveConfigPath(["--config", "/flag.json"], { COOLIFY_CONFIG: "/env.json" }, home)).toBe("/flag.json");
  });
  it("ignores a trailing --config with no value", () => {
    expect(resolveConfigPath(["--config"], {}, home)).toBe(def);
  });
});
