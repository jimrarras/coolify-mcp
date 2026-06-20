// src/core/ssh/host-ops.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- ssh2 mock (same pattern as client.test.ts, needed because client.ts imports it) ----
vi.mock("ssh2", () => ({
  Client: class MockClient {
    on() { return this; }
    connect() {}
    exec() {}
    sftp() {}
    end() {}
  },
}));

import { HostOps, ALLOWED_HOST_FILE_PREFIXES, isAllowedHostFilePath, redactEnvFileContents, validateReadOnlySql, redactSqlOutput } from "./host-ops.js";
import type { SshClient, SshExecResult } from "./client.js";
import type { ServerResolver, ServerTarget } from "./resolver.js";

function makeSsh(overrides: Partial<{
  exec: (cmd: string) => Promise<SshExecResult>;
  streamExec: (cmd: string, onLine: (l: string) => void, signal: AbortSignal) => Promise<{ code: number | null }>;
  readFile: (path: string, allowedPrefixes?: string[]) => Promise<string>;
}> = {}): SshClient {
  return {
    connect: vi.fn(),
    exec: overrides.exec ?? vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    streamExec: overrides.streamExec ?? vi.fn(async () => ({ code: 0 })),
    readFile: overrides.readFile ?? vi.fn(async () => ""),
    close: vi.fn(),
  } as unknown as SshClient;
}

function makeResolver(_target?: ServerTarget): ServerResolver {
  return {} as ServerResolver;
}

const coolifyHostTarget: ServerTarget = { serverUuid: "host001", isCoolifyHost: true };
const remoteTarget: ServerTarget = {
  serverUuid: "remote001",
  isCoolifyHost: false,
  dockerHost: "ssh://root@10.0.0.5",
};

describe("ALLOWED_HOST_FILE_PREFIXES", () => {
  it("exports the expected list of allowed prefixes", () => {
    expect(ALLOWED_HOST_FILE_PREFIXES).toContain("/data/coolify/source/.env");
    expect(ALLOWED_HOST_FILE_PREFIXES).toContain("/data/coolify/proxy/");
    expect(ALLOWED_HOST_FILE_PREFIXES).toContain("/data/coolify/");
    expect(ALLOWED_HOST_FILE_PREFIXES.length).toBe(3);
  });
});

describe("HostOps.dockerExec()", () => {
  it("runs docker without -H on the coolify host", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "hi", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver());

    const result = await ops.dockerExec(coolifyHostTarget, "ps -a");

    expect(execFn).toHaveBeenCalledWith("docker ps -a");
    expect(result.stdout).toBe("hi");
  });

  it("runs docker with -H using shell-quoted dockerHost on a remote server", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "containers", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver());

    await ops.dockerExec(remoteTarget, "ps -a");

    // dockerHost must be single-quoted so any embedded metachars are inert
    expect(execFn).toHaveBeenCalledWith("docker -H 'ssh://root@10.0.0.5' ps -a");
  });

  it("shell-quotes dockerHost to neutralise injection in the -H value (R2-hostops-quoting)", async () => {
    // This target simulates a value that somehow survived resolver validation
    // (e.g. set manually in tests).  The quoting in _dockerPrefix must still
    // neutralise it at the command-construction layer.
    const poisonedTarget: ServerTarget = {
      serverUuid: "evil",
      isCoolifyHost: false,
      dockerHost: "ssh://root@10.0.0.5; touch /tmp/pwned",
    };
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver());

    await ops.dockerExec(poisonedTarget, "ps -a");

    const calledWith: string = execFn.mock.calls[0][0] as string;
    // The dockerHost value must be wrapped in single quotes
    expect(calledWith).toContain("'ssh://root@10.0.0.5; touch /tmp/pwned'");
    // The raw unquoted semicolon must NOT appear outside of single quotes
    // i.e. the string must not start a new command after the docker call
    expect(calledWith).not.toMatch(/docker -H ssh:\/\/root@10\.0\.0\.5; touch/);
  });

  it("propagates non-zero exit codes without throwing", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 1, stdout: "", stderr: "no such container" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver());

    const result = await ops.dockerExec(coolifyHostTarget, "inspect nonexistent");

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("no such container");
  });
});

