import { describe, it, expect } from "vitest";
import { validateAppConfig } from "./schema.js";

const min = { instances: { default: { baseUrl: "https://h", token: "1|s" } } };

describe("validateAppConfig", () => {
  it("fills defaults and defaultInstance for a single instance", () => {
    const cfg = validateAppConfig(min);
    expect(cfg.defaultInstance).toBe("default");
    const i = cfg.instances.default;
    expect(i.enableHostOps).toBe(false);
    expect(i.allowDestructive).toBe(false);
    expect(i.extraHeaders).toEqual({});
    expect(i.name).toBe("default");
  });
  it("throws when instances is missing or empty", () => {
    expect(() => validateAppConfig({})).toThrow(/instances/);
    expect(() => validateAppConfig({ instances: {} })).toThrow(/instances/);
  });
  it("throws when baseUrl or token missing", () => {
    expect(() => validateAppConfig({ instances: { a: { token: "1|s" } } })).toThrow(/baseUrl/);
    expect(() => validateAppConfig({ instances: { a: { baseUrl: "https://h" } } })).toThrow(/token/);
  });
  it("rejects a config-file token that is not <id>|<secret> (parity with the env path)", () => {
    expect(() => validateAppConfig({ instances: { a: { baseUrl: "https://h", token: "garbage" } } })).toThrow(/token/i);
    expect(() => validateAppConfig({ instances: { a: { baseUrl: "https://h", token: "abc|secret" } } })).toThrow(/token/i);
    expect(() => validateAppConfig({ instances: { a: { baseUrl: "https://h", token: "1|" } } })).toThrow(/token/i);
    // a well-formed token is still accepted
    expect(validateAppConfig({ instances: { a: { baseUrl: "https://h", token: "42|sk_abc" } } }).instances.a.token).toBe("42|sk_abc");
  });

  it("throws when defaultInstance names an unknown instance", () => {
    expect(() => validateAppConfig({ defaultInstance: "x", instances: { a: { baseUrl: "https://h", token: "1|s" } } }))
      .toThrow(/default/i);
  });
  it("requires explicit defaultInstance (or a 'default') when multiple instances exist", () => {
    const two = { instances: { a: { baseUrl: "https://a", token: "1|s" }, b: { baseUrl: "https://b", token: "1|s" } } };
    expect(() => validateAppConfig(two)).toThrow(/defaultInstance/);
  });
  it("strips trailing slashes from baseUrl", () => {
    expect(validateAppConfig({ instances: { default: { baseUrl: "https://h/", token: "1|s" } } }).instances.default.baseUrl).toBe("https://h");
  });
  it("parses the optional ssh.host override", () => {
    const cfg = validateAppConfig({ instances: { default: {
      baseUrl: "https://h", token: "1|s",
      ssh: { keyPath: "/k", host: "203.0.113.5", hostServer: "primary" },
    } } });
    expect(cfg.instances.default.ssh?.host).toBe("203.0.113.5");
    expect(cfg.instances.default.ssh?.hostServer).toBe("primary");
  });
});
