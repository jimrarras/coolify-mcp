import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyKeyContent, discoverWorkingKey, scanSshDir } from "./ssh-discover.js";

describe("classifyKeyContent", () => {
  it("detects OpenSSH private keys", () => {
    expect(classifyKeyContent("-----BEGIN OPENSSH PRIVATE KEY-----\n...", "id_ed25519")).toBe("openssh");
  });
  it("detects PuTTY ppk", () => {
    expect(classifyKeyContent("PuTTY-User-Key-File-3: ssh-ed25519", "x.ppk")).toBe("ppk");
  });
  it("detects ssh2 public keys", () => {
    expect(classifyKeyContent("---- BEGIN SSH2 PUBLIC KEY ----", "k")).toBe("public");
    expect(classifyKeyContent("ssh-ed25519 AAAA... user@host", "id.pub")).toBe("public");
  });
  it("classifies a public key preceded by a comment line", () => {
    expect(classifyKeyContent("# my key\nssh-ed25519 AAAA... user@host\n", "somekey")).toBe("public");
  });
  it("returns 'other' for unrecognized content", () => {
    expect(classifyKeyContent("just some notes", "notes.txt")).toBe("other");
  });
});

describe("scanSshDir", () => {
  it("classifies key files and skips known_hosts/config", () => {
    const dir = mkdtempSync(join(tmpdir(), "ssh-scan-"));
    try {
      writeFileSync(join(dir, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n...");
      writeFileSync(join(dir, "id_ed25519.pub"), "ssh-ed25519 AAAA... u@h");
      writeFileSync(join(dir, "work.ppk"), "PuTTY-User-Key-File-3: ssh-ed25519");
      writeFileSync(join(dir, "known_hosts"), "example.com ssh-ed25519 AAAA...");
      writeFileSync(join(dir, "config"), "Host *");
      const byName = Object.fromEntries(scanSshDir(dir).map((c) => [c.path.split(/[\\/]/).pop(), c.kind]));
      expect(byName["id_ed25519"]).toBe("openssh");
      expect(byName["id_ed25519.pub"]).toBe("public");
      expect(byName["work.ppk"]).toBe("ppk");
      expect(byName["known_hosts"]).toBeUndefined(); // skipped
      expect(byName["config"]).toBeUndefined(); // skipped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("returns [] for a non-existent directory", () => {
    expect(scanSshDir(join(tmpdir(), "no-such-ssh-dir-xyz123"))).toEqual([]);
  });
});

describe("discoverWorkingKey", () => {
  it("returns the first OpenSSH key that connects", async () => {
    const tryKey = vi.fn(async (p: string) => { if (p !== "/good") throw new Error("auth"); });
    const r = await discoverWorkingKey({
      candidates: [{ path: "/bad", kind: "openssh" }, { path: "/good", kind: "openssh" }],
      tryKey, askPassphrase: async () => "",
    });
    expect(r).toEqual({ path: "/good" });
  });
  it("retries an encrypted key with a passphrase", async () => {
    const tryKey = vi.fn(async (_p: string, pass?: string) => { if (!pass) throw new Error("no passphrase"); });
    const r = await discoverWorkingKey({
      candidates: [{ path: "/enc", kind: "openssh" }],
      tryKey, askPassphrase: async () => "pw",
    });
    expect(r).toEqual({ path: "/enc", passphrase: "pw" });
  });
  it("signals ppkOnly when only a .ppk is present", async () => {
    const r = await discoverWorkingKey({ candidates: [{ path: "/x.ppk", kind: "ppk" }], tryKey: vi.fn(), askPassphrase: async () => "" });
    expect(r).toEqual({ ppkOnly: true });
  });
  it("returns null when nothing works", async () => {
    const r = await discoverWorkingKey({ candidates: [{ path: "/a", kind: "openssh" }], tryKey: async () => { throw new Error("auth"); }, askPassphrase: async () => "" });
    expect(r).toBeNull();
  });
});