describe("HostOps.dockerStream()", () => {
  it("streams without -H on coolify host", async () => {
    const lines: string[] = [];
    const streamExecFn = vi.fn(async (cmd: string, onLine: (l: string) => void, _signal: AbortSignal) => {
      onLine("log line 1");
      onLine("log line 2");
      return { code: 0 };
    });
    const ops = new HostOps(makeSsh({ streamExec: streamExecFn }), makeResolver());

    const ac = new AbortController();
    const result = await ops.dockerStream(coolifyHostTarget, "logs -f myapp", (l) => lines.push(l), ac.signal);

    expect(streamExecFn).toHaveBeenCalledWith("docker logs -f myapp", expect.any(Function), ac.signal);
    expect(lines).toEqual(["log line 1", "log line 2"]);
    expect(result.code).toBe(0);
  });

  it("streams with -H using shell-quoted dockerHost for remote servers", async () => {
    const streamExecFn = vi.fn(async (_cmd: string, _onLine: (l: string) => void, _signal: AbortSignal) => ({ code: 0 }));
    const ops = new HostOps(makeSsh({ streamExec: streamExecFn }), makeResolver());

    const ac = new AbortController();
    await ops.dockerStream(remoteTarget, "logs -f myapp", () => {}, ac.signal);

    expect(streamExecFn).toHaveBeenCalledWith(
      "docker -H 'ssh://root@10.0.0.5' logs -f myapp",
      expect.any(Function),
      ac.signal,
    );
  });
});

describe("HostOps.rawExec()", () => {
  it("executes command directly (no docker prefix)", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "raw output", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver());

    const result = await ops.rawExec(coolifyHostTarget, "ls /data/coolify");

    expect(execFn).toHaveBeenCalledWith("ls /data/coolify");
    expect(result.stdout).toBe("raw output");
  });
});

