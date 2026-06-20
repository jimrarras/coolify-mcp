// src/core/ssh/client.ts
import { createHash, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Client } from "ssh2";

// Upper bound on a single host-file read. The allowlist scope (/data/coolify/**)
// can contain large logs/artifacts; reading a multi-GB file would buffer it
// entirely in this process and risk an OOM, so cap it (config/.env files are tiny).
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;

export interface SshConnectConfig {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  hostFingerprint?: string;
  knownHostsPath?: string;
  passphrase?: string;
}

export interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Builds a strict host-key verifier function for use with ssh2.
 *
 * R9/H2R5: fail-closed — returns false unless the key matches either:
 *   Branch 1: an inline SHA-256 fingerprint (cfg.hostFingerprint), or
 *   Branch 2: an entry in a known_hosts file.
 *
 * Default: when neither hostFingerprint nor knownHostsPath is configured,
 * falls back to ~/.ssh/known_hosts (derived from homeDir). Still fail-closed:
 * a missing/non-matching file => false.
 */
export function makeHostVerifier(cfg: SshConnectConfig, homeDir: string): (keyBuf: Buffer) => boolean {
  const expectedFingerprint = cfg.hostFingerprint;
  // Default source: when neither a fingerprint nor an explicit known_hosts path is given,
  // fall back to ~/.ssh/known_hosts. Still fail-closed: a missing/non-matching file => false.
  const knownHostsPath = cfg.knownHostsPath ?? (expectedFingerprint ? undefined : join(homeDir, ".ssh", "known_hosts"));
  const sshHost = cfg.host;
  const sshPort = cfg.port;

  return (keyBuf: Buffer): boolean => {
    // Branch 1: inline fingerprint takes precedence.
    if (expectedFingerprint) {
      const digest = createHash("sha256").update(keyBuf).digest();
      // Normalise expected: strip colons, lowercase, then try to parse as hex or base64.
      const norm = expectedFingerprint.replace(/:/g, "").toLowerCase();
      let expectedBuf: Buffer;
      if (/^[0-9a-f]{64}$/.test(norm)) {
        // 64 hex chars = 32 bytes
        expectedBuf = Buffer.from(norm, "hex");
      } else {
        // Assume base64 (e.g. "SHA256:…" style — strip the prefix if present)
        const b64 = expectedFingerprint.replace(/^SHA256:/i, "");
        expectedBuf = Buffer.from(b64, "base64");
      }
      if (digest.length !== expectedBuf.length) {
        return false;
      }
      return timingSafeEqual(digest, expectedBuf);
    }

    // Branch 2: fall back to known_hosts file lookup.
    if (knownHostsPath) {
      try {
        const content = readFileSync(knownHostsPath).toString("utf8");
        const presentedDigest = createHash("sha256").update(keyBuf).digest();

        // Hostnames to match: bare "host" and "[host]:port" form.
        const hostToken = sshHost;
        const portToken = `[${sshHost}]:${sshPort}`;

        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          // Skip comments and empty lines.
          if (!line || line.startsWith("#")) continue;

          // known_hosts format: "hostname[,hostname2,...] key-type base64-key [comment]"
          const parts = line.split(/\s+/);
          if (parts.length < 3) continue;

          const [hostField, , keyB64] = parts;
          const hosts = hostField.split(",");
          const matches = hosts.some((h) => h === hostToken || h === portToken);
          if (!matches) continue;

          // Decode the stored key and SHA-256 it, then compare timing-safely.
          const storedKeyBuf = Buffer.from(keyB64, "base64");
          const storedDigest = createHash("sha256").update(storedKeyBuf).digest();
          if (storedDigest.length === presentedDigest.length && timingSafeEqual(storedDigest, presentedDigest)) {
            return true;
          }
        }
      } catch {
        // File unreadable — fail closed.
      }
      return false;
    }

    // No fingerprint and no known_hosts path — fail closed.
    return false;
  };
}

