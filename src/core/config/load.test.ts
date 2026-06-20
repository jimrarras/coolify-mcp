import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./load.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "coolify-cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig env fallback", () => {
  // Isolate the home dir (the fresh temp `dir` has no .coolify-mcp/config.json) so the
  // env-fallback path is exercised regardless of any real ~/.coolify-mcp/config.json.
  it("synthesizes a 'default' instance from env when no file", () => {
    const cfg = loadConfig([], { COOLIFY_BASE_URL: "https://h", COOLIFY_TOKEN: "1|s" }, { home: dir });
    expect(cfg.defaultInstance).toBe("default");
    expect(cfg.instances.default.baseUrl).toBe("https://h");
    expect(cfg.instances.default.enableHostOps).toBe(false);
  });
  it("maps --enable-host-ops + legacy SSH/DB env onto the default instance", () => {
    const cfg = loadConfig(["--enable-host-ops", "--allow-destructive"], {
      COOLIFY_BASE_URL: "https://h", COOLIFY_TOKEN: "1|s",
      COOLIFY_SSH_KEY_PATH: "/k", COOLIFY_SSH_KNOWN_HOST_FINGERPRINT: "SHA256:x",
      COOLIFY_SSH_HOST: "203.0.113.5", COOLIFY_SSH_HOST_SERVER: "primary",
      COOLIFY_DB_READONLY_USER: "ro",
    }, { home: dir });
    const i = cfg.instances.default;
    expect(i.enableHostOps).toBe(true);
    expect(i.allowDestructive).toBe(true);
    expect(i.ssh?.keyPath).toBe("/k");
    expect(i.ssh?.fingerprint).toBe("SHA256:x");
    expect(i.ssh?.host).toBe("203.0.113.5");
    expect(i.ssh?.hostServer).toBe("primary");
    expect(i.db?.readonlyUser).toBe("ro");
  });
  it("throws when neither file nor COOLIFY_BASE_URL present", () => {
    expect(() => loadConfig([], {}, { home: dir })).toThrow(/COOLIFY_BASE_URL/);
  });
  it("rejects a token whose id segment is not an integer", () => {
    expect(() => loadConfig([], { COOLIFY_BASE_URL: "https://h", COOLIFY_TOKEN: "abc|secret" }, { home: dir }))
      .toThrow(/<id>\|<secret>/);
  });
  it("accepts a well-formed '<int>|<secret>' token", () => {
    const cfg = loadConfig([], { COOLIFY_BASE_URL: "https://h", COOLIFY_TOKEN: "42|sk_abc" }, { home: dir });
    expect(cfg.instances.default.token).toBe("42|sk_abc");
  });
});

describe("loadConfig file mode", () => {
  it("loads a config file via --config and expands ${ENV}", () => {
    const p = join(dir, "c.json");
    writeFileSync(p, JSON.stringify({ defaultInstance: "prod", instances: {
      prod: { baseUrl: "https://p", token: "${T}" }, staging: { baseUrl: "https://s", token: "2|s" } } }));
    const cfg = loadConfig(["--config", p], { T: "9|sec" });
    expect(cfg.instances.prod.token).toBe("9|sec");
    expect(Object.keys(cfg.instances).sort()).toEqual(["prod", "staging"]);
  });
  it("warns (does not throw) and ignores --enable-host-ops when a file is loaded", () => {
    const p = join(dir, "c.json");
    writeFileSync(p, JSON.stringify({ instances: { only: { baseUrl: "https://h", token: "1|s", enableHostOps: false } } }));
    const cfg = loadConfig(["--config", p, "--enable-host-ops"], {});
    expect(cfg.instances.only.enableHostOps).toBe(false); // file wins; flag ignored
  });
});
