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
    const runInstances = vi.fn<(argv: string[], env: Record<string, string | undefined>, out: (l: string) => void) => Promise<number>>(async () => 0);
    const code = await dispatch(["instances", "rm", "stg"], { runDoctor: vi.fn(), runInit: vi.fn(), runServer: vi.fn(), runInstances });
    expect(runInstances).toHaveBeenCalledOnce();
    expect(runInstances.mock.calls[0][0]).toEqual(["rm", "stg"]);   // rest argv (mock typed → no cast needed)
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

describe("isMainModule", () => {
  it("is exported and detects a direct-path invocation", async () => {
    const { isMainModule } = await import("./index.js");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-ismain-"));
    try {
      const entry = path.join(dir, "index.js");
      fs.writeFileSync(entry, "// entry\n");
      // Node realpaths the loaded module, so metaUrl is always the real path.
      expect(isMainModule(pathToFileURL(entry).href, entry)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects invocation through a junction/symlinked directory (npm link-style install)", async () => {
    const { isMainModule } = await import("./index.js");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-ismain-"));
    try {
      const realDir = path.join(dir, "real");
      fs.mkdirSync(realDir);
      const entry = path.join(realDir, "index.js");
      fs.writeFileSync(entry, "// entry\n");
      const linkDir = path.join(dir, "link");
      fs.symlinkSync(realDir, linkDir, "junction"); // junction: no admin needed on Windows
      const argvPath = path.join(linkDir, "index.js");
      // metaUrl resolves through the REAL path (Node realpaths the main module);
      // argv[1] is the symlinked path the shim invoked. These must still match.
      expect(isMainModule(pathToFileURL(entry).href, argvPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for a different script and for missing argv[1]", async () => {
    const { isMainModule } = await import("./index.js");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-ismain-"));
    try {
      const a = path.join(dir, "a.js");
      const b = path.join(dir, "b.js");
      fs.writeFileSync(a, "");
      fs.writeFileSync(b, "");
      expect(isMainModule(pathToFileURL(a).href, b)).toBe(false);
      expect(isMainModule(pathToFileURL(a).href, undefined)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a plain path comparison when the path cannot be realpathed", async () => {
    const { isMainModule } = await import("./index.js");
    const { pathToFileURL } = await import("node:url");
    // Nonexistent path: realpath throws, but an exact textual match must still count.
    const ghost = "C:/nonexistent-cmcp-dir/index.js";
    expect(isMainModule(pathToFileURL(ghost).href, ghost)).toBe(true);
    expect(isMainModule(pathToFileURL(ghost).href, "C:/other/index.js")).toBe(false);
  });
});
