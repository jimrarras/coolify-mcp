// src/cli/instances.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, join } from "node:path";
import { runInstances } from "./instances.js";

let home: string;
function cap() { const lines: string[] = []; return { out: (l: string) => lines.push(l), text: () => lines.join("\n") }; }
function writeCfg(obj: unknown) { mkdirSync(join(home, ".coolify-mcp"), { recursive: true }); writeFileSync(join(home, ".coolify-mcp", "config.json"), JSON.stringify(obj)); }

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "inst-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("runInstances list", () => {
  it("lists instance names, baseUrls, the default marker, and tier flags — never secrets", async () => {
    writeCfg({ defaultInstance: "prod", instances: {
      prod: { baseUrl: "https://prod", token: "1|secret-prod" },
      stg:  { baseUrl: "https://stg",  token: "${STG}", enableHostOps: true, allowDestructive: true },
    } });
    const c = cap();
    const code = await runInstances([], {}, c.out, { home });
    expect(code).toBe(0);
    const t = c.text();
    expect(t).toContain("prod");
    expect(t).toContain("https://prod");
    expect(t).toContain("stg");
    expect(t).toMatch(/prod.*\*|\*.*prod/);          // default marker on prod
    expect(t).not.toContain("secret-prod");          // never print tokens
    expect(t).not.toContain("${STG}");
  });

  it("'list' action behaves the same as no action", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" } } });
    const c = cap();
    expect(await runInstances(["list"], {}, c.out, { home })).toBe(0);
    expect(c.text()).toContain("a");
  });

  it("describes env-var mode when there is no config file", async () => {
    const c = cap();
    const code = await runInstances([], { COOLIFY_BASE_URL: "https://env-host" }, c.out, { home });
    expect(code).toBe(0);
    expect(c.text()).toMatch(/env|environment/i);
    expect(c.text()).toContain("https://env-host");
  });

  it("honors --config <path> and does not treat the path as the action", async () => {
    const explicit = join(home, "explicit-config.json");
    writeFileSync(explicit, JSON.stringify({ defaultInstance: "x", instances: { x: { baseUrl: "https://explicit", token: "1|s" } } }));
    const c = cap();
    const code = await runInstances(["--config", explicit, "list"], {}, c.out, { home });
    expect(code).toBe(0);
    expect(c.text()).toContain("x");
    expect(c.text()).toContain("https://explicit");
  });

  it("guides to init when there is no config file and no COOLIFY_BASE_URL", async () => {
    const c = cap();
    const code = await runInstances([], {}, c.out, { home });
    expect(code).toBe(0);
    expect(c.text()).toMatch(/coolify-mcp init/);
  });
});

describe("runInstances default", () => {
  function readBack() { return JSON.parse(readFileSync(join(home, ".coolify-mcp", "config.json"), "utf8")); }

  it("sets the default to an existing instance", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" }, b: { baseUrl: "https://b", token: "2|y" } } });
    const c = cap();
    const code = await runInstances(["default", "b"], {}, c.out, { home });
    expect(code).toBe(0);
    expect(readBack().defaultInstance).toBe("b");
  });

  it("errors on an unknown instance name and does not write", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" } } });
    const c = cap();
    const code = await runInstances(["default", "nope"], {}, c.out, { home });
    expect(code).toBe(1);
    expect(c.text()).toMatch(/unknown instance 'nope'/i);
    expect(c.text()).toContain("a");                 // lists known names
    expect(readBack().defaultInstance).toBe("a");    // unchanged
  });

  it("errors when there is no config file", async () => {
    const c = cap();
    const code = await runInstances(["default", "a"], {}, c.out, { home });
    expect(code).toBe(1);
    expect(c.text()).toMatch(/no config file/i);
  });

  it("treats a malformed array 'instances' as empty and errors cleanly", async () => {
    writeCfg({ defaultInstance: "a", instances: [] });
    const c = cap();
    const code = await runInstances(["default", "a"], {}, c.out, { home });
    expect(code).toBe(1);
    expect(c.text()).toMatch(/unknown instance 'a'/i);
  });
});

