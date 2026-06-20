import { describe, it, expect, vi } from "vitest";
import { dispatch } from "./index.js";

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
});
