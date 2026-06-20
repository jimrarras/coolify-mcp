// src/mcp/tools/host.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "./host.js";
import type { ToolContext } from "./types.js";
import type { HostOps } from "../../core/ssh/host-ops.js";
import type { ServerResolver } from "../../core/ssh/resolver.js";
import type { CoolifyApiClient } from "../../core/api/client.js";
import type { InstanceConfig } from "../../core/config.js";

function makeFakeHostOps(overrides: Partial<HostOps> = {}): HostOps {
  return {
    rawExec: vi.fn(async () => ({ code: 0, stdout: "hello", stderr: "" })),
    dockerExec: vi.fn(async () => ({ code: 0, stdout: "container-out", stderr: "" })),
    dockerStream: vi.fn(async () => ({ code: 0 })),
    psqlReadOnly: vi.fn(async () => "id\n1\n"),
    readHostFile: vi.fn(async () => "file-contents"),
    ...overrides,
  } as unknown as HostOps;
}

function makeFakeResolver(overrides: Partial<ServerResolver> = {}): ServerResolver {
  return {
    resolveByServer: vi.fn(async () => ({
      serverUuid: "serverabc",
      isCoolifyHost: true,
    })),
    resolveByResource: vi.fn(async () => ({
      serverUuid: "serverabc",
      isCoolifyHost: true,
    })),
    ...overrides,
  } as unknown as ServerResolver;
}

function makeCtx(opts: {
  enableHostOps?: boolean;
  allowDestructive?: boolean;
  hostOpsImpl?: HostOps;
  resolverImpl?: ServerResolver;
}): ToolContext {
  const hostOpsImpl = opts.hostOpsImpl ?? makeFakeHostOps();
  const resolverImpl = opts.resolverImpl ?? makeFakeResolver();
  return {
    api: {} as unknown as CoolifyApiClient,
    config: {
      name: "default",
      baseUrl: "http://coolify.test",
      token: "1|abc",
      extraHeaders: {},
      enableHostOps: opts.enableHostOps ?? true,
      allowDestructive: opts.allowDestructive ?? false,
    } as InstanceConfig,
    hostOps: async () => hostOpsImpl,
    resolver: resolverImpl,
    notifier: undefined,
  };
}

