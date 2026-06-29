import { describe, it, expect, vi } from "vitest";
import { dispatch, configGuidance } from "./index.js";
import { MISSING_CONFIG_MESSAGE } from "../core/config.js";

describe("dispatch", () => {
  it("routes 'doctor' to runDoctor", async () => {
    const runDoctor = vi.fn(async () => 0);
    const code = await dispatch(["doctor"], { runDoctor, runInit: vi.fn(), runServer: vi.fn() });
    expect(runDoctor).toHaveBeenCalledOnce();
    expect(code).toBe(0);
  });
  it("routes 'init' to runInit", async () => {
    const runInit = vi.fn(async () => 0);
    await dispatch(["init"], { runDoctor: vi.fn(), runInit, runServer: vi.fn() });
    expect(runInit).toHaveBeenCalledOnce();
  });
  it("routes 'instances' to runInstances with the remaining argv", async () => {
    const runInstances = vi.fn(async () => 0);
    const code = await dispatch(["instances", "rm", "stg"], { runDoctor: vi.fn(), runInit: vi.fn(), runServer: vi.fn(), runInstances });
    expect(runInstances).toHaveBeenCalledOnce();
    expect((runInstances.mock.calls[0] as unknown[] | undefined)?.[0]).toEqual(["rm", "stg"]);   // rest argv
    expect(code).toBe(0);
  });
  it("routes no-subcommand to runServer", async () => {
    const runServer = vi.fn(async () => {});
    await dispatch([], { runDoctor: vi.fn(), runInit: vi.fn(), runServer });
    expect(runServer).toHaveBeenCalledOnce();
  });
  it("passes server flags through to runServer (not treated as subcommands)", async () => {
    const runServer = vi.fn(async () => {});
    await dispatch(["--enable-host-ops"], { runDoctor: vi.fn(), runInit: vi.fn(), runServer });
    expect(runServer).toHaveBeenCalledOnce();
  });

  it("prints actionable setup guidance (NOT a stack trace) when config is missing", async () => {
    const { CoolifyError } = await import("../core/errors.js");
    const runServer = vi.fn(async () => { throw new CoolifyError("invalid_input", MISSING_CONFIG_MESSAGE); });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    const code = await dispatch([], { runDoctor: vi.fn(), runInit: vi.fn(), runServer });
    spy.mockRestore();
    const out = writes.join("");
    expect(code).toBe(1);
    expect(out).toContain("coolify-mcp init");
    expect(out).toContain("COOLIFY_BASE_URL");
    expect(out).not.toContain("fatal:");
    expect(out).not.toMatch(/\n\s+at \S+/); // no stack-trace frames
  });

  it("prints a clean message (no stack) for an expected CoolifyError, e.g. an unresolved ${ENV} ref", async () => {
    const { CoolifyError } = await import("../core/errors.js");
    const runServer = vi.fn(async () => {
      throw new CoolifyError("invalid_input", "Config references environment variable COOLIFY_TOKEN, but it is not set.");
    });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    const code = await dispatch([], { runDoctor: vi.fn(), runInit: vi.fn(), runServer });
    spy.mockRestore();
    const out = writes.join("");
    expect(code).toBe(1);
    expect(out).toContain("COOLIFY_TOKEN");
    expect(out).not.toMatch(/\n\s+at \S+/); // clean message, no stack frames
  });

  it("re-throws an unexpected (non-CoolifyError) server error so it surfaces as fatal", async () => {
    const runServer = vi.fn(async () => { throw new Error("boom"); });
    await expect(
      dispatch([], { runDoctor: vi.fn(), runInit: vi.fn(), runServer }),
    ).rejects.toThrow("boom");
  });
});

describe("configGuidance", () => {
  it("lists the init wizard, env vars, and config-file options", () => {
    const g = configGuidance();
    expect(g).toContain("coolify-mcp init");
    expect(g).toContain("COOLIFY_BASE_URL");
    expect(g).toContain("COOLIFY_TOKEN");
    expect(g).toContain("config.json");
  });
});