export class SshClient {
  private readonly cfg: SshConnectConfig;
  private conn: InstanceType<typeof Client> | null = null;

  constructor(cfg: SshConnectConfig) {
    this.cfg = cfg;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const conn = new Client();
      conn.on("ready", () => {
        this.conn = conn;
        resolve();
      });
      conn.on("error", (err: Error) => {
        reject(err);
      });

      // R9: build a strict host-key verifier using the extracted makeHostVerifier.
      // ssh2 SyncHostVerifier receives the raw host key as a Buffer (no hostHash needed).
      // We compute SHA-256 ourselves so the comparison is stable regardless of how the
      // fingerprint was provided (base64 or lowercase hex, with or without colons).
      //
      // H2R5: when no inline fingerprint is set but cfg.knownHostsPath is set, parse the
      // known_hosts file and find entries matching cfg.host (or [host]:port form).
      // Each matching entry's base64 key is decoded, SHA-256'd, and compared timing-safely
      // against SHA-256(keyBuf). Returns false (fail-closed) if no entry matches.
      // Default: ~/.ssh/known_hosts is used when neither fingerprint nor path is configured.
      const hostVerifier = makeHostVerifier(this.cfg, homedir());

      conn.connect({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.user,
        privateKey: readFileSync(this.cfg.keyPath),
        passphrase: this.cfg.passphrase,
        readyTimeout: 10_000,
        hostVerifier,
        algorithms: {
          kex: ["curve25519-sha256", "ecdh-sha2-nistp256"],
          cipher: ["aes256-gcm@openssh.com", "aes128-gcm@openssh.com"],
          hmac: ["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com"],
          // H2R5: pin server host-key algorithms — excludes legacy ssh-dss and sha1 ssh-rsa.
          serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-256", "rsa-sha2-512"],
        },
      });
    });
  }

  exec(
    command: string,
    stdin?: string,
    opts?: { maxOutputBytes?: number; timeoutMs?: number },
  ): Promise<SshExecResult> {
    const conn = this._requireConn();
    const maxOutputBytes = opts?.maxOutputBytes;
    const timeoutMs = opts?.timeoutMs;
    return new Promise<SshExecResult>((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        let outBytes = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        // Settle once; tear down the timer and KILL the remote process on the
        // abnormal (cap/timeout) paths so a runaway query can't keep streaming.
        const settle = (fn: () => void, kill: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (kill) {
            try {
              stream.signal("KILL");
            } catch {
              // stream may already be closed — ignore
            }
          }
          fn();
        };

        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            settle(() => reject(new Error(`exec: command exceeded ${timeoutMs}ms timeout`)), true);
          }, timeoutMs);
          // Don't keep the event loop alive solely for this timer.
          (timer as { unref?: () => void }).unref?.();
        }

        // Count BOTH stdout and stderr against one combined cap — a runaway command
        // can flood either channel, so an stderr-only flood must trip the cap too.
        const onChunk = (data: Buffer, isStderr: boolean): void => {
          if (settled) return;
          if (maxOutputBytes !== undefined) {
            outBytes += data.length;
            if (outBytes > maxOutputBytes) {
              settle(() => reject(new Error(`exec: output exceeded the ${maxOutputBytes}-byte limit`)), true);
              return;
            }
          }
          if (isStderr) stderr += data.toString();
          else stdout += data.toString();
        };
        stream.on("data", (data: Buffer) => onChunk(data, false));
        stream.stderr.on("data", (data: Buffer) => onChunk(data, true));
        stream.on("close", (code: number | null) => {
          settle(() => resolve({ code: code ?? -1, stdout, stderr }), false);
        });
        // Feed stdin when provided (e.g. a secret read via `$(cat)` so it never
        // appears in the remote process argv), then close the write side.
        if (stdin !== undefined) {
          stream.end(stdin);
        }
      });
    });
  }

  streamExec(
    command: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ): Promise<{ code: number | null }> {
    const conn = this._requireConn();
    return new Promise<{ code: number | null }>((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let buffer = "";

        const flushBuffer = () => {
          const parts = buffer.split("\n");
          // everything except the last piece is a complete line
          for (let i = 0; i < parts.length - 1; i++) {
            onLine(parts[i]);
          }
          buffer = parts[parts.length - 1];
        };

        stream.on("data", (data: Buffer) => {
          buffer += data.toString();
          flushBuffer();
        });

        stream.on("close", (code: number | null) => {
          // flush any remaining partial line
          if (buffer.length > 0) {
            onLine(buffer);
            buffer = "";
          }
          resolve({ code });
        });

        // Wire up abort signal to kill the remote process
        const abortHandler = () => {
          try {
            stream.signal("KILL");
          } catch {
            // ignore if stream already closed
          }
        };
        if (signal.aborted) {
          abortHandler();
        } else {
          signal.addEventListener("abort", abortHandler, { once: true });
        }
      });
    });
  }

  /**
   * Read a remote file over SFTP.
   *
   * When `allowedPrefixes` is supplied the method first calls `sftp.realpath`
   * to resolve symlinks and then re-validates the canonical path against the
   * allowlist before reading the file content.  This defeats symlink-escape
   * attacks (e.g. /data/coolify/source/.env → /etc/shadow).
   *
   * Allowlist semantics match `isAllowedHostFilePath`:
   *   - Prefix WITHOUT trailing slash → exact match only.
   *   - Prefix WITH trailing slash    → startsWith (directory).
   */
  readFile(path: string, allowedPrefixes?: string[]): Promise<string> {
    const conn = this._requireConn();
    return new Promise<string>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        const doRead = (resolvedPath: string) => {
          // Stat first so an oversized file is rejected BEFORE it is buffered.
          sftp.stat(resolvedPath, (statErr: Error | undefined, stats: { size: number }) => {
            if (statErr) {
              reject(statErr);
              return;
            }
            const size = typeof stats?.size === "number" ? stats.size : 0;
            if (size > MAX_READ_FILE_BYTES) {
              reject(
                new Error(
                  `readFile: "${resolvedPath}" is ${size} bytes, over the ${MAX_READ_FILE_BYTES}-byte limit`,
                ),
              );
              return;
            }
            sftp.readFile(resolvedPath, (readErr: Error | undefined, data: Buffer) => {
              if (readErr) {
                reject(readErr);
                return;
              }
              // Reject binary content (NUL byte) instead of returning lossy UTF-8.
              if (data.includes(0)) {
                reject(
                  new Error(
                    `readFile: "${resolvedPath}" appears to be binary (contains a NUL byte); only text files are supported`,
                  ),
                );
                return;
              }
              resolve(data.toString("utf8"));
            });
          });
        };

        if (allowedPrefixes && allowedPrefixes.length > 0) {
          // R6: resolve symlinks via realpath, then re-validate against the allowlist
          sftp.realpath(path, (rpErr: Error | undefined, resolvedPath: string) => {
            if (rpErr) {
              reject(rpErr);
              return;
            }
            const allowed = allowedPrefixes.some((prefix) =>
              prefix.endsWith("/")
                ? resolvedPath.startsWith(prefix)
                : resolvedPath === prefix,
            );
            if (!allowed) {
              reject(
                new Error(
                  `readFile: resolved path "${resolvedPath}" is outside allowed prefixes ` +
                    `(symlink escape detected). Allowed: ${allowedPrefixes.join(", ")}`,
                ),
              );
              return;
            }
            doRead(resolvedPath);
          });
        } else {
          doRead(path);
        }
      });
    });
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.conn) {
        this.conn.end();
        this.conn = null;
      }
      resolve();
    });
  }

  private _requireConn(): InstanceType<typeof Client> {
    if (!this.conn) {
      throw new Error("SshClient: not connected. Call connect() first.");
    }
    return this.conn;
  }
}
