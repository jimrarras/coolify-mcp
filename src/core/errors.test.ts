import { describe, it, expect } from "vitest";
import {
  ok,
  partial,
  err,
  CoolifyError,
  toErrorResult,
} from "./errors.js";

describe("ok()", () => {
  it("returns status ok with no extra data when called with no args", () => {
    const result = ok();
    expect(result).toEqual({ status: "ok" });
  });

  it("merges extra data into the ok envelope", () => {
    const result = ok({ uuid: "abc123", count: 5 });
    expect(result).toEqual({ status: "ok", uuid: "abc123", count: 5 });
  });
});

describe("partial()", () => {
  it("returns status partial with merged data", () => {
    const result = partial({ processed: 3, total: 5 });
    expect(result).toEqual({ status: "partial", processed: 3, total: 5 });
  });
});

describe("err()", () => {
  it("returns status error with kind and message", () => {
    const result = err("not_found", "Resource not found");
    expect(result).toEqual({
      status: "error",
      error: { kind: "not_found", message: "Resource not found" },
    });
  });

  it("includes raw_response when provided", () => {
    const raw = { code: 404, detail: "missing" };
    const result = err("not_found", "Resource not found", raw);
    expect(result).toEqual({
      status: "error",
      error: { kind: "not_found", message: "Resource not found", raw_response: raw },
    });
  });

  it("omits raw_response key when not provided", () => {
    const result = err("auth", "Unauthorized");
    expect("raw_response" in (result as any).error).toBe(false);
  });
});

describe("CoolifyError", () => {
  it("is an instance of Error", () => {
    const e = new CoolifyError("auth", "bad token");
    expect(e).toBeInstanceOf(Error);
  });

  it("stores kind and message", () => {
    const e = new CoolifyError("invalid_input", "bad uuid");
    expect(e.kind).toBe("invalid_input");
    expect(e.message).toBe("bad uuid");
  });

  it("stores optional status, raw_response, retryAfter", () => {
    const raw = { detail: "rate limited" };
    const e = new CoolifyError("transient_exhausted", "rate limited", {
      status: 429,
      raw_response: raw,
      retryAfter: 30,
    });
    expect(e.status).toBe(429);
    expect(e.raw_response).toEqual(raw);
    expect(e.retryAfter).toBe(30);
  });

  it("leaves optional fields undefined when opts not provided", () => {
    const e = new CoolifyError("unknown", "oops");
    expect(e.status).toBeUndefined();
    expect(e.raw_response).toBeUndefined();
    expect(e.retryAfter).toBeUndefined();
  });

  it("has a useful stack trace (name is CoolifyError)", () => {
    const e = new CoolifyError("auth", "bad token");
    expect(e.name).toBe("CoolifyError");
  });
});

describe("toErrorResult()", () => {
  it("maps CoolifyError to its kind", () => {
    const e = new CoolifyError("not_found", "app missing");
    const result = toErrorResult(e);
    expect(result).toEqual({
      status: "error",
      error: { kind: "not_found", message: "app missing" },
    });
  });

  it("preserves raw_response from CoolifyError (redacted key present when set)", () => {
    const raw = { body: "some server error" };
    const e = new CoolifyError("transient_exhausted", "server blew up", { raw_response: raw });
    const result = toErrorResult(e) as any;
    expect(result.status).toBe("error");
    expect(result.error.raw_response).toEqual(raw);
  });

  it("maps a plain Error to kind=unknown", () => {
    const e = new Error("something broke");
    const result = toErrorResult(e) as any;
    expect(result.status).toBe("error");
    expect(result.error.kind).toBe("unknown");
    expect(result.error.message).toBe("something broke");
  });

  it("maps a thrown string to kind=unknown", () => {
    const result = toErrorResult("oops string thrown") as any;
    expect(result.status).toBe("error");
    expect(result.error.kind).toBe("unknown");
    expect(typeof result.error.message).toBe("string");
  });

  it("maps null/undefined to kind=unknown with a safe message", () => {
    const r1 = toErrorResult(null) as any;
    const r2 = toErrorResult(undefined) as any;
    expect(r1.error.kind).toBe("unknown");
    expect(r2.error.kind).toBe("unknown");
  });
});
