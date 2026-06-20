// Regression coverage for makeInstanceHostOps — host-ops was never run live until
// the bring-up, which surfaced that the registry built an SshClient but never
// called connect(), so the first host-op threw "SshClient: not connected".
// Module mocks are scoped to this file so they don't affect registry.test.ts.
import { describe, it, expect, vi } from "vitest";

const { connectSpy } = vi.hoisted(() => ({ connectSpy: vi.fn(async () => {}) }));
// vitest 4: a vi.fn() used with `new` must implement via a real function/class
// (arrow functions have no [[Construct]]). registry.ts does `new SshClient(...)`
// and `new HostOps(...)`, so both mock implementations are regular functions.
vi.mock("./ssh/client.js", () => ({
  SshClient: vi.fn(function () { return { connect: connectSpy, exec: vi.fn(), close: vi.fn() }; }),
}));
vi.mock("./ssh/host-ops.js", () => ({
  HostOps: vi.fn(function (ssh: unknown) { return { ssh }; }),
}));

import { makeInstanceHostOps } from "./registry.js";
import type { InstanceConfig } from "./config/schema.js";
import type { ServerResolver } from "./ssh/resolver.js";
import type { CoolifyApiClient } from "./api/client.js";

describe("makeInstanceHostOps", () => {
  it("connects the SshClient before returning HostOps", async () => {
    connectSpy.mockClear();
    const resolver = {
      resolveControlHost: vi.fn(async () => ({ serverUuid: "s1", host: "h", user: "root", port: 22 })),
    } as unknown as ServerResolver;
    const config = {
      name: "prod", baseUrl: "https://p", token: "1|s", extraHeaders: {},
      enableHostOps: true, allowDestructive: false, ssh: { keyPath: "/k" },
    } as InstanceConfig;
    const builder = makeInstanceHostOps(config, {} as unknown as CoolifyApiClient, resolver);
    await builder();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects with host_ops_disabled and never connects when host-ops is off", async () => {
    connectSpy.mockClear();
    const config = {
      name: "prod", baseUrl: "https://p", token: "1|s", extraHeaders: {},
      enableHostOps: false, allowDestructive: false,
    } as InstanceConfig;
    const builder = makeInstanceHostOps(config, {} as unknown as CoolifyApiClient, {} as unknown as ServerResolver);
    await expect(builder()).rejects.toMatchObject({ kind: "host_ops_disabled" });
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
