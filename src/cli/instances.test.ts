// src/cli/instances.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
