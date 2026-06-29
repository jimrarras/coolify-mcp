import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRawConfig, writeRawConfig } from "./config-file.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cfgtest-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readRawConfig", () => {
  it("returns null when the file does not exist", () => {
    expect(readRawConfig(join(dir, "nope.json"))).toBeNull();
  });
  it("parses an existing file and preserves ${ENV} refs verbatim", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ defaultInstance: "a", instances: { a: { token: "${COOLIFY_TOKEN}" } } }));
    const raw = readRawConfig(p)!;
    expect(raw.defaultInstance).toBe("a");
    expect((raw.instances!.a as { token: string }).token).toBe("${COOLIFY_TOKEN}");
  });
  it("throws CoolifyError on malformed JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    expect(() => readRawConfig(p)).toThrow(/failed to read\/parse/);
  });
});

describe("writeRawConfig", () => {
  it("creates the file, parent dirs, and writes pretty JSON", () => {
    const p = join(dir, "nested", "config.json");
    writeRawConfig(p, { defaultInstance: "a", instances: { a: {} } });
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).defaultInstance).toBe("a");
  });
  it("backs up an existing file to <path>.bak before overwriting", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ defaultInstance: "old", instances: {} }));
    writeRawConfig(p, { defaultInstance: "new", instances: {} });
    expect(JSON.parse(readFileSync(p + ".bak", "utf8")).defaultInstance).toBe("old");
    expect(JSON.parse(readFileSync(p, "utf8")).defaultInstance).toBe("new");
  });
  it("writes at mode 0600 (POSIX only)", () => {
    if (process.platform === "win32") return; // mode bits not enforced on Windows
    const p = join(dir, "config.json");
    writeRawConfig(p, { instances: {} });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
