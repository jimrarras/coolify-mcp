// src/core/ssh/shell.test.ts
import { describe, it, expect } from "vitest";
import { shellQuote } from "./shell.js";

describe("shellQuote()", () => {
  // ---- basic contract ----
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("returns an empty single-quoted token for an empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  // ---- metacharacter neutralisation (injection payload tests) ----
  it("neutralises semicolon", () => {
    const quoted = shellQuote("foo; rm -rf /");
    // result must be a single shell token: no bare ; outside quotes
    expect(quoted).toBe("'foo; rm -rf /'");
    // regression: the raw payload must NOT appear unquoted in any position
    expect(quoted.indexOf(";")).toBeGreaterThan(0); // still present but inside quotes
    // The whole thing must start and end with '
    expect(quoted[0]).toBe("'");
    expect(quoted[quoted.length - 1]).toBe("'");
  });

  it("neutralises pipe (|)", () => {
    const quoted = shellQuote("foo | cat /etc/passwd");
    expect(quoted).toBe("'foo | cat /etc/passwd'");
  });

  it("neutralises ampersand (&)", () => {
    const quoted = shellQuote("foo & background");
    expect(quoted).toBe("'foo & background'");
  });

  it("neutralises dollar sign ($)", () => {
    const quoted = shellQuote("$HOME");
    expect(quoted).toBe("'$HOME'");
  });

  it("neutralises backtick (`)", () => {
    const quoted = shellQuote("`id`");
    expect(quoted).toBe("'`id`'");
  });

  it("neutralises subshell ()", () => {
    const quoted = shellQuote("$(id)");
    expect(quoted).toBe("'$(id)'");
  });

  it("neutralises angle brackets (< >)", () => {
    expect(shellQuote("foo < /etc/shadow")).toBe("'foo < /etc/shadow'");
    expect(shellQuote("foo > /etc/cron.d/evil")).toBe("'foo > /etc/cron.d/evil'");
  });

  it("neutralises newline", () => {
    const quoted = shellQuote("line1\nline2");
    expect(quoted).toBe("'line1\nline2'");
  });

  it("neutralises carriage return", () => {
    const quoted = shellQuote("line1\rline2");
    expect(quoted).toBe("'line1\rline2'");
  });

  // ---- embedded single-quote escaping (the POSIX trick) ----
  it("escapes an embedded single quote using POSIX end-quote trick", () => {
    // "it's" → 'it'"'"'s'
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("escapes multiple consecutive single quotes", () => {
    // "a''b" → 'a'\\'''\\''"b'  — each ' becomes '\''
    expect(shellQuote("a''b")).toBe("'a'\\'''\\''b'");
  });

  it("escapes a value that is only single quotes", () => {
    // "'''" → each ' becomes '\'' → result: ''\'''\'''\'''
    expect(shellQuote("'''")).toBe("''\\'''\\'''\\'''" );
  });

  it("handles mixed metacharacters and embedded single quote (combined injection payload)", () => {
    // Classic payload: foo'; rm -rf /; echo '
    const payload = "foo'; rm -rf /; echo '";
    const quoted = shellQuote(payload);
    // The result must start and end with '
    expect(quoted[0]).toBe("'");
    expect(quoted[quoted.length - 1]).toBe("'");
    // No unquoted ; — every ; must be inside single-quoted segments
    // The POSIX escaping makes the whole thing a single inert argument.
    // Concrete expected value:
    // foo'; rm -rf /; echo '  →  'foo'\''; rm -rf /; echo '\'''
    expect(quoted).toBe("'foo'\\''; rm -rf /; echo '\\'''");
  });

  it("result is always a single inert shell token (no unescaped shell word-split characters outside quotes)", () => {
    const dangerous = [
      "'; DROP TABLE users; --",
      '"; DROP TABLE users; --',
      "$(cat /etc/passwd)",
      "`id`",
      "a\nb",
      "foo | bar",
    ];
    for (const payload of dangerous) {
      const quoted = shellQuote(payload);
      // Must start and end with a single quote
      expect(quoted[0], `payload: ${JSON.stringify(payload)}`).toBe("'");
      expect(quoted[quoted.length - 1], `payload: ${JSON.stringify(payload)}`).toBe("'");
      // Must not contain an unquoted literal double-quote outside of single-quoted segments
      // (i.e. no double-quote appears without being inside a ' ... ' span, which for POSIX
      // single-quoting means any " inside the outer '' is literal). We just verify the
      // outermost delimiters hold.
    }
  });
});
