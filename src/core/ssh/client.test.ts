// src/core/ssh/client.test.ts
import { createHash } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- known_hosts helpers (H2R5 fix 3) ----------------------------------------
// Build a fake known_hosts line for a host using arbitrary raw key bytes.
// Format: "hostname key-type base64(rawKeyBytes)"
// The hostVerifier receives rawKeyBytes as a Buffer, SHA-256s it, and compares
// against SHA-256(base64-decoded key from known_hosts file).
function makeKnownHostsLine(hostname: string, rawKeyBytes: Buffer, keyType = "ssh-ed25519"): string {
  return `${hostname} ${keyType} ${rawKeyBytes.toString("base64")}`;
}

// ---- hoisted mock definitions so vi.mock factory can reference them ----
const { mockSftpReadFile, mockSftpRealpath, mockSftpStat, mockSftpInstance, mockChannelSignal, mockStreamEnd, MockStream, MockClient } = vi.hoisted(() => {
  const mockSftpReadFile = vi.fn();
  const mockSftpRealpath = vi.fn();
  const mockSftpStat = vi.fn();
  const mockSftpInstance = { fastGet: vi.fn(), readFile: mockSftpReadFile, realpath: mockSftpRealpath, stat: mockSftpStat };
  const mockChannelSignal = vi.fn();
  const mockStreamEnd = vi.fn();

  class MockStream {
    private _dataListeners: ((data: Buffer) => void)[] = [];
    private _stderrDataListeners: ((data: Buffer) => void)[] = [];
    private _closeListeners: ((code: number | null) => void)[] = [];
    stderr = {
      on: (evt: string, fn: (data: Buffer) => void) => {
        if (evt === "data") this._stderrDataListeners.push(fn);
      },
    };
    on(evt: string, fn: (data: Buffer | number | null) => void) {
      if (evt === "data") this._dataListeners.push(fn as (d: Buffer) => void);
      if (evt === "close") this._closeListeners.push(fn as (code: number | null) => void);
      return this;
    }
    signal(sig: string) { mockChannelSignal(sig); }
    end(data?: string) { mockStreamEnd(data); }
    emitData(data: string) { this._dataListeners.forEach(fn => fn(Buffer.from(data))); }
    emitStderr(data: string) { this._stderrDataListeners.forEach(fn => fn(Buffer.from(data))); }
    emitClose(code: number | null) { this._closeListeners.forEach(fn => fn(code)); }
  }

  let execCallback: ((err: Error | undefined, stream: MockStream) => void) | null = null;
  let sftpCallback: ((err: Error | undefined, sftp: typeof mockSftpInstance) => void) | null = null;
  let connectCallback: (() => void) | null = null;
  let errorCallback: ((err: Error) => void) | null = null;
  let lastConnectConfig: Record<string, unknown> | null = null;

  class MockClient {
    static getExecCallback() { return execCallback; }
    static getSftpCallback() { return sftpCallback; }
    static getConnectCallback() { return connectCallback; }
    static getErrorCallback() { return errorCallback; }
    static getLastConnectConfig() { return lastConnectConfig; }
    static reset() {
      execCallback = null;
      sftpCallback = null;
      connectCallback = null;
      errorCallback = null;
      lastConnectConfig = null;
    }

    on(evt: string, fn: (...args: unknown[]) => void) {
      if (evt === "ready") connectCallback = fn as () => void;
      if (evt === "error") errorCallback = fn as (err: Error) => void;
      return this;
    }
    connect(cfg: Record<string, unknown>) { lastConnectConfig = cfg; }
    exec(_cmd: string, fn: (err: Error | undefined, stream: MockStream) => void) {
      execCallback = fn;
    }
    sftp(fn: (err: Error | undefined, sftp: typeof mockSftpInstance) => void) {
      sftpCallback = fn;
    }
    end() {}
  }

  return { mockSftpReadFile, mockSftpRealpath, mockSftpStat, mockSftpInstance, mockChannelSignal, mockStreamEnd, MockStream, MockClient };
});

vi.mock("ssh2", () => ({
  Client: MockClient,
}));

// Also mock fs so readFileSync doesn't fail during connect() in tests
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from("mock-private-key")),
}));

import { SshClient } from "./client.js";
import { readFileSync } from "fs";

