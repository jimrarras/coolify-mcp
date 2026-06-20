import { describe, it, expect } from "vitest";
import { makeScriptedIO } from "./io.js";

describe("makeScriptedIO", () => {
  it("returns queued answers and records prints", async () => {
    const io = makeScriptedIO(["hello", "y"]);
    expect(await io.prompt("name?")).toBe("hello");
    expect(await io.confirm("ok?")).toBe(true);
    io.print("done");
    expect(io.printed).toContain("done");
  });
  it("prompt falls back to default on empty answer", async () => {
    const io = makeScriptedIO([""]);
    expect(await io.prompt("name?", "fallback")).toBe("fallback");
  });
  it("confirm parses y/n with default", async () => {
    const io = makeScriptedIO(["", "n"]);
    expect(await io.confirm("ok?", true)).toBe(true);
    expect(await io.confirm("ok?", true)).toBe(false);
  });
});