function getTool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe("host.ts TOOLS export", () => {
  it("exports exactly 4 tools all with tier=host", () => {
    expect(TOOLS).toHaveLength(4);
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("ssh_exec");
    expect(names).toContain("docker_op");
    expect(names).toContain("query_coolify_db");
    expect(names).toContain("read_host_file");
    for (const t of TOOLS) {
      expect(t.tier).toBe("host");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ssh_exec
// ────────────────────────────────────────────────────────────────────────────
describe("ssh_exec", () => {
  it("accepts a hyphenated/dotted server NAME (documented UUID-or-name) and resolves it", async () => {
    const tool = getTool("ssh_exec");
    const resolveByServer = vi.fn(async () => ({ serverUuid: "serverabc", isCoolifyHost: true }));
    const ctx = makeCtx({
      enableHostOps: true,
      allowDestructive: true,
      resolverImpl: makeFakeResolver({ resolveByServer } as Partial<ServerResolver>),
    });
    const result = await tool.handler(
      { server: "prod-db.1", command: "echo hi", confirm: true },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(resolveByServer).toHaveBeenCalledWith("prod-db.1");
  });

  it("returns error when host ops disabled", async () => {
    const tool = getTool("ssh_exec");
    const ctx = makeCtx({ enableHostOps: false });
    const result = await tool.handler(
      { server: "serverabc", command: "ls -la" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("host_ops_disabled");
    }
  });

  it("runs command via rawExec and returns stdout/stderr/code", async () => {
    const fakeHostOps = makeFakeHostOps({
      rawExec: vi.fn(async () => ({ code: 0, stdout: "total 8\n", stderr: "" })),
    });
    // R4: must now pass allowDestructive:true and confirm:true
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "serverabc", command: "ls -la", confirm: true },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["code"]).toBe(0);
      expect(result["stdout"]).toBe("total 8\n");
      expect(result["stderr"]).toBe("");
    }
    expect(fakeHostOps.rawExec).toHaveBeenCalledOnce();
  });

  it("returns partial when remote exit code != 0", async () => {
    const fakeHostOps = makeFakeHostOps({
      rawExec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "Permission denied" })),
    });
    // R4: must now pass allowDestructive:true and confirm:true
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "serverabc", command: "cat /root/.ssh/id_rsa", confirm: true },
      ctx,
    );
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result["code"]).toBe(1);
      expect(result["stderr"]).toBe("Permission denied");
    }
  });

  it("returns error when server arg is missing", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("ssh_exec");
    const result = await tool.handler({ command: "ls" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// docker_op
// ────────────────────────────────────────────────────────────────────────────
describe("docker_op", () => {
  it("returns host_ops_disabled when host ops not enabled", async () => {
    const tool = getTool("docker_op");
    const ctx = makeCtx({ enableHostOps: false });
    const result = await tool.handler(
      { server: "serverabc", action: "ps", docker_args: "" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("host_ops_disabled");
    }
  });

  it("runs non-destructive docker ps", async () => {
    const fakeHostOps = makeFakeHostOps({
      dockerExec: vi.fn(async () => ({ code: 0, stdout: "CONTAINER ID\nabc123", stderr: "" })),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "ps", docker_args: "" },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["stdout"]).toContain("CONTAINER ID");
    }
  });

  it("blocks destructive action (rm) when allowDestructive=false and confirm missing", async () => {
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: false });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "rm", docker_args: "old-container" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(["destructive_blocked", "confirmation_required"]).toContain(result.error.kind);
    }
  });

  it("allows destructive action when allowDestructive=true and confirm=true", async () => {
    const fakeHostOps = makeFakeHostOps({
      dockerExec: vi.fn(async () => ({ code: 0, stdout: "old-container", stderr: "" })),
    });
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "rm", docker_args: "old-container", confirm: true },
      ctx,
    );
    expect(result.status).toBe("ok");
  });

  it("returns dry_run result when dry_run=true for destructive action", async () => {
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "rm", docker_args: "old-container", dry_run: true, confirm: false },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["dry_run"]).toBe(true);
    }
  });

  it("returns error when server arg missing", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler({ action: "ps", docker_args: "" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  // ── R3 regression: docker_op allowlist + metacharacter checks ───────────────

  it("R3: rejects docker_args containing semicolon (shell injection)", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "ps", docker_args: "; cat /etc/shadow" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: rejects docker_args containing pipe metacharacter", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "ps", docker_args: "foo | id" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: rejects docker_args containing backtick (command substitution)", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "ps", docker_args: "foo`id`" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: rejects docker_args containing dollar sign (variable/subshell expansion)", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "ps", docker_args: "$(whoami)" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: rejects docker_args containing newline (command injection)", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "ps", docker_args: "foo\nid" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: action=run is not in allowlist and requires destructive fence", async () => {
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: false });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "run", docker_args: "ubuntu id" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(["destructive_blocked", "confirmation_required"]).toContain(result.error.kind);
    }
  });

  it("R3: action with uppercase letters is rejected (action format enforcement)", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "PS", docker_args: "" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: action with embedded shell metacharacter is rejected", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    const result = await tool.handler(
      { server: "serverabc", action: "ps; id", docker_args: "" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: server ref with metacharacters/traversal is rejected for docker_op", async () => {
    // Hyphen/dot/underscore NAMES are now allowed (UUID-or-name); unsafe refs are not.
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("docker_op");
    for (const server of ["srv/../enable", "bad;server", "a b"]) {
      const result = await tool.handler({ server, action: "ps", docker_args: "" }, ctx);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.kind).toBe("invalid_input");
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// R4 regression: ssh_exec destructive fence
// ────────────────────────────────────────────────────────────────────────────
describe("ssh_exec R4 destructive fence", () => {
  it("R4: blocked without --allow-destructive (allowDestructive=false)", async () => {
    // This test MUST FAIL against the unfixed code (ssh_exec had no destructive fence)
    const fakeHostOps = makeFakeHostOps({
      rawExec: vi.fn(async () => ({ code: 0, stdout: "should-not-reach", stderr: "" })),
    });
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: false, hostOpsImpl: fakeHostOps });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "serverabc", command: "rm -rf /tmp/test" },
      ctx,
    );
    // Must be blocked — rawExec must NOT have been called
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("destructive_blocked");
    }
    expect(fakeHostOps.rawExec).not.toHaveBeenCalled();
  });

  it("R4: blocked when allowDestructive=true but confirm is not supplied", async () => {
    const fakeHostOps = makeFakeHostOps({
      rawExec: vi.fn(async () => ({ code: 0, stdout: "should-not-reach", stderr: "" })),
    });
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "serverabc", command: "ls -la" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("confirmation_required");
    }
    expect(fakeHostOps.rawExec).not.toHaveBeenCalled();
  });

  it("R4: blocked when allowDestructive=true but confirm=false", async () => {
    const fakeHostOps = makeFakeHostOps({
      rawExec: vi.fn(async () => ({ code: 0, stdout: "should-not-reach", stderr: "" })),
    });
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "serverabc", command: "ls -la", confirm: false },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("confirmation_required");
    }
    expect(fakeHostOps.rawExec).not.toHaveBeenCalled();
  });

  it("R4: dry_run=true returns preview without executing rawExec", async () => {
    const fakeHostOps = makeFakeHostOps({
      rawExec: vi.fn(async () => ({ code: 0, stdout: "should-not-reach", stderr: "" })),
    });
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "serverabc", command: "cat /etc/passwd", dry_run: true },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["dry_run"]).toBe(true);
      expect(result["preview"]).toBeDefined();
      const preview = result["preview"] as Record<string, unknown>;
      expect(preview["server"]).toBe("serverabc");
      expect(preview["command"]).toBe("cat /etc/passwd");
    }
    expect(fakeHostOps.rawExec).not.toHaveBeenCalled();
  });

  it("R4: executes when allowDestructive=true and confirm=true", async () => {
    const fakeHostOps = makeFakeHostOps({
      rawExec: vi.fn(async () => ({ code: 0, stdout: "hello from server", stderr: "" })),
    });
    const ctx = makeCtx({ enableHostOps: true, allowDestructive: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "serverabc", command: "echo hello", confirm: true },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["stdout"]).toBe("hello from server");
    }
    expect(fakeHostOps.rawExec).toHaveBeenCalledOnce();
  });
});

