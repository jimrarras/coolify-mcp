import { describe, it, expect } from "vitest";
import { buildConfigObject, generateDbRoleSql, generatePassword, isValidDbRoleName, runInitFlow } from "./init.js";
import { makeScriptedIO } from "./io.js";

describe("buildConfigObject", () => {
  const full = {
    instanceName: "default", baseUrl: "https://h", enableHostOps: true, token: "1|secret",
    ssh: { keyPath: "/k", hostServer: "srv1", host: "1.2.3.4", passphrase: "pp", fingerprint: "SHA256:x" },
    db: { readonlyUser: "coolify_ro", readonlyPassword: "dbpw" },
  };

  it("inlines the actual secret values by default (envSecrets:false)", () => {
    const cfg = JSON.stringify(buildConfigObject({ ...full, envSecrets: false }));
    expect(cfg).toContain('"token":"1|secret"');
    expect(cfg).toContain('"passphrase":"pp"');
    expect(cfg).toContain('"readonlyPassword":"dbpw"');
    expect(cfg).not.toContain("${COOLIFY_TOKEN}");
  });

  it("uses ${ENV} refs with no literal secrets when envSecrets:true", () => {
    const cfg = JSON.stringify(buildConfigObject({ ...full, envSecrets: true }));
    expect(cfg).toContain("${COOLIFY_TOKEN}");
    expect(cfg).toContain("${COOLIFY_SSH_KEY_PASSPHRASE}");
    expect(cfg).toContain("${COOLIFY_DB_RO_PASSWORD}");
    expect(cfg).not.toContain("1|secret");
    expect(cfg).not.toContain('"pp"');
  });

  it("omits ssh/db blocks when not configured", () => {
    const obj = buildConfigObject({ instanceName: "default", baseUrl: "https://h", enableHostOps: false, envSecrets: false, token: "1|s" }) as { instances: Record<string, { ssh?: unknown; db?: unknown; enableHostOps: boolean }> };
    const inst = obj.instances.default;
    expect(inst.enableHostOps).toBe(false);
    expect(inst.ssh).toBeUndefined();
    expect(inst.db).toBeUndefined();
  });

  it("omits ssh.passphrase when the key has no passphrase", () => {
    const obj = buildConfigObject({ instanceName: "default", baseUrl: "https://h", enableHostOps: true, envSecrets: false, token: "1|s", ssh: { keyPath: "/k" } }) as { instances: Record<string, { ssh: Record<string, unknown> }> };
    expect(obj.instances.default.ssh.passphrase).toBeUndefined();
  });
});

describe("generateDbRoleSql", () => {
  it("includes CREATE ROLE, GRANT SELECT, REVOKE EXECUTE", () => {
    const sql = generateDbRoleSql("coolify_ro", "pw123");
    expect(sql).toMatch(/CREATE ROLE coolify_ro/);
    expect(sql).toMatch(/GRANT SELECT/);
    expect(sql).toMatch(/REVOKE EXECUTE/);
    expect(sql).toContain("pw123");
  });
  it("throws on an unsafe role name (export-safety)", () => {
    expect(() => generateDbRoleSql("ro; DROP TABLE x", "pw")).toThrow(/invalid DB role name/);
  });
});

describe("isValidDbRoleName", () => {
  it("accepts valid identifiers and rejects unsafe ones", () => {
    expect(isValidDbRoleName("coolify_ro")).toBe(true);
    expect(isValidDbRoleName("_x9")).toBe(true);
    expect(isValidDbRoleName("9bad")).toBe(false);
    expect(isValidDbRoleName("ro; DROP")).toBe(false);
    expect(isValidDbRoleName("ro'")).toBe(false);
    expect(isValidDbRoleName("")).toBe(false);
  });
});