describe("runInstances rm", () => {
  function readBack() { return JSON.parse(readFileSync(pjoin(home, ".coolify-mcp", "config.json"), "utf8")); }

  it("removes a non-default instance", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" }, b: { baseUrl: "https://b", token: "2|y" } } });
    const c = cap();
    expect(await runInstances(["rm", "b"], {}, c.out, { home })).toBe(0);
    expect(Object.keys(readBack().instances)).toEqual(["a"]);
    expect(readBack().defaultInstance).toBe("a");
  });

  it("refuses to remove the only instance", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" } } });
    const c = cap();
    expect(await runInstances(["rm", "a"], {}, c.out, { home })).toBe(1);
    expect(c.text()).toMatch(/at least one|only instance/i);
    expect(Object.keys(readBack().instances)).toEqual(["a"]);   // unchanged
    expect(existsSync(pjoin(home, ".coolify-mcp", "config.json.bak"))).toBe(false);
  });

  it("auto-promotes the lone survivor when removing the default", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: { baseUrl: "https://a", token: "1|x" }, b: { baseUrl: "https://b", token: "2|y" } } });
    const c = cap();
    expect(await runInstances(["rm", "a"], {}, c.out, { home })).toBe(0);
    const back = readBack();
    expect(Object.keys(back.instances)).toEqual(["b"]);
    expect(back.defaultInstance).toBe("b");
    expect(c.text()).toMatch(/default.*b|b.*default/i);
  });

  it("refuses to remove the default when several remain (and does not write)", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: {}, b: {}, c: {} } });
    const c = cap();
    expect(await runInstances(["rm", "a"], {}, c.out, { home })).toBe(1);
    expect(c.text()).toMatch(/set a new default first|instances default/i);
    expect(Object.keys(readBack().instances).sort()).toEqual(["a", "b", "c"]);  // unchanged
    expect(existsSync(pjoin(home, ".coolify-mcp", "config.json.bak"))).toBe(false);
  });

  it("errors on an unknown name", async () => {
    writeCfg({ defaultInstance: "a", instances: { a: {}, b: {} } });
    const c = cap();
    expect(await runInstances(["rm", "zzz"], {}, c.out, { home })).toBe(1);
    expect(c.text()).toMatch(/unknown instance 'zzz'/i);
  });
});

function readCfg(): Record<string, any> {
  return JSON.parse(readFileSync(join(home, ".coolify-mcp", "config.json"), "utf8"));
}
const BASE = {
  defaultInstance: "prod",
  customTopLevel: { keep: "me" },
  instances: {
    prod: { baseUrl: "https://prod", token: "1|prodsecretvalue", allowDestructive: false, extra: "keepme" },
    stg: { baseUrl: "https://stg", token: "${STG_TOKEN}" },
  },
};

