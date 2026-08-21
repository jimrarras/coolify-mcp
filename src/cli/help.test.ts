import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helpText, getVersion } from "./help.js";

describe("helpText", () => {
  it("top-level help covers subcommands, server flags, and config precedence", () => {
    const h = helpText();
    for (const s of ["init", "doctor", "instances", "--enable-host-ops", "--allow-destructive", "--config", "--help", "--version"]) {
      expect(h).toContain(s);
    }
    expect(h).toMatch(/COOLIFY_CONFIG|config\.json/);
    expect(h).toMatch(/[Ee]xamples?/);
  });
  it("instances help documents set/unset/edit with fields", () => {
    const h = helpText("instances");
    for (const s of ["list", "default", "rm", "set", "unset", "edit", "allowDestructive", "--no-verify"]) {
      expect(h).toContain(s);
    }
  });
  it("init help documents --env-secrets", () => {
    expect(helpText("init")).toContain("--env-secrets");
  });
  it("doctor help exists", () => {
    expect(helpText("doctor")).toMatch(/check|verif/i);
  });
  it("unknown topic falls back to top-level help", () => {
    expect(helpText("bogus" as never)).toContain("init");
  });
});

describe("getVersion", () => {
  it("matches the version in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
    expect(getVersion()).toBe(pkg.version);
  });
});
