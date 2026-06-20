// src/core/ssh/host-ops.db-lazy.test.ts
import { describe, it, expect, vi } from "vitest";
import { HostOps } from "./host-ops.js";
describe("query_coolify_db lazy DB-role requirement", () => {
  it("errors when no read-only user is configured", async () => {
    const ssh = {} as any; const resolver = {} as any;
    const ho = new HostOps(ssh, resolver, undefined, undefined);
    await expect(ho.psqlReadOnly("SELECT 1")).rejects.toMatchObject({ kind: "invalid_input" });
  });
});