describe("runInstances set", () => {
  it("sets a boolean field, prints old -> new, preserves everything else", async () => {
    writeCfg(BASE);
    const c = cap();
    const code = await runInstances(["set", "prod", "allowDestructive", "true", "--no-verify"], {}, c.out, { home });
    expect(code).toBe(0);
    expect(c.text()).toMatch(/allowDestructive.*false.*true|allowDestructive.*off.*on/);
    const cfg = readCfg();
    expect(cfg.instances.prod.allowDestructive).toBe(true);
    expect(cfg.instances.prod.extra).toBe("keepme");        // unknown instance fields survive
    expect(cfg.customTopLevel).toEqual({ keep: "me" });     // unknown top-level fields survive
    expect(cfg.instances.stg.token).toBe("${STG_TOKEN}");   // other instances untouched, refs verbatim
  });

  it("redacts secrets in the change output", async () => {
    writeCfg(BASE);
    const c = cap();
    const code = await runInstances(["set", "prod", "token", "2|newsecretvalue99", "--no-verify"], {}, c.out, { home });
    expect(code).toBe(0);
    expect(c.text()).not.toContain("newsecretvalue99");
    expect(c.text()).not.toContain("prodsecretvalue");
    expect(c.text()).toContain("2|****");
    expect(readCfg().instances.prod.token).toBe("2|newsecretvalue99");
  });

  it("prompts masked when the value is omitted for a secret field", async () => {
    writeCfg(BASE);
    const c = cap();
    const io = { promptMasked: async (_q: string) => "3|promptedsecret42" };
    const code = await runInstances(["set", "prod", "token", "--no-verify"], {}, c.out, { home, io: io as any });
    expect(code).toBe(0);
    expect(readCfg().instances.prod.token).toBe("3|promptedsecret42");
  });

  it("errors on an unknown instance and on an unknown field", async () => {
    writeCfg(BASE);
    const c1 = cap();
    expect(await runInstances(["set", "nope", "baseUrl", "https://x", "--no-verify"], {}, c1.out, { home })).toBe(1);
    expect(c1.text()).toMatch(/[Uu]nknown instance/);
    const c2 = cap();
    expect(await runInstances(["set", "prod", "bogusField", "x", "--no-verify"], {}, c2.out, { home })).toBe(1);
    expect(c2.text()).toContain("baseUrl"); // error lists valid fields
  });

  it("rejects an invalid value and leaves the file unchanged", async () => {
    writeCfg(BASE);
    const c = cap();
    expect(await runInstances(["set", "prod", "baseUrl", "ftp://nope", "--no-verify"], {}, c.out, { home })).toBe(1);
    expect(readCfg().instances.prod.baseUrl).toBe("https://prod");
  });

  it("runs verification by default and reports success", async () => {
    writeCfg(BASE);
    const c = cap();
    let called: any = null;
    const verify = async (name: string, inst: Record<string, unknown>, opts: { sshChanged: boolean }) => {
      called = { name, inst, opts };
      return { ok: true as const, detail: "API ok (Coolify 4.1.2)" };
    };
    const code = await runInstances(["set", "prod", "allowDestructive", "on"], {}, c.out, { home, verify });
    expect(code).toBe(0);
    expect(called.name).toBe("prod");
    expect(called.opts.sshChanged).toBe(false);
    expect(c.text()).toContain("API ok");
  });

  it("keeps the write on verification failure, exits 1, and names the .bak", async () => {
    writeCfg(BASE);
    const c = cap();
    const verify = async () => ({ ok: false as const, detail: "connect ETIMEDOUT" });
    const code = await runInstances(["set", "prod", "baseUrl", "https://newhost"], {}, c.out, { home, verify });
    expect(code).toBe(1);
    expect(readCfg().instances.prod.baseUrl).toBe("https://newhost"); // write kept
    expect(c.text()).toContain(".bak");
    expect(c.text()).toContain("connect ETIMEDOUT");
  });

  it("flags sshChanged for ssh fields", async () => {
    writeCfg({ ...BASE, instances: { ...BASE.instances, prod: { ...BASE.instances.prod, ssh: { keyPath: "/k" } } } });
    let opts: any = null;
    const verify = async (_n: string, _i: unknown, o: { sshChanged: boolean }) => { opts = o; return { ok: true as const, detail: "ok" }; };
    await runInstances(["set", "prod", "ssh.host", "203.0.113.5"], {}, cap().out, { home, verify });
    expect(opts.sshChanged).toBe(true);
  });
});

describe("runInstances unset", () => {
  it("removes an optional field and a whole block", async () => {
    writeCfg({ ...BASE, instances: { ...BASE.instances, prod: { ...BASE.instances.prod, pinnedCoolifyVersion: "4.0.0", ssh: { keyPath: "/k", host: "1.2.3.4" } } } });
    const c = cap();
    expect(await runInstances(["unset", "prod", "pinnedCoolifyVersion", "--no-verify"], {}, c.out, { home })).toBe(0);
    expect(await runInstances(["unset", "prod", "ssh", "--no-verify"], {}, cap().out, { home })).toBe(0);
    const cfg = readCfg();
    expect(cfg.instances.prod.pinnedCoolifyVersion).toBeUndefined();
    expect(cfg.instances.prod.ssh).toBeUndefined();
  });

  it("refuses to unset required fields", async () => {
    writeCfg(BASE);
    const c = cap();
    expect(await runInstances(["unset", "prod", "token", "--no-verify"], {}, c.out, { home })).toBe(1);
    expect(readCfg().instances.prod.token).toBe("1|prodsecretvalue");
  });
});

describe("runInstances list (rich output)", () => {
  it("shows the config path, aligned columns, and ssh/db/env-ref indicators", async () => {
    writeCfg({ defaultInstance: "prod", instances: {
      prod: { baseUrl: "https://prod.example.com", token: "1|s", enableHostOps: true, ssh: { keyPath: "/k" }, db: { readonlyUser: "ro" } },
      stg: { baseUrl: "https://stg.example.com", token: "${STG_TOKEN}" },
    } });
    const c = cap();
    expect(await runInstances(["list"], {}, c.out, { home })).toBe(0);
    const t = c.text();
    expect(t).toContain(join(home, ".coolify-mcp", "config.json")); // where the config lives
    const prodLine = t.split("\n").find((l) => l.includes("prod.example.com"))!;
    const stgLine = t.split("\n").find((l) => l.includes("stg.example.com"))!;
    expect(prodLine).toMatch(/ssh:./);
    expect(prodLine).toMatch(/db:./);
    expect(stgLine).toMatch(/env-refs/);        // stg uses ${ENV} for its token
    expect(prodLine).not.toMatch(/env-refs/);   // prod does not
    // columns align: baseUrl starts at the same offset on both lines
    expect(prodLine.indexOf("https://")).toBe(stgLine.indexOf("https://"));
  });
});

