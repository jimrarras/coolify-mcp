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
