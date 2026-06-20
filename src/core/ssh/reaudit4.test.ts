import { describe, it, expect } from "vitest";
import { validateReadOnlySql, redactEnvFileContents } from "./host-ops.js";
import { scrubInlineSecrets } from "../redact.js";

// Regression tests for the 8 code-fixable findings from the focused (4th) re-audit.
// The 2 remaining redactSqlOutput limits (column-alias / short-value) are inherent
// to output-scanning and are handled by the read-only-role boundary + docs, not code.

describe("re-audit-4: SQL function blocklist defeats suffix / family bypasses (prefix match)", () => {
  const rejected = [
    "SELECT dblink_connect('c', 'dbname=coolify')",
    "SELECT dblink_exec('c', 'CHECKPOINT')",
    "SELECT pg_read_file_v2('/data/coolify/source/.env', 0, 1000, false)",
    "SELECT pg_file_read('/etc/passwd', 0, 100)",
    "SELECT pg_logdir_ls()",
    "SELECT lo_get(16384)",
    "SELECT lo_put(16384, 0, 'x')",
    "SELECT pg_advisory_unlock_all()",
    "SELECT pg_checkpoint()",
    "SELECT pg_promote()",
    "SELECT pg_wal_replay_pause()",
  ];
  for (const sql of rejected) {
    it(`rejects: ${sql.slice(0, 48)}`, () => {
      expect(() => validateReadOnlySql(sql)).toThrow();
    });
  }
  it("still allows a plain SELECT", () => {
    expect(() => validateReadOnlySql("SELECT name, status FROM applications LIMIT 5")).not.toThrow();
  });
});

describe("re-audit-4: redactEnvFileContents quote+backslash combination does not leak", () => {
  it("treats a quoted value ending in backslash as a QUOTED continuation (not backslash)", () => {
    const raw = ["DB_PASSWORD='secret-start\\", "real_secret_leaks_here'", "DB_HOST=localhost"].join("\n");
    const out = redactEnvFileContents(raw);
    expect(out).not.toContain("real_secret_leaks_here");
    expect(out).toContain("DB_HOST=localhost");
  });
});

describe("re-audit-4: SENSITIVE_KEY_RE covers more secret key shapes (via .env redaction)", () => {
  const cases: Array<[string, string]> = [
    ["PASSPHRASE=mysshpassphrase", "mysshpassphrase"],
    ["ENCRYPTION_KEY=aes256keyvalue", "aes256keyvalue"],
    ["SMTP_PASS=mailpw123", "mailpw123"],
    ["AWS_ACCESS_KEY_ID=AKIAEXAMPLE", "AKIAEXAMPLE"],
  ];
  for (const [line, secret] of cases) {
    it(`redacts ${line.split("=")[0]}`, () => {
      const out = redactEnvFileContents(`${line}\nPORT=8080`);
      expect(out).not.toContain(secret);
      expect(out).toContain("PORT=8080");
    });
  }
});

describe("re-audit-4: scrubInlineSecrets masks env-var-prefixed passwords in audit line", () => {
  for (const v of ["REDIS_PASSWORD", "POSTGRES_PASSWORD", "MARIADB_ROOT_PASSWORD"]) {
    it(`masks ${v}=...`, () => {
      expect(scrubInlineSecrets(`docker run -e ${v}=hunter2 img`)).not.toContain("hunter2");
    });
  }
});
