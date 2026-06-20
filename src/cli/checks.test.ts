import { describe, it, expect, vi } from "vitest";
import { checkApi, checkControlHost, checkSsh, checkDbRole, runAllChecks } from "./checks.js";
import { CoolifyError } from "../core/errors.js";

const apiStub = (over: Partial<{ health: () => Promise<unknown>; version: () => Promise<string> }>) =>
  ({ health: over.health ?? (async () => "OK"), version: over.version ?? (async () => "4.1.2") }) as never;

describe("checkApi", () => {
  it("ok with version when health+version succeed", async () => {
    const r = await checkApi(apiStub({}));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("4.1.2");
  });

  it("fail with scope fix on auth error", async () => {
    const api = apiStub({ health: async () => { throw new CoolifyError("auth", "HTTP 401"); } });
    const r = await checkApi(api);
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/read:sensitive/);
  });

  it("fail with reachability fix on other errors", async () => {
    const api = apiStub({ health: async () => { throw new Error("ECONNREFUSED"); } });
    const r = await checkApi(api);
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/COOLIFY_BASE_URL/);
  });
});

describe("checkControlHost", () => {
  it("skips when host-ops disabled", async () => {
    const r = await checkControlHost({ resolveControlHost: vi.fn() }, "https://h", false);
    expect(r.status).toBe("skip");
  });

  it("ok and reports the resolved host", async () => {
    const resolver = { resolveControlHost: vi.fn(async () => ({ serverUuid: "s", host: "coolify.example.com", user: "root", port: 22 })) };
    const r = await checkControlHost(resolver, "https://coolify.example.com", true);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("root@coolify.example.com:22");
  });

  it("fail with hostServer fix when resolution throws", async () => {
    const resolver = { resolveControlHost: vi.fn(async () => { throw new Error("ambiguous"); }) };
    const r = await checkControlHost(resolver, "https://h", true);
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/ssh\.hostServer/);
  });
});

describe("checkSsh", () => {
  const ch = { serverUuid: "s", host: "h", user: "root", port: 22 };

  it("skips when host-ops disabled", async () => {
    expect((await checkSsh(ch, { keyPath: "/k" }, vi.fn(), false)).status).toBe("skip");
  });
  it("fail when no keyPath", async () => {
    const r = await checkSsh(ch, undefined, vi.fn(), true);
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/ssh\.keyPath/);
  });
  it("ok when probe resolves", async () => {
    const r = await checkSsh(ch, { keyPath: "/k" }, async () => {}, true);
    expect(r.status).toBe("ok");
  });
  it("classifies auth failure", async () => {
    const r = await checkSsh(ch, { keyPath: "/k" }, async () => { throw new Error("All configured authentication methods failed"); }, true);
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/authorized/i);
  });
  it("classifies host-key mismatch", async () => {
    const r = await checkSsh(ch, { keyPath: "/k" }, async () => { throw new Error("hostVerifier rejected host key"); }, true);
    expect(r.fix).toMatch(/fingerprint|known_hosts/i);
  });
  it("classifies encrypted-key passphrase need", async () => {
    const r = await checkSsh(ch, { keyPath: "/k" }, async () => { throw new Error("Encrypted private key detected, but no passphrase given"); }, true);
    expect(r.fix).toMatch(/passphrase/i);
  });
  it("classifies PuTTY .ppk format", async () => {
    const r = await checkSsh(ch, { keyPath: "/k.ppk" }, async () => { throw new Error("Cannot parse privateKey: Unsupported key format"); }, true);
    expect(r.fix).toMatch(/PuTTY|OpenSSH/i);
  });
  it("classifies a generic unreachable error", async () => {
    const r = await checkSsh(ch, { keyPath: "/k" }, async () => { throw new Error("connect ETIMEDOUT 1.2.3.4:22"); }, true);
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/reachable|port/i);
  });
});

describe("checkDbRole", () => {
  it("skips when no db.readonlyUser", async () => {
    const inst = { config: { enableHostOps: true, db: undefined }, hostOps: vi.fn() } as never;
    expect((await checkDbRole(inst, true)).status).toBe("skip");
  });
  it("ok when SELECT 1 works", async () => {
    const inst = { config: { db: { readonlyUser: "ro" } }, hostOps: async () => ({ psqlReadOnly: async () => "1" }) } as never;
    expect((await checkDbRole(inst, true)).status).toBe("ok");
  });
  it("fail with role fix when query throws", async () => {
    const inst = { config: { db: { readonlyUser: "ro" } }, hostOps: async () => ({ psqlReadOnly: async () => { throw new Error("role does not exist"); } }) } as never;
    const r = await checkDbRole(inst, true);
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/role|README/i);
  });
});

describe("runAllChecks", () => {
  it("runs api+control_host+ssh+db_role in order", async () => {
    const inst = {
      name: "default",
      config: { baseUrl: "https://h", enableHostOps: false, db: undefined, ssh: undefined },
      api: { health: async () => "OK", version: async () => "4.1.2" },
      resolver: { resolveControlHost: vi.fn() },
      hostOps: vi.fn(),
    } as never;
    const names = (await runAllChecks(inst, async () => {})).map((r) => r.name);
    expect(names).toEqual(["api", "control_host", "ssh", "db_role"]);
  });
});