// A real SHA-256 digest of the string "mock-key-material" encoded as hex —
// used so the hostVerifier can be exercised with a known-good fingerprint.
const MOCK_KEY_MATERIAL = Buffer.from("mock-private-key");
const MOCK_KEY_SHA256_HEX = createHash("sha256").update(MOCK_KEY_MATERIAL).digest("hex");

const baseCfg = {
  host: "1.2.3.4",
  user: "root",
  port: 22,
  keyPath: "/home/user/.ssh/id_rsa",
  // R9: required for strict host key verification
  hostFingerprint: MOCK_KEY_SHA256_HEX,
};

describe("SshClient", () => {
  beforeEach(() => {
    MockClient.reset();
    vi.clearAllMocks();
    // Default: files are small so readFile tests proceed straight to the read.
    mockSftpStat.mockImplementation(
      (_p: string, cb: (e: Error | null, s: { size: number }) => void) => cb(null, { size: 100 }),
    );
  });

  describe("connect()", () => {
    it("resolves when ssh2 client fires ready", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      // simulate ssh2 firing ready
      MockClient.getConnectCallback()!();
      await expect(connectPromise).resolves.toBeUndefined();
    });

    it("rejects when ssh2 client fires error", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getErrorCallback()!(new Error("connection refused"));
      await expect(connectPromise).rejects.toThrow("connection refused");
    });

    // R9: SSH host-key verification hardening
    it("R9: passes readyTimeout: 10000 to ssh2.connect()", async () => {
      const client = new SshClient(baseCfg);
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!["readyTimeout"]).toBe(10_000);
    });

    it("R9: passes passphrase to ssh2.connect() when set in SshConfig", async () => {
      const client = new SshClient({ ...baseCfg, passphrase: "hunter2" });
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      expect(cfg!["passphrase"]).toBe("hunter2");
    });

    it("R9: passes algorithm restrictions to ssh2.connect()", async () => {
      const client = new SshClient(baseCfg);
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const alg = cfg!["algorithms"] as Record<string, string[]>;
      expect(alg["kex"]).toContain("curve25519-sha256");
      expect(alg["cipher"]).toContain("aes256-gcm@openssh.com");
      expect(alg["hmac"]).toContain("hmac-sha2-256-etm@openssh.com");
    });

    // H2R5 fix 2: SSH host-key algorithm pinning
    it("H2R5: passes serverHostKey allowlist to ssh2.connect()", async () => {
      const client = new SshClient(baseCfg);
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const alg = cfg!["algorithms"] as Record<string, string[]>;
      expect(alg["serverHostKey"]).toBeDefined();
      expect(alg["serverHostKey"]).toContain("ssh-ed25519");
      expect(alg["serverHostKey"]).toContain("ecdsa-sha2-nistp256");
      expect(alg["serverHostKey"]).toContain("rsa-sha2-256");
      expect(alg["serverHostKey"]).toContain("rsa-sha2-512");
      // Legacy weak algorithms must not be present
      expect(alg["serverHostKey"]).not.toContain("ssh-dss");
      expect(alg["serverHostKey"]).not.toContain("ssh-rsa");
    });

    it("R9: hostVerifier returns true when key matches the configured hex fingerprint", () => {
      // The vulnerability: without verification, any server key is accepted (MITM).
      // After the fix, hostVerifier must return true only for the correct key.
      const client = new SshClient(baseCfg);
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      expect(typeof hostVerifier).toBe("function");
      // The mock readFileSync returns Buffer.from("mock-private-key"), and our baseCfg
      // hostFingerprint is the SHA-256 hex of that same buffer — should match.
      const result = hostVerifier(MOCK_KEY_MATERIAL);
      expect(result).toBe(true);
    });

    it("R9: hostVerifier returns false for a wrong key (MITM attack blocked)", () => {
      // Attack payload: an attacker presents a different key.
      // The verifier must return false, which aborts the handshake.
      const client = new SshClient(baseCfg);
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      const attackerKey = Buffer.from("evil-server-public-key-injected-by-mitm");
      expect(hostVerifier(attackerKey)).toBe(false);
    });

    it("R9: hostVerifier returns false when no fingerprint is configured (fail-closed)", () => {
      // Even if SshConfig.hostFingerprint is empty string, the verifier must refuse.
      const client = new SshClient({ ...baseCfg, hostFingerprint: "" });
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      expect(hostVerifier(MOCK_KEY_MATERIAL)).toBe(false);
    });

    it("R9: hostVerifier accepts base64-encoded SHA-256 fingerprint", () => {
      // Operators may provide the fingerprint in base64 (e.g. from ssh-keygen -l -E sha256)
      const b64Fingerprint = createHash("sha256").update(MOCK_KEY_MATERIAL).digest("base64");
      const client = new SshClient({ ...baseCfg, hostFingerprint: b64Fingerprint });
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      expect(hostVerifier(MOCK_KEY_MATERIAL)).toBe(true);
      // Wrong key must still fail
      expect(hostVerifier(Buffer.from("not-the-key"))).toBe(false);
    });

    // H2R5 fix 3: knownHostsPath — previously accepted in config but silently ignored.
    // When only knownHostsPath is set (no hostFingerprint), the verifier must parse
    // the known_hosts file and do a timing-safe compare of SHA-256 digests.
    it("H2R5: hostVerifier returns true when key matches a known_hosts entry (host match)", () => {
      const serverKey = Buffer.from("fake-ed25519-server-public-key-bytes");
      const knownHostsContent = makeKnownHostsLine("1.2.3.4", serverKey);
      // readFileSync: first call = private key, second call = known_hosts
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path === "/etc/known_hosts") return Buffer.from(knownHostsContent);
        return Buffer.from("mock-private-key");
      });

      const client = new SshClient({ ...baseCfg, hostFingerprint: "", knownHostsPath: "/etc/known_hosts" });
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      expect(hostVerifier(serverKey)).toBe(true);
    });

    it("H2R5: hostVerifier returns false when key does NOT match the known_hosts entry (reject MITM)", () => {
      const storedKey = Buffer.from("legitimate-server-key");
      const attackerKey = Buffer.from("attacker-server-key");
      const knownHostsContent = makeKnownHostsLine("1.2.3.4", storedKey);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path === "/etc/known_hosts") return Buffer.from(knownHostsContent);
        return Buffer.from("mock-private-key");
      });

      const client = new SshClient({ ...baseCfg, hostFingerprint: "", knownHostsPath: "/etc/known_hosts" });
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      expect(hostVerifier(attackerKey)).toBe(false);
    });

    it("H2R5: hostVerifier returns false when host not found in known_hosts (fail-closed)", () => {
      // The known_hosts file has an entry for a DIFFERENT host — must fail-closed.
      const serverKey = Buffer.from("some-key-bytes");
      const knownHostsContent = makeKnownHostsLine("9.9.9.9", serverKey);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path === "/etc/known_hosts") return Buffer.from(knownHostsContent);
        return Buffer.from("mock-private-key");
      });

      const client = new SshClient({ ...baseCfg, hostFingerprint: "", knownHostsPath: "/etc/known_hosts" });
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      expect(hostVerifier(serverKey)).toBe(false);
    });

    it("H2R5: hostVerifier matches [host]:port form in known_hosts", () => {
      const serverKey = Buffer.from("port-specific-key-bytes");
      // baseCfg has port:22, but test with custom port to exercise the [host]:port form
      const cfgWithPort = { ...baseCfg, host: "10.0.0.1", port: 2222, hostFingerprint: "", knownHostsPath: "/etc/known_hosts" };
      const knownHostsContent = makeKnownHostsLine("[10.0.0.1]:2222", serverKey);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path === "/etc/known_hosts") return Buffer.from(knownHostsContent);
        return Buffer.from("mock-private-key");
      });

      const client = new SshClient(cfgWithPort);
      client.connect();
      const cfg = MockClient.getLastConnectConfig();
      const hostVerifier = cfg!["hostVerifier"] as (key: Buffer) => boolean;
      expect(hostVerifier(serverKey)).toBe(true);
    });
  });

  describe("exec()", () => {
    it("resolves with stdout, stderr, and exit code", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const execPromise = client.exec("echo hello");
      const stream = new MockStream();
      MockClient.getExecCallback()!(undefined, stream);
      stream.emitData("hello\n");
      stream.emitStderr("warn\n");
      stream.emitClose(0);

      const result = await execPromise;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toBe("warn\n");
    });

    it("rejects when exec returns error", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const execPromise = client.exec("bad cmd");
      MockClient.getExecCallback()!(new Error("exec failed"), undefined as unknown as InstanceType<typeof MockStream>);
      await expect(execPromise).rejects.toThrow("exec failed");
    });

    it("rejects and KILLs the channel when output exceeds maxOutputBytes", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const execPromise = client.exec("cat huge", undefined, { maxOutputBytes: 8 });
      const stream = new MockStream();
      MockClient.getExecCallback()!(undefined, stream);
      stream.emitData("0123456789"); // 10 bytes > 8-byte cap

      await expect(execPromise).rejects.toThrow(/limit|exceed/i);
      expect(mockChannelSignal).toHaveBeenCalledWith("KILL");
    });

    it("rejects and KILLs the channel when STDERR exceeds maxOutputBytes (not just stdout)", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const execPromise = client.exec("noisy", undefined, { maxOutputBytes: 8 });
      const stream = new MockStream();
      MockClient.getExecCallback()!(undefined, stream);
      stream.emitStderr("0123456789"); // 10 bytes of stderr > 8-byte cap

      await expect(execPromise).rejects.toThrow(/limit|exceed/i);
      expect(mockChannelSignal).toHaveBeenCalledWith("KILL");
    });

    it("rejects and KILLs the channel after timeoutMs elapses", async () => {
      vi.useFakeTimers();
      try {
        const client = new SshClient(baseCfg);
        const connectPromise = client.connect();
        MockClient.getConnectCallback()!();
        await connectPromise;

        const execPromise = client.exec("sleep 999", undefined, { timeoutMs: 1000 });
        const stream = new MockStream();
        MockClient.getExecCallback()!(undefined, stream);
        const assertion = expect(execPromise).rejects.toThrow(/timeout|timed out/i);
        await vi.advanceTimersByTimeAsync(1001);
        await assertion;
        expect(mockChannelSignal).toHaveBeenCalledWith("KILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("accumulates multiple data chunks", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const execPromise = client.exec("cat big-file");
      const stream = new MockStream();
      MockClient.getExecCallback()!(undefined, stream);
      stream.emitData("chunk1\n");
      stream.emitData("chunk2\n");
      stream.emitClose(0);

      const result = await execPromise;
      expect(result.stdout).toBe("chunk1\nchunk2\n");
    });
  });

  describe("streamExec()", () => {
    it("calls onLine for each newline-delimited chunk and resolves on close", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const lines: string[] = [];
      const ac = new AbortController();
      const streamPromise = client.streamExec("tail -f /var/log/syslog", (l) => lines.push(l), ac.signal);

      const stream = new MockStream();
      MockClient.getExecCallback()!(undefined, stream);
      stream.emitData("line one\nline two\n");
      stream.emitClose(0);

      const result = await streamPromise;
      expect(result.code).toBe(0);
      expect(lines).toEqual(["line one", "line two"]);
    });

    it("sends KILL signal on abort and resolves with null code", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const ac = new AbortController();
      const streamPromise = client.streamExec("sleep 100", () => {}, ac.signal);

      const stream = new MockStream();
      MockClient.getExecCallback()!(undefined, stream);

      // abort fires the signal
      ac.abort();
      stream.emitClose(null);

      const result = await streamPromise;
      expect(mockChannelSignal).toHaveBeenCalledWith("KILL");
      expect(result.code).toBe(null);
    });

    it("handles partial lines across multiple data events", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const lines: string[] = [];
      const ac = new AbortController();
      const streamPromise = client.streamExec("cmd", (l) => lines.push(l), ac.signal);

      const stream = new MockStream();
      MockClient.getExecCallback()!(undefined, stream);
      stream.emitData("par");
      stream.emitData("tial\nfull\n");
      stream.emitClose(0);

      await streamPromise;
      expect(lines).toEqual(["partial", "full"]);
    });
  });

  describe("readFile()", () => {
    it("resolves with file contents via sftp", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      mockSftpReadFile.mockImplementation(
        (_path: string, cb: (err: Error | null, data: Buffer) => void) => {
          cb(null, Buffer.from("file contents"));
        }
      );

      const readPromise = client.readFile("/etc/hosts");
      MockClient.getSftpCallback()!(undefined, mockSftpInstance as unknown as typeof mockSftpInstance);

      const result = await readPromise;
      expect(result).toBe("file contents");
    });

    it("rejects when sftp returns error", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      const readPromise = client.readFile("/root/secret");
      MockClient.getSftpCallback()!(new Error("sftp open failed"), undefined as unknown as typeof mockSftpInstance);

      await expect(readPromise).rejects.toThrow("sftp open failed");
    });

    // ── R6: symlink defense ─────────────────────────────────────────────────────

    it("R6: rejects when realpath resolves outside allowedPrefixes (symlink escape to /etc/shadow)", async () => {
      // Scenario: /data/coolify/source/.env is a symlink pointing to /etc/shadow.
      // sftp.realpath returns the real target path, which is outside the allowlist.
      // The readFile call must reject without reading the file.
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      mockSftpRealpath.mockImplementation(
        (_path: string, cb: (err: Error | null, resolvedPath: string) => void) => {
          // Simulate the symlink resolving to /etc/shadow
          cb(null, "/etc/shadow");
        },
      );
      // readFile should NOT be called because the realpath check fails
      mockSftpReadFile.mockImplementation(
        (_path: string, cb: (err: Error | null, data: Buffer) => void) => {
          cb(null, Buffer.from("root:x:0:0:root:/root:/bin/bash\n"));
        },
      );

      const allowedPrefixes = ["/data/coolify/source/.env", "/data/coolify/proxy/", "/data/coolify/"];
      const readPromise = client.readFile("/data/coolify/source/.env", allowedPrefixes);
      MockClient.getSftpCallback()!(undefined, mockSftpInstance as unknown as typeof mockSftpInstance);

      await expect(readPromise).rejects.toThrow(/outside allowed/i);
      // The actual file read must not have been attempted
      expect(mockSftpReadFile).not.toHaveBeenCalled();
    });

    it("R6: allows when realpath resolves to an in-allowlist path", async () => {
      // Scenario: real path resolves within the allowed directory.
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      mockSftpRealpath.mockImplementation(
        (_path: string, cb: (err: Error | null, resolvedPath: string) => void) => {
          cb(null, "/data/coolify/source/.env");
        },
      );
      mockSftpReadFile.mockImplementation(
        (_path: string, cb: (err: Error | null, data: Buffer) => void) => {
          cb(null, Buffer.from("APP_KEY=secret\n"));
        },
      );

      const allowedPrefixes = ["/data/coolify/source/.env", "/data/coolify/proxy/", "/data/coolify/"];
      const readPromise = client.readFile("/data/coolify/source/.env", allowedPrefixes);
      MockClient.getSftpCallback()!(undefined, mockSftpInstance as unknown as typeof mockSftpInstance);

      const result = await readPromise;
      expect(result).toBe("APP_KEY=secret\n");
    });

    it("rejects a file larger than the size cap without reading it", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      // stat reports a huge file (over the 5 MiB cap)
      mockSftpStat.mockImplementation(
        (_p: string, cb: (e: Error | null, s: { size: number }) => void) =>
          cb(null, { size: 50 * 1024 * 1024 }),
      );

      const readPromise = client.readFile("/etc/hosts");
      MockClient.getSftpCallback()!(undefined, mockSftpInstance as unknown as typeof mockSftpInstance);

      await expect(readPromise).rejects.toThrow(/over the .* limit/i);
      expect(mockSftpReadFile).not.toHaveBeenCalled();
    });

    it("rejects a binary file (NUL byte) instead of returning corrupt UTF-8", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;

      mockSftpReadFile.mockImplementation(
        (_path: string, cb: (err: Error | null, data: Buffer) => void) => {
          cb(null, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));
        },
      );

      const readPromise = client.readFile("/etc/hosts");
      MockClient.getSftpCallback()!(undefined, mockSftpInstance as unknown as typeof mockSftpInstance);

      await expect(readPromise).rejects.toThrow(/binary/i);
    });
  });

  describe("close()", () => {
    it("calls end on the underlying client without throwing", async () => {
      const client = new SshClient(baseCfg);
      const connectPromise = client.connect();
      MockClient.getConnectCallback()!();
      await connectPromise;
      await expect(client.close()).resolves.toBeUndefined();
    });
  });
});
