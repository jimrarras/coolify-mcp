// src/core/validate.test.ts
import { describe, it, expect } from "vitest";
import {
  COOLIFY_UUID_RE,
  assertCoolifyUuid,
  assertCoolifyServerRef,
} from "./validate.js";
import { CoolifyError } from "./errors.js";

describe("COOLIFY_UUID_RE", () => {
  it("matches alphanumeric strings", () => {
    expect(COOLIFY_UUID_RE.test("abc123")).toBe(true);
    expect(COOLIFY_UUID_RE.test("ABC")).toBe(true);
    expect(COOLIFY_UUID_RE.test("0")).toBe(true);
    expect(COOLIFY_UUID_RE.test("abcXYZ0123456789")).toBe(true);
  });

  it("does not match strings with hyphens or underscores", () => {
    expect(COOLIFY_UUID_RE.test("abc-123")).toBe(false);
    expect(COOLIFY_UUID_RE.test("abc_123")).toBe(false);
  });

  it("does not match empty string", () => {
    expect(COOLIFY_UUID_RE.test("")).toBe(false);
  });

  it("does not match strings with dots or special chars", () => {
    expect(COOLIFY_UUID_RE.test("abc.def")).toBe(false);
    expect(COOLIFY_UUID_RE.test("abc 123")).toBe(false);
  });
});

describe("assertCoolifyUuid()", () => {
  it("returns the value when valid", () => {
    expect(assertCoolifyUuid("abc123", "uuid")).toBe("abc123");
    expect(assertCoolifyUuid("ABCDEF", "resource_uuid")).toBe("ABCDEF");
  });

  it("throws CoolifyError with kind=invalid_input for non-string values", () => {
    expect(() => assertCoolifyUuid(123, "uuid")).toThrow(CoolifyError);
    expect(() => assertCoolifyUuid(null, "uuid")).toThrow(CoolifyError);
    expect(() => assertCoolifyUuid(undefined, "uuid")).toThrow(CoolifyError);
    expect(() => assertCoolifyUuid({}, "uuid")).toThrow(CoolifyError);
  });

  it("throws CoolifyError with kind=invalid_input for invalid format", () => {
    const e1 = (() => {
      try {
        assertCoolifyUuid("not-valid-uuid", "uuid");
      } catch (e) {
        return e;
      }
    })() as CoolifyError;
    expect(e1).toBeInstanceOf(CoolifyError);
    expect(e1.kind).toBe("invalid_input");
    expect(e1.message).toContain("uuid");
  });

  it("throws CoolifyError for empty string", () => {
    expect(() => assertCoolifyUuid("", "uuid")).toThrow(CoolifyError);
  });

  it("includes the field name in the error message", () => {
    const e = (() => {
      try {
        assertCoolifyUuid("bad-value", "application_uuid");
      } catch (e) {
        return e;
      }
    })() as CoolifyError;
    expect(e.message).toContain("application_uuid");
  });
});

describe("assertCoolifyServerRef()", () => {
  it("accepts UUIDs and server names containing -, _, or .", () => {
    expect(assertCoolifyServerRef("host001", "server")).toBe("host001");
    expect(assertCoolifyServerRef("prod-1", "server")).toBe("prod-1");
    expect(assertCoolifyServerRef("web.db", "server")).toBe("web.db");
    expect(assertCoolifyServerRef("app_server", "server")).toBe("app_server");
  });

  it("rejects shell/URL metacharacters, traversal, and leading dot/dash", () => {
    for (const bad of ["a/b", "a;b", "a b", "a$(x)", "a|b", "..", "../etc", "-rf", ".hidden", ""]) {
      expect(() => assertCoolifyServerRef(bad, "server")).toThrow(CoolifyError);
    }
    expect(() => assertCoolifyServerRef(123, "server")).toThrow(CoolifyError);
  });
});