describe("runInstances edit", () => {
  async function runEdit(answers: string[], verify?: any, cfgOverride?: any) {
    const { makeScriptedIO } = await import("./io.js");
    writeCfg(cfgOverride ?? BASE);
    const io = makeScriptedIO(answers);
    const c = cap();
    const v = verify ?? (async () => ({ ok: true, detail: "API ok" }));
    const code = await runInstances(["edit", "prod"], {}, c.out, { home, io: io as any, verify: v });
    return { code, io, text: c.text() };
  }

  it("Enter keeps every current value and reports no changes (no write, no backup)", async () => {
    const r = await runEdit(["", "", "", "", "", ""]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/[Nn]o changes/);
    expect(existsSync(join(home, ".coolify-mcp", "config.json.bak"))).toBe(false);
    expect(readCfg().instances.prod.token).toBe("1|prodsecretvalue");
  });

  it("toggles allowDestructive and writes, with a redacted change summary", async () => {
    // prompts: baseUrl(keep) token(keep) enableHostOps(keep) allowDestructive(y) addSsh(no) addDb(no)
    const r = await runEdit(["", "", "", "y", "", ""]);
    expect(r.code).toBe(0);
    expect(readCfg().instances.prod.allowDestructive).toBe(true);
    expect(r.text).toMatch(/allowDestructive.*false.*true|allowDestructive.*off.*on/);
    expect(r.text).not.toContain("prodsecretvalue");
  });

  it("rotates the token via masked prompt and pre-verifies before writing", async () => {
    let verified: any = null;
    const verify = async (name: string, inst: any, _opts: any) => { verified = { name, token: inst.token }; return { ok: true, detail: "API ok" }; };
    const r = await runEdit(["", "9|rotatedsecret99", "", "", "", ""], verify);
    expect(r.code).toBe(0);
    expect(verified.token).toBe("9|rotatedsecret99");   // verified the NEW value
    expect(readCfg().instances.prod.token).toBe("9|rotatedsecret99");
    expect(r.text).not.toContain("rotatedsecret99");    // redacted in output
  });

  it("aborts without writing when verification of changed credentials fails", async () => {
    const verify = async () => ({ ok: false, detail: "401 unauthorized" });
    const r = await runEdit(["https://newurl.example.com", "", "", "", "", ""], verify);
    expect(r.code).toBe(1);
    expect(r.text).toContain("401 unauthorized");
    expect(readCfg().instances.prod.baseUrl).toBe("https://prod"); // unchanged
  });

  it("keeps a ${ENV} token when Enter is pressed (never inlines)", async () => {
    const cfg = { defaultInstance: "prod", instances: { prod: { baseUrl: "https://prod", token: "${PROD_TOKEN}" } } };
    const r = await runEdit(["", "", "", "", "", ""], undefined, cfg);
    expect(r.code).toBe(0);
    expect(readCfg().instances.prod.token).toBe("${PROD_TOKEN}");
  });

  it("edits ssh fields when the block exists and flags sshChanged to the verifier", async () => {
    const cfg = { defaultInstance: "prod", instances: { prod: { baseUrl: "https://prod", token: "1|t", ssh: { keyPath: "/old/key" } } } };
    let opts: any = null;
    const verify = async (_n: string, _i: any, o: any) => { opts = o; return { ok: true, detail: "ok" }; };
    // prompts: baseUrl token hostOps destructive editSsh(y) keyPath host hostServer user port fingerprint passphrase addDb(no)
    const r = await runEdit(["", "", "", "", "y", "/new/key", "", "", "", "", "", "", ""], verify, cfg);
    expect(r.code).toBe(0);
    expect(opts.sshChanged).toBe(true);
    expect(readCfg().instances.prod.ssh.keyPath).toBe("/new/key");
  });
});