describe("HostOps.psqlReadOnly()", () => {
  it("executes SELECT queries via coolify-db container", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "1 row", stderr: "" }));
    // H2R1: HostOps now requires dbReadonlyUser for psqlReadOnly
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");

    const result = await ops.psqlReadOnly("SELECT count(*) FROM deployments");

    // exec is now called as (cmd, stdin?, opts?) — assert on the command arg.
    expect(execFn.mock.calls[0][0]).toEqual(
      expect.stringContaining("docker exec -i coolify-db psql"),
    );
    expect(result).toBe("1 row");
  });

  it("executes WITH ... SELECT (CTE) queries", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "cte result", stderr: "" }));
    // H2R1: HostOps now requires dbReadonlyUser for psqlReadOnly
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");

    const result = await ops.psqlReadOnly("WITH cte AS (SELECT 1) SELECT * FROM cte");

    expect(execFn).toHaveBeenCalled();
    expect(result).toBe("cte result");
  });

  it("rejects INSERT queries with invalid_input error", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.psqlReadOnly("INSERT INTO foo VALUES (1)")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("rejects UPDATE queries", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.psqlReadOnly("UPDATE foo SET x=1")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("rejects DELETE queries", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.psqlReadOnly("DELETE FROM foo WHERE id=1")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("rejects DROP queries", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.psqlReadOnly("DROP TABLE foo")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("rejects queries that start with whitespace then a banned keyword", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.psqlReadOnly("  \n  UPDATE foo SET x=1")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  // ── R5 regression: bypass vectors that the old first-keyword-only guard missed ──

  it("R5: rejects stacked statement 'SELECT 1; DROP TABLE x'", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(ops.psqlReadOnly("SELECT 1; DROP TABLE x")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("R5: rejects writable CTE 'WITH d AS (DELETE FROM applications RETURNING *) SELECT * FROM d'", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("WITH d AS (DELETE FROM applications RETURNING *) SELECT * FROM d"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects 'SELECT 1; COPY (SELECT 1) TO PROGRAM \\'sh\\''", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT 1; COPY (SELECT 1) TO PROGRAM 'sh'"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects 'SELECT 1; DO $$ BEGIN NULL; END $$'", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT 1; DO $$ BEGIN NULL; END $$"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects comment-obfuscated injection 'SELECT/**/1;/**/DROP TABLE x'", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT/**/1;/**/DROP TABLE x"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects 'SELECT pg_read_file('/etc/passwd')'", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT pg_read_file('/etc/passwd')"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects 'SELECT 1; SET ROLE postgres'", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT 1; SET ROLE postgres"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects SET SESSION AUTHORIZATION anywhere in query", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT 1; SET SESSION AUTHORIZATION postgres"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects double-dash comment injection 'SELECT 1 -- comment'", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT 1 -- drop table"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects pg_ls_dir dangerous function", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT pg_ls_dir('/')"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects pg_read_binary_file dangerous function", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT pg_read_binary_file('/etc/shadow')"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects lo_export dangerous function", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT lo_export(1234, '/tmp/evil')"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: rejects dblink dangerous function", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());
    await expect(
      ops.psqlReadOnly("SELECT * FROM dblink('host=evil', 'SELECT 1') AS t(x int)"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R5: allows a plain trailing semicolon (SELECT 1;)", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: " 1 \n(1 row)", stderr: "" }));
    // H2R1: pass dbReadonlyUser
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    const result = await ops.psqlReadOnly("SELECT 1;");
    expect(execFn).toHaveBeenCalled();
    expect(result).toContain("1 row");
  });

  it("R5: psql command uses BEGIN READ ONLY transaction to enforce read-only mode", async () => {
    // H2R1: The old SET default_transaction_read_only approach is replaced by an explicit
    // BEGIN READ ONLY / ROLLBACK transaction using three -c flags in one session.
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: " 1 \n(1 row)", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    await ops.psqlReadOnly("SELECT 1");
    const cmd: string = execFn.mock.calls[0][0] as string;
    expect(cmd).toContain("BEGIN READ ONLY");
    expect(cmd).toContain("ROLLBACK");
    // The user SQL must appear between BEGIN READ ONLY and ROLLBACK
    const beginIdx = cmd.indexOf("BEGIN READ ONLY");
    const userSqlIdx = cmd.indexOf("SELECT 1");
    const rollbackIdx = cmd.indexOf("ROLLBACK");
    expect(beginIdx).toBeLessThan(userSqlIdx);
    expect(userSqlIdx).toBeLessThan(rollbackIdx);
  });

  it("bounds the query with a server-side statement_timeout before the user SQL", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "1", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    await ops.psqlReadOnly("SELECT 1");
    const cmd: string = execFn.mock.calls[0][0] as string;
    expect(cmd).toContain("statement_timeout");
    // the timeout must be set before the user SQL runs
    expect(cmd.indexOf("statement_timeout")).toBeLessThan(cmd.indexOf("SELECT 1"));
  });

  it("passes output-size and exec-timeout bounds to ssh.exec (DoS/OOM guard)", async () => {
    const execFn = vi.fn(async (_cmd: string, _stdin?: string, _opts?: unknown) => ({ code: 0, stdout: "1", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    await ops.psqlReadOnly("SELECT 1");
    const opts = execFn.mock.calls[0][2] as { maxOutputBytes?: number; timeoutMs?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.maxOutputBytes).toBeGreaterThan(0);
    expect(opts!.timeoutMs).toBeGreaterThan(0);
  });

  it("R5: psql stdout is redacted — lines with BEGIN PRIVATE KEY are masked", async () => {
    const privateKeyOutput = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEAzW2...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: privateKeyOutput, stderr: "" }));
    // H2R1: pass dbReadonlyUser
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    const result = await ops.psqlReadOnly("SELECT private_key FROM certificates WHERE id=1");
    expect(result).not.toContain("MIIEpAIBAAKCAQEAzW2");
    expect(result).toContain("REDACTED");
  });
});

describe("HostOps.readHostFile()", () => {
  it("reads a file under /data/coolify/ prefix (non-sensitive key passes through)", async () => {
    // R6: readFile is now called with allowedPrefixes as second arg for symlink defense.
    // The .env path triggers env-value redaction; use a non-sensitive key to confirm
    // pass-through still works (the key must appear in output unchanged).
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => "APP_URL=https://example.com");
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/source/.env");

    // R6: readFile receives allowedPrefixes so symlink realpath check can run
    expect(readFileFn).toHaveBeenCalledWith(
      "/data/coolify/source/.env",
      expect.arrayContaining(["/data/coolify/source/.env"]),
    );
    // APP_URL key is not sensitive — it must appear unchanged
    expect(result).toBe("APP_URL=https://example.com");
  });

  it("reads a file under /data/coolify/proxy/ prefix", async () => {
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => "proxy config");
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/proxy/nginx.conf");

    // R6: readFile receives allowedPrefixes
    expect(readFileFn).toHaveBeenCalledWith(
      "/data/coolify/proxy/nginx.conf",
      expect.arrayContaining(["/data/coolify/proxy/"]),
    );
    expect(result).toBe("proxy config");
  });

  it("rejects paths outside ALLOWED_HOST_FILE_PREFIXES", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.readHostFile("/etc/passwd")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("rejects paths that attempt directory traversal", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.readHostFile("/data/coolify/../../../etc/shadow")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("rejects paths that look like /data/coolify-evil/ prefix", async () => {
    const ops = new HostOps(makeSsh(), makeResolver());

    await expect(ops.readHostFile("/data/coolify-evil/secrets.txt")).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  // ── R6 regression: exact-file allowlist semantics ───────────────────────────

  it("R6: isAllowedHostFilePath rejects .env.backup (suffix bypass on exact-file entry)", () => {
    // The exact-file entry /data/coolify/source/.env must NOT match via startsWith.
    // Without the fix, startsWith would incorrectly allow .env.backup.
    // Test with a minimal allowlist containing only the exact-file entry.
    const onlyExactEntry = ["/data/coolify/source/.env"];
    expect(isAllowedHostFilePath("/data/coolify/source/.env.backup", onlyExactEntry)).toBe(false);
    expect(isAllowedHostFilePath("/data/coolify/source/.env_production", onlyExactEntry)).toBe(false);
    // But the exact path itself IS allowed
    expect(isAllowedHostFilePath("/data/coolify/source/.env", onlyExactEntry)).toBe(true);
  });

  it("R6: isAllowedHostFilePath allows directory children via trailing-slash entries", () => {
    const dirEntry = ["/data/coolify/proxy/"];
    expect(isAllowedHostFilePath("/data/coolify/proxy/nginx.conf", dirEntry)).toBe(true);
    expect(isAllowedHostFilePath("/data/coolify/proxy/", dirEntry)).toBe(true);
    // But other directories are rejected
    expect(isAllowedHostFilePath("/data/coolify/source/.env", dirEntry)).toBe(false);
  });

  // ── R6 regression: .env contents redaction ──────────────────────────────────

  it("R6: readHostFile redacts sensitive values in .env file contents", async () => {
    const envContents = [
      "APP_NAME=CoolApp",
      "APP_KEY=base64:abc123supersecret",
      "DB_PASSWORD=hunter2",
      "DB_HOST=localhost",
      "APP_URL=https://example.com",
    ].join("\n");
    const readFileFn = vi.fn(async (_path: string) => envContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/source/.env");

    // Sensitive values must be redacted
    expect(result).not.toContain("base64:abc123supersecret");
    expect(result).not.toContain("hunter2");
    // Non-sensitive keys must be visible
    expect(result).toContain("APP_NAME=CoolApp");
    expect(result).toContain("DB_HOST=localhost");
    expect(result).toContain("APP_URL=https://example.com");
    // Keys must remain (just values masked)
    expect(result).toContain("APP_KEY=");
    expect(result).toContain("DB_PASSWORD=");
    expect(result).toContain("***REDACTED***");
  });

  it("R6: readHostFile does NOT redact .env contents for non-sensitive files in directory prefix", async () => {
    // Files under /data/coolify/proxy/ (a directory prefix) that are not .env
    // should still pass through without env-style redaction applied incorrectly
    const proxyContents = "server { listen 80; }";
    const readFileFn = vi.fn(async (_path: string) => proxyContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/proxy/nginx.conf");

    expect(result).toBe(proxyContents);
  });
});

// ── H2R1 regression tests ────────────────────────────────────────────────────

describe("H2R1: validateReadOnlySql — expanded blocklist", () => {
  it("H2R1: rejects set_config (privilege/setting write)", () => {
    expect(() => validateReadOnlySql("SELECT set_config('search_path', '', false)")).toThrow(/set_config/i);
  });

  it("H2R1: rejects pg_write_server_file", () => {
    expect(() => validateReadOnlySql("SELECT pg_write_server_file('/etc/cron.d/evil', 'x')")).toThrow(/pg_write_server_file/i);
  });

  it("H2R1: rejects pg_file_write", () => {
    expect(() => validateReadOnlySql("SELECT pg_file_write('/tmp/evil', 'x', false)")).toThrow(/pg_file_write/i);
  });

  it("H2R1: rejects pg_file_rename", () => {
    expect(() => validateReadOnlySql("SELECT pg_file_rename('/a', '/b')")).toThrow(/pg_file_rename/i);
  });

  it("H2R1: rejects pg_file_unlink", () => {
    expect(() => validateReadOnlySql("SELECT pg_file_unlink('/tmp/evil')")).toThrow(/pg_file_unlink/i);
  });

  it("H2R1: rejects pg_reload_conf", () => {
    expect(() => validateReadOnlySql("SELECT pg_reload_conf()")).toThrow(/pg_reload_conf/i);
  });

  it("H2R1: rejects pg_terminate_backend", () => {
    expect(() => validateReadOnlySql("SELECT pg_terminate_backend(1234)")).toThrow(/pg_terminate_backend/i);
  });

  it("H2R1: rejects pg_cancel_backend", () => {
    expect(() => validateReadOnlySql("SELECT pg_cancel_backend(1234)")).toThrow(/pg_cancel_backend/i);
  });

  it("H2R1: rejects pg_signal_backend", () => {
    expect(() => validateReadOnlySql("SELECT pg_signal_backend(1234, 'SIGTERM')")).toThrow(/pg_signal_backend/i);
  });

  it("H2R1: rejects pg_rotate_logfile", () => {
    expect(() => validateReadOnlySql("SELECT pg_rotate_logfile()")).toThrow(/pg_rotate_logfile/i);
  });

  it("H2R1: rejects pg_switch_wal", () => {
    expect(() => validateReadOnlySql("SELECT pg_switch_wal()")).toThrow(/pg_switch_wal/i);
  });

  it("H2R1: rejects pg_log_backend_memory_contexts", () => {
    expect(() => validateReadOnlySql("SELECT pg_log_backend_memory_contexts(1234)")).toThrow(/pg_log_backend_memory_contexts/i);
  });

  it("H2R1: rejects pg_file_settings (config read that can reveal sensitive data, write-related)", () => {
    expect(() => validateReadOnlySql("SELECT * FROM pg_file_settings()")).toThrow(/pg_file_settings/i);
  });

  it("H2R1: rejects set_config in CTE", () => {
    expect(() => validateReadOnlySql("WITH x AS (SELECT set_config('a','b',false)) SELECT * FROM x")).toThrow(/set_config/i);
  });
});

describe("H2R1: psqlReadOnly — uses readonly role and BEGIN READ ONLY / ROLLBACK", () => {
  it("H2R1: connects as dbReadonlyUser, not 'coolify'", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "1", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    await ops.psqlReadOnly("SELECT 1");
    const cmd: string = execFn.mock.calls[0][0] as string;
    expect(cmd).toContain("coolify_ro");
    // Must NOT use the old hardcoded 'coolify' user
    expect(cmd).not.toMatch(/-U coolify(?!_)/);
  });

  it("H2R1: wraps query in BEGIN READ ONLY / ROLLBACK (three -c flags)", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "1", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    await ops.psqlReadOnly("SELECT 42");
    const cmd: string = execFn.mock.calls[0][0] as string;
    // Must have BEGIN READ ONLY, the user SQL, and ROLLBACK as separate -c args
    expect(cmd).toContain("BEGIN READ ONLY");
    expect(cmd).toContain("SELECT 42");
    expect(cmd).toContain("ROLLBACK");
    // Verify ordering: BEGIN before SQL before ROLLBACK
    const beginIdx = cmd.indexOf("BEGIN READ ONLY");
    const sqlIdx = cmd.indexOf("SELECT 42");
    const rollbackIdx = cmd.indexOf("ROLLBACK");
    expect(beginIdx).toBeLessThan(sqlIdx);
    expect(sqlIdx).toBeLessThan(rollbackIdx);
  });

  it("H2R1: forwards PGPASSWORD via stdin, never on the process argv", async () => {
    const execFn = vi.fn(async (_cmd: string, _stdin?: string) => ({ code: 0, stdout: "1", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro", "s3cr3t_pw");
    await ops.psqlReadOnly("SELECT 1");
    const cmd: string = execFn.mock.calls[0][0] as string;
    const stdin = execFn.mock.calls[0][1] as string | undefined;
    // The container gets PGPASSWORD by name (-e PGPASSWORD), read from stdin...
    expect(cmd).toContain("-e PGPASSWORD");
    expect(cmd).toContain("$(cat)");
    // ...and the plaintext secret must NOT appear in the command string (argv).
    expect(cmd).not.toContain("s3cr3t_pw");
    expect(stdin).toBe("s3cr3t_pw");
  });

  it("H2R1: no PGPASSWORD when dbReadonlyPassword is absent", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "1", stderr: "" }));
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "coolify_ro");
    await ops.psqlReadOnly("SELECT 1");
    const cmd: string = execFn.mock.calls[0][0] as string;
    expect(cmd).not.toContain("PGPASSWORD");
  });

  it("H2R1: shell-quotes the readonly user to prevent injection", async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "1", stderr: "" }));
    // User with a tricky character — should be quoted
    const ops = new HostOps(makeSsh({ exec: execFn }), makeResolver(), "readonly'user");
    await ops.psqlReadOnly("SELECT 1");
    const cmd: string = execFn.mock.calls[0][0] as string;
    // shellQuote wraps in single quotes and escapes embedded single quotes
    expect(cmd).toContain("'readonly'\\''user'");
  });
});

describe("H2R1: redactSqlOutput — handles leading SET/BEGIN lines before header", () => {
  it("H2R1: redacts secret column even when output has leading SET/BEGIN/ROLLBACK lines", () => {
    // psql outputs SET, BEGIN, and ROLLBACK lines when using -c 'BEGIN READ ONLY' etc.
    // The table header is NOT the first line; redactSqlOutput must find it correctly.
    const raw = [
      "SET",
      "BEGIN",
      "",
      " password       | name  ",
      "----------------+-------",
      " supersecret123 | alice ",
      "(1 row)",
      "",
      "ROLLBACK",
    ].join("\n");
    const result = redactSqlOutput(raw);
    expect(result).not.toContain("supersecret123");
    expect(result).toContain("***REDACTED***");
    // Non-sensitive column must still be visible
    expect(result).toContain("alice");
  });

  it("H2R1: still redacts when output is clean (no leading noise)", () => {
    const raw = [
      " password   | name  ",
      "------------+-------",
      " myhunter2  | bob   ",
    ].join("\n");
    const result = redactSqlOutput(raw);
    expect(result).not.toContain("myhunter2");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("bob");
  });
});

describe("H2R1: redactSqlOutput — entropy/value-pattern pass (alias bypass defense)", () => {
  it("H2R1: masks bcrypt hash regardless of column name alias", () => {
    // Attack: SELECT password AS val FROM users — column name is 'val', not sensitive
    // The entropy pass must catch the bcrypt value pattern regardless of column name.
    const raw = [
      " val                                                                   ",
      "-----------------------------------------------------------------------",
      " $2b$12$abcdefghijklmnopqrstuuVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVA ",
    ].join("\n");
    const result = redactSqlOutput(raw);
    expect(result).not.toContain("$2b$12$");
    expect(result).toContain("***REDACTED***");
  });

  it("H2R1: masks long base64/hex (>=32 chars) regardless of column name", () => {
    // 32+ char base64 string in a column named 'data' (not a sensitive key name)
    const longB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"; // 32 chars
    const raw = [
      " data                             ",
      "----------------------------------",
      ` ${longB64} `,
    ].join("\n");
    const result = redactSqlOutput(raw);
    expect(result).not.toContain(longB64);
    expect(result).toContain("***REDACTED***");
  });

  it("H2R1: does NOT mask short values that are not secret-looking", () => {
    const raw = [
      " count | status ",
      "-------+--------",
      "    42 | active ",
    ].join("\n");
    const result = redactSqlOutput(raw);
    // No redaction expected for short safe values
    expect(result).not.toContain("***REDACTED***");
    expect(result).toContain("42");
    expect(result).toContain("active");
  });
});

describe("H2R1: redactSqlOutput — partial/truncated PEM fallback", () => {
  it("H2R1: masks output containing BEGIN marker with no END (truncated PEM)", () => {
    const raw = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAzW2...";
    const result = redactSqlOutput(raw);
    expect(result).not.toContain("MIIEpAIBAAKCAQEAzW2");
    expect(result).toContain("***REDACTED***");
  });

  it("H2R1: still redacts complete PEM block (existing behaviour preserved)", () => {
    const raw = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEAzW2...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = redactSqlOutput(raw);
    expect(result).not.toContain("MIIEpAIBAAKCAQEAzW2");
    expect(result).toContain("***REDACTED***");
  });
});

// ── H2R4 regression tests: broadened .env redaction ─────────────────────────

describe("H2R4: redactEnvFileContents — broadened path matching", () => {
  // 1. Files with basename ".env" at other paths get redacted
  it("H2R4: redacts SECRET in /data/coolify/proxy/.env", async () => {
    const envContents = [
      "PROXY_NAME=myproxy",
      "SECRET_TOKEN=supersecretvalue",
      "PROXY_PORT=8080",
    ].join("\n");
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => envContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/proxy/.env");

    expect(result).not.toContain("supersecretvalue");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("PROXY_NAME=myproxy");
    expect(result).toContain("PROXY_PORT=8080");
  });

  it("H2R4: redacts SECRET in /data/coolify/db/.env", async () => {
    const envContents = [
      "DB_HOST=localhost",
      "DB_PASSWORD=db_super_secret",
      "DB_PORT=5432",
    ].join("\n");
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => envContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/db/.env");

    expect(result).not.toContain("db_super_secret");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("DB_HOST=localhost");
    expect(result).toContain("DB_PORT=5432");
  });

  // 2. Files whose basename STARTS with ".env." get redacted
  it("H2R4: redacts SECRET in /data/coolify/source/.env.local", async () => {
    const envContents = "APP_KEY=localkey\nDB_PASSWORD=local_password\nAPP_NAME=local";
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => envContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/source/.env.local");

    expect(result).not.toContain("local_password");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("APP_NAME=local");
  });

  it("H2R4: redacts SECRET in /data/coolify/source/.env.production", async () => {
    const envContents = "SECRET_KEY=prod_secret_val\nAPP_ENV=production";
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => envContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/source/.env.production");

    expect(result).not.toContain("prod_secret_val");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("APP_ENV=production");
  });

  // 3. Files whose basename ENDS with ".env" get redacted
  it("H2R4: redacts SECRET in /data/coolify/source/app.env", async () => {
    const envContents = "API_KEY=apikey12345\nAPP_HOST=example.com";
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => envContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/source/app.env");

    expect(result).not.toContain("apikey12345");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("APP_HOST=example.com");
  });

  // 4. Non-.env files in directory prefixes are NOT redacted
  it("H2R4: does NOT redact non-.env file contents (nginx.conf remains unchanged)", async () => {
    const nginxContents = "server { listen 80; server_name example.com; }";
    const readFileFn = vi.fn(async (_path: string, _prefixes?: string[]) => nginxContents);
    const ops = new HostOps(makeSsh({ readFile: readFileFn }), makeResolver());

    const result = await ops.readHostFile("/data/coolify/proxy/nginx.conf");

    expect(result).toBe(nginxContents);
    expect(result).not.toContain("***REDACTED***");
  });
});

describe("H2R4: redactEnvFileContents — stateful multi-line secret masking", () => {
  // 5. Backslash-continuation: continuation lines of a sensitive KEY must be fully masked
  it("H2R4: fully redacts backslash-continued secret value (no continuation leaks)", () => {
    const raw = [
      "APP_NAME=MyCoolApp",
      "APP_KEY=base64:lineonecontinue\\",
      "  continuedonline2\\",
      "  finalline",
      "DB_HOST=localhost",
    ].join("\n");

    const result = redactEnvFileContents(raw);

    expect(result).not.toContain("lineonecontinue");
    expect(result).not.toContain("continuedonline2");
    expect(result).not.toContain("finalline");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("APP_NAME=MyCoolApp");
    expect(result).toContain("DB_HOST=localhost");
  });

  // 6. Double-quoted multi-line secret: lines inside open quote must be fully masked
  it("H2R4: fully redacts double-quoted multi-line secret (no inner lines leak)", () => {
    const raw = [
      "APP_NAME=MyApp",
      'DB_PASSWORD="line one of secret',
      "  line two of secret",
      '  line three"',
      "DB_HOST=127.0.0.1",
    ].join("\n");

    const result = redactEnvFileContents(raw);

    expect(result).not.toContain("line one of secret");
    expect(result).not.toContain("line two of secret");
    expect(result).not.toContain("line three");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("APP_NAME=MyApp");
    expect(result).toContain("DB_HOST=127.0.0.1");
  });

  // 7. Single-quoted multi-line secret
  it("H2R4: fully redacts single-quoted multi-line secret", () => {
    const raw = [
      "APP_NAME=MyApp",
      "SECRET_TOKEN='begin-secret",
      "  middle-secret",
      "  end-secret'",
      "APP_URL=https://example.com",
    ].join("\n");

    const result = redactEnvFileContents(raw);

    expect(result).not.toContain("begin-secret");
    expect(result).not.toContain("middle-secret");
    expect(result).not.toContain("end-secret");
    expect(result).toContain("***REDACTED***");
    expect(result).toContain("APP_NAME=MyApp");
    expect(result).toContain("APP_URL=https://example.com");
  });

  // 8. Non-sensitive key with backslash continuation must NOT be redacted
  it("H2R4: does NOT redact backslash-continued non-sensitive key", () => {
    const raw = [
      "APP_NAME=My\\",
      "  CoolApp",
      "DB_HOST=localhost",
    ].join("\n");

    const result = redactEnvFileContents(raw);

    expect(result).not.toContain("***REDACTED***");
    expect(result).toContain("APP_NAME=My\\");
    expect(result).toContain("  CoolApp");
    expect(result).toContain("DB_HOST=localhost");
  });
});
