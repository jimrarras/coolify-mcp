import { describe, it, expect, vi } from "vitest";
import { checkFences } from "./fencing.js";
import type { FenceContext } from "./fencing.js";

const OPEN: FenceContext = { enableHostOps: true, allowDestructive: true };
const CLOSED: FenceContext = { enableHostOps: false, allowDestructive: false };
const HOST_OFF: FenceContext = { enableHostOps: false, allowDestructive: true };
const DEST_OFF: FenceContext = { enableHostOps: true, allowDestructive: false };

describe("checkFences — host ops fence", () => {
  it("returns null (pass-through) when requireHostOps=true and enableHostOps=true", async () => {
    const result = await checkFences(OPEN, { requireHostOps: true, args: {} });
    expect(result).toBeNull();
  });

  it("returns err(host_ops_disabled) when requireHostOps=true and enableHostOps=false", async () => {
    const result = await checkFences(HOST_OFF, { requireHostOps: true, args: {} });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("error");
    if (result?.status === "error") {
      expect(result.error.kind).toBe("host_ops_disabled");
    }
  });

  it("does not check host ops when requireHostOps is not set", async () => {
    const result = await checkFences(HOST_OFF, { destructive: true, args: { confirm: true } });
    expect(result).toBeNull();
  });
});

describe("checkFences — destructive fence", () => {
  it("returns err(destructive_blocked) when destructive=true and allowDestructive=false", async () => {
    const result = await checkFences(DEST_OFF, { destructive: true, args: { confirm: true } });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("error");
    if (result?.status === "error") {
      expect(result.error.kind).toBe("destructive_blocked");
    }
  });

  it("returns null when destructive=true, allowDestructive=true, and confirm=true", async () => {
    const result = await checkFences(OPEN, { destructive: true, args: { confirm: true } });
    expect(result).toBeNull();
  });

  it("returns err(confirmation_required) when destructive=true, allowDestructive=true, confirm not set", async () => {
    const result = await checkFences(OPEN, { destructive: true, args: {} });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("error");
    if (result?.status === "error") {
      expect(result.error.kind).toBe("confirmation_required");
    }
  });

  it("returns err(confirmation_required) when destructive=true, allowDestructive=true, confirm=false", async () => {
    const result = await checkFences(OPEN, { destructive: true, args: { confirm: false } });
    expect(result).not.toBeNull();
    if (result?.status === "error") {
      expect(result.error.kind).toBe("confirmation_required");
    }
  });

  it("includes preview in confirmation_required error raw_response when preview() is provided", async () => {
    const preview = vi.fn(async () => ({ resource: "myapp", action: "delete" }));
    const result = await checkFences(OPEN, {
      destructive: true,
      args: {},
      preview,
    });
    expect(result?.status).toBe("error");
    if (result?.status === "error") {
      expect(result.error.kind).toBe("confirmation_required");
      expect(result.error.raw_response).toEqual({ resource: "myapp", action: "delete" });
    }
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("does not call preview() when allowDestructive=false (blocked before preview)", async () => {
    const preview = vi.fn(async () => ({ x: 1 }));
    const result = await checkFences(DEST_OFF, {
      destructive: true,
      args: { confirm: true },
      preview,
    });
    expect(result?.status).toBe("error");
    if (result?.status === "error") {
      expect(result.error.kind).toBe("destructive_blocked");
    }
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("checkFences — dry_run", () => {
  it("returns ok({dry_run:true, preview}) when dry_run=true on a destructive op", async () => {
    const preview = vi.fn(async () => ({ would_delete: "myapp" }));
    const result = await checkFences(OPEN, {
      destructive: true,
      args: { dry_run: true },
      preview,
    });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("ok");
    expect((result as Record<string, unknown>).dry_run).toBe(true);
    expect((result as Record<string, unknown>).preview).toEqual({ would_delete: "myapp" });
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("returns ok({dry_run:true}) with no preview key when preview() is not provided", async () => {
    const result = await checkFences(OPEN, {
      destructive: true,
      args: { dry_run: true },
    });
    expect(result?.status).toBe("ok");
    expect((result as Record<string, unknown>).dry_run).toBe(true);
    expect("preview" in (result as Record<string, unknown>)).toBe(false);
  });

  it("does not reach dry_run check when allowDestructive=false", async () => {
    const preview = vi.fn(async () => ({}));
    const result = await checkFences(DEST_OFF, {
      destructive: true,
      args: { dry_run: true },
      preview,
    });
    expect(result?.status).toBe("error");
    if (result?.status === "error") {
      expect(result.error.kind).toBe("destructive_blocked");
    }
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("checkFences — non-destructive, non-host-ops", () => {
  it("returns null for a plain read op with all fences closed", async () => {
    const result = await checkFences(CLOSED, { args: {} });
    expect(result).toBeNull();
  });

  it("returns null when destructive is not set even with allowDestructive=false", async () => {
    const result = await checkFences(CLOSED, { args: { confirm: true } });
    expect(result).toBeNull();
  });
});

describe("checkFences — combined flags", () => {
  it("checks host ops first; does not reach destructive check if host ops blocked", async () => {
    const preview = vi.fn(async () => ({}));
    const result = await checkFences(
      { enableHostOps: false, allowDestructive: true },
      { requireHostOps: true, destructive: true, args: {}, preview }
    );
    expect(result?.status).toBe("error");
    if (result?.status === "error") {
      expect(result.error.kind).toBe("host_ops_disabled");
    }
    expect(preview).not.toHaveBeenCalled();
  });
});
