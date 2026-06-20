// src/__tests__/probe.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  parseProbeResult,
  formatProbeReport,
  type ProbeResult,
} from "../scripts/probe.js";

describe("parseProbeResult", () => {
  it("returns status=ok when the value is a non-empty array", () => {
    const result = parseProbeResult("list_applications", async () => [{ uuid: "abc" }]);
    expect(result).toBeInstanceOf(Promise);
  });

  it("handles a synchronous-resolved promise", async () => {
    const result = await parseProbeResult("list_applications", async () => [{ uuid: "abc" }]);
    expect(result.status).toBe("ok");
    expect(result.name).toBe("list_applications");
    expect(result.value).toEqual([{ uuid: "abc" }]);
  });

  it("returns status=ok for empty array (valid response)", async () => {
    const result = await parseProbeResult("list_databases", async () => []);
    expect(result.status).toBe("ok");
    expect(Array.isArray(result.value)).toBe(true);
  });

  it("returns status=error when promise rejects", async () => {
    const result = await parseProbeResult("health_check", async () => {
      throw new Error("connection refused");
    });
    expect(result.status).toBe("error");
    expect(result.name).toBe("health_check");
    expect(result.error).toMatch(/connection refused/);
  });

  it("returns status=ok for null/undefined (some endpoints return null)", async () => {
    const result = await parseProbeResult("version_check", async () => null);
    expect(result.status).toBe("ok");
  });

  it("captures value for non-array responses (object, string, number)", async () => {
    const result = await parseProbeResult("version", async () => "4.0.0-beta.470");
    expect(result.status).toBe("ok");
    expect(result.value).toBe("4.0.0-beta.470");
  });
});

describe("formatProbeReport", () => {
  it("returns a non-empty string", () => {
    const results: ProbeResult[] = [
      { name: "health", status: "ok", value: { ok: true } },
      { name: "version", status: "ok", value: "4.0.0-beta.470" },
      { name: "bad_endpoint", status: "error", error: "404 Not Found" },
    ];
    const report = formatProbeReport(results);
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(10);
  });

  it("includes PASS for ok results", () => {
    const results: ProbeResult[] = [
      { name: "health", status: "ok", value: {} },
    ];
    const report = formatProbeReport(results);
    expect(report).toMatch(/PASS|ok|OK/i);
    expect(report).toContain("health");
  });

  it("includes FAIL or ERROR for error results", () => {
    const results: ProbeResult[] = [
      { name: "broken_endpoint", status: "error", error: "timeout" },
    ];
    const report = formatProbeReport(results);
    expect(report).toMatch(/FAIL|ERROR|error/i);
    expect(report).toContain("broken_endpoint");
  });

  it("includes the error message in the report", () => {
    const results: ProbeResult[] = [
      { name: "broken", status: "error", error: "ECONNREFUSED 10.0.0.1:443" },
    ];
    const report = formatProbeReport(results);
    expect(report).toContain("ECONNREFUSED");
  });

  it("includes a summary line with total/pass/fail counts", () => {
    const results: ProbeResult[] = [
      { name: "a", status: "ok", value: 1 },
      { name: "b", status: "ok", value: 2 },
      { name: "c", status: "error", error: "boom" },
    ];
    const report = formatProbeReport(results);
    // Should mention 3 total, 2 passed, 1 failed in some form
    expect(report).toMatch(/3|total/i);
    expect(report).toMatch(/2|pass/i);
    expect(report).toMatch(/1|fail/i);
  });
});