describe("generatePassword", () => {
  it("returns a 32-char alphanumeric password", () => {
    const p = generatePassword();
    expect(p).toHaveLength(32);
    expect(p).toMatch(/^[A-Za-z0-9]+$/);
  });
  it("is non-deterministic", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

function deps(answers: string[], over: Partial<Parameters<typeof runInitFlow>[0]> = {}) {
  const io = makeScriptedIO(answers);
  const base = {
    io, env: { COOLIFY_BASE_URL: "https://coolify.example.com", COOLIFY_TOKEN: "1|s" },
    makeApi: () => ({ health: async () => "OK", version: async () => "4.1.2" }),
    resolveControlHost: async () => ({ serverUuid: "srv1", host: "coolify.example.com", user: "root", port: 22 }),
    listServers: async () => [{ uuid: "srv1", name: "localhost" }],
    discoverKey: async () => ({ path: "/home/u/.ssh/id_ed25519", passphrase: "pw" }),
    getFingerprint: async () => "SHA256:abc",
    writeConfig: (_o: unknown) => "/home/u/.coolify-mcp/config.json",
  };
  return { io, deps: { ...base, ...over } as Parameters<typeof runInitFlow>[0] };
}

describe("runInitFlow", () => {
  it("API-only path inlines the token by default and prints the snippet", async () => {
    // answers: baseUrl(enter→default), token(enter→default), instanceName(enter→default), enable host-ops? n
    const written: unknown[] = [];
    const { io, deps: d } = deps(["", "", "", "n"], { writeConfig: (o) => { written.push(o); return "/cfg"; } });
    const code = await runInitFlow(d);
    expect(code).toBe(0);
    const cfg = JSON.stringify(written[0]);
    expect(cfg).toContain('"token":"1|s"'); // inline by default — no env var needed
    expect(cfg).not.toContain("${COOLIFY_TOKEN}");
    expect(cfg).not.toContain("id_ed25519");
    expect(io.printed.join("\n")).toMatch(/no environment variables needed/i);
    expect(io.printed.join("\n")).toMatch(/doctor/);
  });

  it("host-ops path discovers a key, confirms fingerprint, writes ssh block with INLINE passphrase by default", async () => {
    // answers: baseUrl, token, instanceName, host-ops? y, (control host auto since single match), fingerprint confirm y, db? n
    const written: unknown[] = [];
    const { deps: d } = deps(["", "", "", "y", "y", "n"], { writeConfig: (o) => { written.push(o); return "/cfg"; } });
    const code = await runInitFlow(d);
    expect(code).toBe(0);
    const cfg = JSON.stringify(written[0]);
    expect(cfg).toContain("\"keyPath\":\"/home/u/.ssh/id_ed25519\"");
    expect(cfg).toContain("\"passphrase\":\"pw\""); // inline by default
    expect(cfg).not.toContain("${COOLIFY_SSH_KEY_PASSPHRASE}");
    expect(cfg).toContain("SHA256:abc");
  });

  it("--env-secrets mode writes ${ENV} refs and lists the vars to set", async () => {
    const written: unknown[] = [];
    const { io, deps: d } = deps(["", "", "", "n"], { envSecrets: true, writeConfig: (o) => { written.push(o); return "/cfg"; } });
    const code = await runInitFlow(d);
    expect(code).toBe(0);
    const cfg = JSON.stringify(written[0]);
    expect(cfg).toContain("${COOLIFY_TOKEN}");
    expect(cfg).not.toContain('"token":"1|s"');
    expect(io.printed.join("\n")).toMatch(/COOLIFY_TOKEN=1\|s/);
  });

  it("ppk-only stops host-ops with guidance, still writes API config", async () => {
    const { io, deps: d } = deps(["", "", "", "y"], { discoverKey: async () => ({ ppkOnly: true }) });
    const code = await runInitFlow(d);
    expect(code).toBe(0);
    expect(io.printed.join("\n")).toMatch(/puttygen|OpenSSH/i);
  });

  it("skips host-ops gracefully when the picked control host also fails to resolve", async () => {
    // answers: baseUrl, token, instanceName, host-ops? y, then pick a (bad) server
    const written: unknown[] = [];
    const { io, deps: d } = deps(["", "", "", "y", "srv-bad"], {
      resolveControlHost: async () => { throw new Error("unreachable"); },
      listServers: async () => [{ uuid: "srvX", name: "x" }],
      writeConfig: (o) => { written.push(o); return "/cfg"; },
    });
    const code = await runInitFlow(d);
    expect(code).toBe(0); // wizard completes API-only, does not crash
    expect(JSON.stringify(written[0])).not.toContain("\"ssh\"");
    expect(io.printed.join("\n")).toMatch(/skipping host-ops/i);
  });
});

import { runInit } from "./init.js";

describe("runInit (real-deps wiring)", () => {
  it("is exported as a function (argv, env, io?)", () => {
    expect(typeof runInit).toBe("function");
    expect(runInit.length).toBeGreaterThanOrEqual(2);
  });
});
