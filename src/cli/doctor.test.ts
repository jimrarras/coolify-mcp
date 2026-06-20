import { describe, it, expect } from "vitest";
import { runDoctor } from "./doctor.js";

const baseEnv = { COOLIFY_BASE_URL: "https://h", COOLIFY_TOKEN: "1|s" };

describe("runDoctor", () => {
  it("prints PASS lines and exits 0 when all ok", async () => {
    const lines: string[] = [];
    const code = await runDoctor([], baseEnv, (l) => lines.push(l), {
      runChecks: async () => [{ name: "api", status: "ok", detail: "Coolify 4.1.2 reachable" }],
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/PASS\s+api/);
  });

  it("prints FAIL + fix and exits 1 when a check fails", async () => {
    const lines: string[] = [];
    const code = await runDoctor([], baseEnv, (l) => lines.push(l), {
      runChecks: async () => [{ name: "ssh", status: "fail", detail: "auth rejected", fix: "fix me" }],
    });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toMatch(/FAIL\s+ssh/);
    expect(out).toMatch(/fix me/);
  });

  it("exits 1 with a clear message when config loading throws", async () => {
    const lines: string[] = [];
    const code = await runDoctor([], {}, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/COOLIFY_BASE_URL/);
  });
});
