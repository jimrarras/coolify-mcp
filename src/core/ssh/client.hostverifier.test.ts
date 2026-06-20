// src/core/ssh/client.hostverifier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { makeHostVerifier } from "./client.js";

let home: string;
const key = Buffer.from("fake-host-key-bytes");
const keyB64 = key.toString("base64");
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kh-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "known_hosts"), `1.2.3.4 ssh-ed25519 ${keyB64}\n`);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("makeHostVerifier default known_hosts", () => {
  it("verifies against ~/.ssh/known_hosts when no fingerprint/path configured", () => {
    const v = makeHostVerifier({ host: "1.2.3.4", port: 22, user: "root", keyPath: "/k" }, home);
    expect(v(key)).toBe(true);
  });
  it("fails closed for a non-matching key (default path)", () => {
    const v = makeHostVerifier({ host: "1.2.3.4", port: 22, user: "root", keyPath: "/k" }, home);
    expect(v(Buffer.from("different-key"))).toBe(false);
  });
  it("fails closed when the host is absent from known_hosts", () => {
    const v = makeHostVerifier({ host: "9.9.9.9", port: 22, user: "root", keyPath: "/k" }, home);
    expect(v(key)).toBe(false);
  });
  it("honors an explicit fingerprint over known_hosts", () => {
    const fp = createHash("sha256").update(key).digest("base64");
    const v = makeHostVerifier({ host: "irrelevant", port: 22, user: "root", keyPath: "/k", hostFingerprint: fp }, home);
    expect(v(key)).toBe(true);
  });
});
