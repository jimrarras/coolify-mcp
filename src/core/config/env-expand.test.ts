import { describe, it, expect } from "vitest";
import { expandEnvRefs, expandHome } from "./env-expand.js";

describe("expandEnvRefs", () => {
  const env = { TOKEN: "abc", EMPTY: "" };
  it("substitutes ${VAR}", () => expect(expandEnvRefs("x-${TOKEN}", env)).toBe("x-abc"));
  it("uses default for ${VAR:-default} when unset", () => expect(expandEnvRefs("${MISSING:-d}", env)).toBe("d"));
  it("prefers the value over the default when set", () => expect(expandEnvRefs("${TOKEN:-d}", env)).toBe("abc"));
  it("treats empty string as set (no default)", () => expect(expandEnvRefs("${EMPTY:-d}", env)).toBe(""));
  it("throws on unresolved ${VAR} with no default", () =>
    expect(() => expandEnvRefs("${NOPE}", env)).toThrow(/NOPE/));
  it("leaves plain strings unchanged", () => expect(expandEnvRefs("plain", env)).toBe("plain"));
});

describe("expandHome", () => {
  it("expands ~ and ~/", () => {
    expect(expandHome("~/x", "/home/u")).toBe("/home/u/x");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });
  it("leaves non-tilde paths and undefined home alone", () => {
    expect(expandHome("/abs", "/home/u")).toBe("/abs");
    expect(expandHome("~/x", undefined)).toBe("~/x");
  });
});