// ── R3 regression: ssh_exec server UUID enforcement ─────────────────────────
describe("ssh_exec R3 server ref enforcement", () => {
  it("R3: server ref with path traversal is rejected for ssh_exec", async () => {
    // Validation runs before the destructive fence, so an unsafe ref => invalid_input.
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "srv/../enable", command: "ls" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("R3: server with shell injection chars is rejected for ssh_exec", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("ssh_exec");
    const result = await tool.handler(
      { server: "server; cat /etc/passwd", command: "ls" },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// query_coolify_db
// ────────────────────────────────────────────────────────────────────────────
describe("query_coolify_db", () => {
  it("returns host_ops_disabled when not enabled", async () => {
    const tool = getTool("query_coolify_db");
    const ctx = makeCtx({ enableHostOps: false });
    const result = await tool.handler({ sql: "SELECT 1" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("host_ops_disabled");
    }
  });

  it("runs psqlReadOnly and returns rows string", async () => {
    const fakeHostOps = makeFakeHostOps({
      psqlReadOnly: vi.fn(async () => "id | name\n---+-----\n 1 | test"),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("query_coolify_db");
    const result = await tool.handler({ sql: "SELECT id, name FROM applications" }, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["rows"]).toContain("id | name");
    }
    expect(fakeHostOps.psqlReadOnly).toHaveBeenCalledWith("SELECT id, name FROM applications");
  });

  it("returns error when sql is missing", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("query_coolify_db");
    const result = await tool.handler({}, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("forwards CoolifyError when psqlReadOnly rejects (e.g. non-SELECT)", async () => {
    const { CoolifyError } = await import("../../core/errors.js");
    const fakeHostOps = makeFakeHostOps({
      psqlReadOnly: vi.fn(async () => {
        throw new CoolifyError("invalid_input", "Only SELECT queries are permitted");
      }),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("query_coolify_db");
    const result = await tool.handler({ sql: "DROP TABLE applications" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// read_host_file
// ────────────────────────────────────────────────────────────────────────────
describe("read_host_file", () => {
  it("returns host_ops_disabled when not enabled", async () => {
    const tool = getTool("read_host_file");
    const ctx = makeCtx({ enableHostOps: false });
    const result = await tool.handler({ path: "/data/coolify/source/.env" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("host_ops_disabled");
    }
  });

  it("reads allowed file and returns contents", async () => {
    const fakeHostOps = makeFakeHostOps({
      readHostFile: vi.fn(async () => "APP_ID=abc\nSECRET=***"),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("read_host_file");
    const result = await tool.handler({ path: "/data/coolify/source/.env" }, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result["contents"]).toContain("APP_ID=abc");
    }
    expect(fakeHostOps.readHostFile).toHaveBeenCalledWith("/data/coolify/source/.env");
  });

  it("forwards error when readHostFile rejects (path not allowed)", async () => {
    const { CoolifyError } = await import("../../core/errors.js");
    const fakeHostOps = makeFakeHostOps({
      readHostFile: vi.fn(async () => {
        throw new CoolifyError("invalid_input", "Path not in allowed prefixes");
      }),
    });
    const ctx = makeCtx({ enableHostOps: true, hostOpsImpl: fakeHostOps });
    const tool = getTool("read_host_file");
    const result = await tool.handler({ path: "/etc/shadow" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });

  it("returns error when path arg is missing", async () => {
    const ctx = makeCtx({ enableHostOps: true });
    const tool = getTool("read_host_file");
    const result = await tool.handler({}, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("invalid_input");
    }
  });
});
