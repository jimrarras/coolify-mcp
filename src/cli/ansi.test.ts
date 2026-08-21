import { describe, it, expect } from "vitest";
import { makePalette, colorEnabled } from "./ansi.js";

const ESC = String.fromCharCode(27);

describe("makePalette", () => {
  it("wraps text in ANSI codes when enabled", () => {
    const c = makePalette(true);
    expect(c.green("ok")).toBe(`${ESC}[32mok${ESC}[39m`);
    expect(c.red("bad")).toBe(`${ESC}[31mbad${ESC}[39m`);
    expect(c.yellow("warn")).toBe(`${ESC}[33mwarn${ESC}[39m`);
    expect(c.bold("head")).toBe(`${ESC}[1mhead${ESC}[22m`);
    expect(c.dim("meta")).toBe(`${ESC}[2mmeta${ESC}[22m`);
  });

  it("passes text through untouched when disabled", () => {
    const c = makePalette(false);
    expect(c.green("ok")).toBe("ok");
    expect(c.red("bad")).toBe("bad");
    expect(c.yellow("warn")).toBe("warn");
    expect(c.bold("head")).toBe("head");
    expect(c.dim("meta")).toBe("meta");
  });
});

describe("colorEnabled", () => {
  it("is off when NO_COLOR is set, regardless of TTY", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(false); // NO_COLOR spec: presence, not value
  });

  it("is off when stdout is not a TTY", () => {
    expect(colorEnabled({}, false)).toBe(false);
  });

  it("is on for a TTY without NO_COLOR", () => {
    expect(colorEnabled({}, true)).toBe(true);
  });
});

describe("paintLine", () => {
  it("colorizes doctor statuses, checkmark markers, and error prefixes", async () => {
    const { paintLine } = await import("./ansi.js");
    const c = makePalette(true);
    expect(paintLine("PASS  api — ok", c)).toBe(`${c.green("PASS")}  api — ok`);
    expect(paintLine("FAIL  ssh — nope", c)).toBe(`${c.red("FAIL")}  ssh — nope`);
    expect(paintLine("WARN  x — y", c)).toBe(`${c.yellow("WARN")}  x — y`);
    expect(paintLine("SKIP  db_role — not configured", c)).toBe(`${c.dim("SKIP")}  db_role — not configured`);
    expect(paintLine("✓ verified 'prod'", c)).toBe(`${c.green("✓")} verified 'prod'`);
    expect(paintLine("✗ could not authenticate", c)).toBe(`${c.red("✗")} could not authenticate`);
    expect(paintLine("⚠ verification failed", c)).toBe(`${c.yellow("⚠")} verification failed`);
    expect(paintLine("error: bad input", c)).toBe(`${c.red("error:")} bad input`);
  });
  it("leaves ordinary lines and indented continuations untouched", async () => {
    const { paintLine } = await import("./ansi.js");
    const c = makePalette(true);
    expect(paintLine("instances (* = default):", c)).toBe("instances (* = default):");
    expect(paintLine("        fix: do the thing", c)).toBe("        fix: do the thing");
  });
  it("is the identity when color is disabled", async () => {
    const { paintLine } = await import("./ansi.js");
    const c = makePalette(false);
    expect(paintLine("PASS  api — ok", c)).toBe("PASS  api — ok");
  });
});
