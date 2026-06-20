import { describe, it, expect } from "vitest";
import { validateReadOnlySql, redactEnvFileContents, HostOps } from "./host-ops.js";
import { scrubInlineSecrets } from "../redact.js";

// Regression tests for the 5 residual findings from the third (convergence) re-audit.

describe("re-audit-3: query_coolify_db out-of-band / resource functions blocked", () => {
  for (const fn of ["pg_notify", "pg_sleep", "pg_advisory_lock", "pg_try_advisory_lock", "pg_advisory_unlock"]) {
    it(`rejects ${fn}`, () => {
      expect(() => validateReadOnlySql(`SELECT ${fn}('x')`)).toThrow();
    });
  }
  it("rejects pg_notify exfiltration payload (covert channel)", () => {
    expect(() =>
      validateReadOnlySql("SELECT pg_notify('chan', (SELECT secret FROM t LIMIT 1))"),
    ).toThrow(/pg_notify/i);
  });
});

describe("re-audit-3: redactEnvFileContents escaped-quote multiline does not leak", () => {
  it("stays in continuation when the opening line has an escaped internal quote", () => {
    const raw = ['DB_PASSWORD="value with \\" still open', 'more-secret-part"', "DB_HOST=localhost"].join("\n");
    const out = redactEnvFileContents(raw);
    expect(out).not.toContain("more-secret-part");
    expect(out).toContain("DB_HOST=localhost");
  });

  it("does not end continuation early on an escaped quote inside a continuation line", () => {
    const raw = ['SECRET="open', 'still \\" secret', 'real-close"', "PUBLIC=ok"].join("\n");
    const out = redactEnvFileContents(raw);
    expect(out).not.toContain("still");
    expect(out).not.toContain("real-close");
    expect(out).toContain("PUBLIC=ok");
  });
});

describe("re-audit-3: readHostFile redacts env-style secrets regardless of filename", () => {
  it("redacts secrets even when the request-path basename is not '.env' (uppercase/symlink bypass)", async () => {
    const envBody = "APP_KEY=base64:supersecretvalue\nDB_PASSWORD=hunter2\nPORT=3000\n";
    // Fake SshClient whose readFile returns .env contents for a non-.env-looking path.
    const fakeSsh = { readFile: async () => envBody } as unknown as ConstructorParameters<typeof HostOps>[0];
    const hostOps = new HostOps(fakeSsh, {} as unknown as ConstructorParameters<typeof HostOps>[1]);
    const out = await hostOps.readHostFile("/data/coolify/proxy/mylink");
    expect(out).not.toContain("supersecretvalue");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("PORT=3000");
  });
});

describe("re-audit-3: scrubInlineSecrets masks inline credentials in ssh_exec audit/preview", () => {
  it("masks PGPASSWORD, mysql -p, --password, and Bearer tokens", () => {
    expect(scrubInlineSecrets("PGPASSWORD=hunter2 psql -U x")).not.toContain("hunter2");
    expect(scrubInlineSecrets("mysql -phunter2 mydb")).not.toContain("hunter2");
    expect(scrubInlineSecrets("tool --password supersecret")).not.toContain("supersecret");
    expect(scrubInlineSecrets("curl -H 'Authorization: Bearer sk-abc123' https://x")).not.toContain("sk-abc123");
  });

  it("leaves benign flags intact", () => {
    expect(scrubInlineSecrets("ls -la /data")).toBe("ls -la /data");
  });
});
