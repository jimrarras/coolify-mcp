// src/core/ssh/host-ops.ts
import { CoolifyError } from "../errors.js";
import { SENSITIVE_KEY_RE } from "../redact.js";
import type { SshClient, SshExecResult } from "./client.js";
import type { ServerResolver, ServerTarget } from "./resolver.js";
import { shellQuote } from "./shell.js";

export const ALLOWED_HOST_FILE_PREFIXES: string[] = [
  "/data/coolify/source/.env",
  "/data/coolify/proxy/",
  "/data/coolify/",
];

// Resource bounds for query_coolify_db so a valid-but-expensive read-only query
// cannot hang or OOM the MCP host process. Layered ON TOP of the read-only role,
// validator, and BEGIN READ ONLY txn — not a replacement for any of them.
const PSQL_STATEMENT_TIMEOUT = "30s"; // server-side per-statement cap
const PSQL_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // cap psql stdout buffered in-process
const PSQL_EXEC_TIMEOUT_MS = 60_000; // overall SSH exec wall-clock bound

// ── R5: hardened SQL read-only validator ─────────────────────────────────────

/**
 * Validates that `sql` is genuinely read-only before passing it to psql.
 *
 * Rules (all word-boundary / case-insensitive unless noted):
 * 1. Trimmed SQL must START with SELECT or WITH.
 * 2. Reject any comment token  (-- or /*)
 * 3. Reject multi-statement input: no ';' except an optional single trailing one.
 * 4. UNANCHORED blocklist of mutating keywords / dangerous functions anywhere
 *    in the query.
 *
 * Throws CoolifyError("invalid_input", …) on any violation.
 */
export function validateReadOnlySql(sql: string): void {
  const trimmed = sql.trim();

  // Rule 1 – must start with SELECT or WITH
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new CoolifyError(
      "invalid_input",
      `psqlReadOnly only allows SELECT or WITH queries. Got: ${trimmed.slice(0, 80)}`,
    );
  }

  // Rule 2 – reject comment tokens (-- or /*)
  if (/--|\/\*/.test(sql)) {
    throw new CoolifyError(
      "invalid_input",
      "psqlReadOnly rejects SQL containing comment tokens (-- or /*)",
    );
  }

  // Rule 3 – reject multi-statement: strip one optional trailing ';', then
  // any remaining ';' means a stacked statement.
  const withoutTrailingSemi = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemi.includes(";")) {
    throw new CoolifyError(
      "invalid_input",
      "psqlReadOnly rejects multi-statement SQL (';' found outside trailing position)",
    );
  }

  // Rule 4a – unanchored mutating keyword blocklist (word-boundary)
  const MUTATING_KEYWORDS_RE =
    /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|MERGE|LOCK|COPY|VACUUM|CALL|DO)\b/i;
  const match4a = MUTATING_KEYWORDS_RE.exec(sql);
  if (match4a) {
    throw new CoolifyError(
      "invalid_input",
      `psqlReadOnly detected mutating keyword '${match4a[1]}' in query`,
    );
  }

  // Rule 4b – dangerous pg functions (no word-boundary needed; function-name match)
  const DANGEROUS_FUNCTIONS_RE =
    // PREFIX matching (boundary before the name, NONE after): a trailing \b is
    // defeated by suffixes because '_' is a \w char, so \bdblink\b misses
    // dblink_exec and \bpg_read_file\b misses pg_read_file_v2. Matching by family
    // prefix (e.g. dblink, pg_file_, pg_advisory, lo_) rejects every variant.
    /\b(pg_read_file\w*|pg_read_binary_file|pg_stat_file|pg_ls_dir|pg_logdir_ls|pg_file_\w*|pg_execute_server_program|pg_write_server_file|pg_reload_conf|pg_terminate_backend|pg_cancel_backend|pg_signal_backend|pg_rotate_logfile|pg_switch_wal|pg_wal_\w*|pg_log_backend_memory_contexts|pg_promote|pg_create_restore_point|pg_checkpoint|pg_advisory\w*|pg_try_advisory\w*|pg_notify|pg_sleep|dblink\w*|set_config|lo_\w*|loread|lowrite)/i;
  const match4b = DANGEROUS_FUNCTIONS_RE.exec(sql);
  if (match4b) {
    throw new CoolifyError(
      "invalid_input",
      `psqlReadOnly detected dangerous function '${match4b[1]}' in query`,
    );
  }

  // Rule 4c – SET ROLE / SET SESSION AUTHORIZATION (privilege escalation)
  if (/\bSET\s+(ROLE|SESSION\s+AUTHORIZATION)\b/i.test(sql)) {
    throw new CoolifyError(
      "invalid_input",
      "psqlReadOnly rejects SET ROLE / SET SESSION AUTHORIZATION",
    );
  }
}

/**
 * Redacts credential-looking content from psql stdout before returning it.
 *
 * Four passes:
 *   A) Complete PEM blocks (BEGIN…END) are replaced wholesale.
 *   B) Partial/truncated PEM blocks (BEGIN marker with no matching END) are redacted.
 *   C) Tabular psql output whose column header matches SENSITIVE_KEY_RE has
 *      its value cells replaced with ***REDACTED***.
 *      The header is located as the FIRST line containing '|' (skipping leading
 *      SET/BEGIN/ROLLBACK/blank/notice lines that psql emits for multi-statement sessions).
 *   D) Entropy/value-pattern pass: redacts high-entropy / secret-looking cell values
 *      regardless of column name, defending against column-alias bypasses.
 *      Patterns: bcrypt hashes ($2[aby]$…), long base64/hex (>=32 printable chars).
 *
 * BEST-EFFORT — NOT A SECURITY BOUNDARY. Output-scanning cannot reliably mask
 * arbitrary SELECT results: a short or special-character secret aliased to a
 * benign column name (e.g. `SELECT password AS p`) will pass. The real boundary
 * is the REQUIRED read-only PostgreSQL role (COOLIFY_DB_READONLY_USER), which the
 * operator MUST harden — non-superuser, no adminpack/dblink, and no SELECT on
 * columns/tables they don't want exposed. This pass only reduces incidental leakage.
 */
export function redactSqlOutput(raw: string): string {
  // Pass A – redact complete PEM blocks (BEGIN ... END).
  const pemRedacted = raw.replace(
    /-----BEGIN[^\n]*-----[\s\S]*?-----END[^\n]*-----/g,
    "***REDACTED***",
  );

  // Pass B – redact partial/truncated PEM (BEGIN marker present but no END).
  // After pass A any complete blocks are gone; what's left with a BEGIN but no END
  // is a truncated block — redact from the BEGIN line to end of string.
  const pemPartialRedacted = pemRedacted.replace(
    /-----BEGIN[^\n]*-----[\s\S]*/g,
    "***REDACTED***",
  );

  // Pass C – column-name-based redaction for psql tabular output.
  // psql text output looks like:
  //   col1 | col2 | secret_col
  //  ------+------+-----------
  //   val1 | val2 | supersecret
  // When using multiple -c flags, psql may emit SET, BEGIN, blank lines,
  // or ROLLBACK before the actual table, so the header is NOT always line[0].
  const lines = pemPartialRedacted.split("\n");

  // Find the first line that contains '|' — that is the table header.
  const headerIdx = lines.findIndex((l) => l.includes("|"));
  if (headerIdx === -1) {
    // No table output — skip column-based redaction but still run value pass (pass D below)
    return applyValueEntropyPass(pemPartialRedacted);
  }

  const headerLine = lines[headerIdx];
  const headers = headerLine.split("|").map((h) => h.trim());
  const sensitiveColIndexes = headers
    .map((h, i) => (SENSITIVE_KEY_RE.test(h) ? i : -1))
    .filter((i) => i >= 0);

  let result: string;
  if (sensitiveColIndexes.length === 0) {
    result = pemPartialRedacted;
  } else {
    // Redact value cells in data rows (skip header and separator lines)
    const redactedLines = lines.map((line, lineIdx) => {
      if (lineIdx === headerIdx) return line; // header
      // separator lines contain only dashes/pluses/spaces
      if (/^[-+\s]+$/.test(line)) return line;
      // data row
      if (!line.includes("|")) return line;
      const cells = line.split("|");
      for (const idx of sensitiveColIndexes) {
        if (idx < cells.length) {
          cells[idx] = " ***REDACTED*** ";
        }
      }
      return cells.join("|");
    });
    result = redactedLines.join("\n");
  }

  // Pass D – entropy/value-pattern pass: masks secret-looking values regardless
  // of column name so that aliases (SELECT password AS val) cannot bypass redaction.
  return applyValueEntropyPass(result);
}

/**
 * Scans every data row/cell in psql tabular output and replaces high-entropy /
 * secret-looking values with ***REDACTED***, regardless of column name.
 *
 * Handles both multi-column output (pipes) and single-column output (no pipes).
 *
 * Patterns detected:
 *   1. bcrypt hashes: $2[aby]$<cost>$<53 chars>
 *   2. Long base64/hex tokens: >=32 consecutive [A-Za-z0-9+/=_\-] chars
 */
function applyValueEntropyPass(text: string): string {
  // bcrypt: $2a$, $2b$, $2y$ followed by the hash body
  const BCRYPT_RE = /\$2[aby]\$\d{2}\$[A-Za-z0-9./]{50,}/;

  const isSecretValue = (trimmed: string): boolean => {
    if (BCRYPT_RE.test(trimmed)) return true;
    // Long token: >=32 chars of pure base64/hex alphabet
    if (/^[A-Za-z0-9+/=_-]{32,}$/.test(trimmed)) return true;
    return false;
  };

  const lines = text.split("\n");

  // Find the first non-empty, non-separator line with | to determine if this is
  // multi-column output. If no | found, treat whole data lines as single values.
  const headerIdx = lines.findIndex((l) => l.includes("|"));

  const redactedLines = lines.map((line, lineIdx) => {
    // Skip separator lines (only dashes/pluses/spaces)
    if (/^[-+\s]+$/.test(line)) return line;

    if (headerIdx !== -1) {
      // Multi-column output: skip header line itself
      if (lineIdx === headerIdx) return line;
      if (!line.includes("|")) {
        // Non-table line (e.g. "(N rows)", "ROLLBACK") — just check the whole line
        const trimmed = line.trim();
        return isSecretValue(trimmed) ? "***REDACTED***" : line;
      }
      // Data row with cells
      const cells = line.split("|");
      const newCells = cells.map((cell) => {
        const trimmed = cell.trim();
        return isSecretValue(trimmed) ? " ***REDACTED*** " : cell;
      });
      return newCells.join("|");
    } else {
      // Single-column output (no | in entire output)
      // The first non-empty, non-separator line is the header; subsequent non-separator lines are values.
      // We identify the header as the first non-empty line, then treat the rest as values.
      const firstNonEmpty = lines.findIndex((l) => l.trim() !== "" && !/^[-\s]+$/.test(l));
      if (lineIdx === firstNonEmpty) return line; // header
      const trimmed = line.trim();
      if (trimmed === "") return line;
      // Row count lines like "(N rows)" — skip
      if (/^\(\d+ rows?\)$/.test(trimmed)) return line;
      return isSecretValue(trimmed) ? "***REDACTED***" : line;
    }
  });

  return redactedLines.join("\n");
}

export class HostOps {
  private readonly ssh: SshClient;
  // resolver is stored for future use (e.g. re-resolving by server in rawExec)
  private readonly resolver: ServerResolver;
  // H2R1: read-only DB role for psqlReadOnly (fail-closed when absent)
  private readonly dbReadonlyUser: string | undefined;
  private readonly dbReadonlyPassword: string | undefined;

  constructor(
    ssh: SshClient,
    resolver: ServerResolver,
    dbReadonlyUser?: string,
    dbReadonlyPassword?: string,
  ) {
    this.ssh = ssh;
    this.resolver = resolver;
    this.dbReadonlyUser = dbReadonlyUser;
    this.dbReadonlyPassword = dbReadonlyPassword;
  }

  private _dockerPrefix(target: ServerTarget): string {
    if (target.isCoolifyHost) {
      return "docker";
    }
    return `docker -H ${shellQuote(target.dockerHost!)}`;
  }

  async dockerExec(target: ServerTarget, dockerArgs: string): Promise<SshExecResult> {
    const prefix = this._dockerPrefix(target);
    return this.ssh.exec(`${prefix} ${dockerArgs}`);
  }

  async dockerStream(
    target: ServerTarget,
    dockerArgs: string,
    onLine: (l: string) => void,
    signal: AbortSignal,
  ): Promise<{ code: number | null }> {
    const prefix = this._dockerPrefix(target);
    return this.ssh.streamExec(`${prefix} ${dockerArgs}`, onLine, signal);
  }

  async rawExec(target: ServerTarget, command: string): Promise<SshExecResult> {
    // target is available for future routing (e.g. proxy through remote host);
    // for now all SSH traffic goes through the single SshClient (the coolify host).
    void target;
    return this.ssh.exec(command);
  }

  async psqlReadOnly(sql: string): Promise<string> {
    // R5: apply the comprehensive read-only validator (throws on violation)
    validateReadOnlySql(sql);

    // H2R1: fail-closed — require a dedicated read-only DB role
    if (!this.dbReadonlyUser) {
      throw new CoolifyError(
        "invalid_input",
        "query_coolify_db requires COOLIFY_DB_READONLY_USER to be configured; " +
          "refusing to connect as the default superuser role",
      );
    }

    // H2R1: Build the psql command with THREE -c flags in one session so the
    // read-only transaction cannot be disabled mid-session:
    //   1st -c: BEGIN READ ONLY   — opens a structurally read-only txn
    //   2nd -c: <user SQL>        — runs inside the read-only txn
    //   3rd -c: ROLLBACK          — rolls back any side-effects (belt-and-suspenders)
    //
    const userQuoted = shellQuote(this.dbReadonlyUser);
    const beginQuoted = shellQuote("BEGIN READ ONLY");
    // Bound the user statement's server-side execution time inside the txn.
    const timeoutQuoted = shellQuote(`SET statement_timeout = '${PSQL_STATEMENT_TIMEOUT}'`);
    const userSqlQuoted = shellQuote(sql);
    const rollbackQuoted = shellQuote("ROLLBACK");
    const psqlTail = `coolify-db psql -U ${userQuoted} coolify -v ON_ERROR_STOP=1 -c ${beginQuoted} -c ${timeoutQuoted} -c ${userSqlQuoted} -c ${rollbackQuoted}`;

    let cmd: string;
    let stdin: string | undefined;
    if (this.dbReadonlyPassword) {
      // Read the password from stdin into PGPASSWORD and forward it into the
      // container by NAME (`-e PGPASSWORD`, no value). This keeps the secret off
      // the remote process argv (visible via `ps` / /proc/<pid>/cmdline) — unlike
      // the previous `-e PGPASSWORD=<value>`, which exposed it host-locally.
      cmd = `PGPASSWORD=$(cat); export PGPASSWORD; docker exec -i -e PGPASSWORD ${psqlTail}`;
      stdin = this.dbReadonlyPassword;
    } else {
      cmd = `docker exec -i ${psqlTail}`;
    }

    // Bound buffered output size and overall exec time so an expensive read-only
    // query (e.g. a huge cross join) cannot OOM or hang the MCP host process.
    const execOpts = { maxOutputBytes: PSQL_MAX_OUTPUT_BYTES, timeoutMs: PSQL_EXEC_TIMEOUT_MS };
    const result =
      stdin === undefined
        ? await this.ssh.exec(cmd, undefined, execOpts)
        : await this.ssh.exec(cmd, stdin, execOpts);
    // R5 + H2R1: redact credential-looking values in output before returning
    return redactSqlOutput(result.stdout);
  }

  async readHostFile(path: string): Promise<string> {
    // Normalise the path to catch traversal attempts like /data/coolify/../../../etc
    // We use a simple normalization: collapse /./ and /../ segments
    const normalised = normalizePosixPath(path);

    if (!isAllowedHostFilePath(normalised)) {
      throw new CoolifyError(
        "invalid_input",
        `readHostFile: path "${path}" is outside allowed prefixes. ` +
          `Allowed: ${ALLOWED_HOST_FILE_PREFIXES.join(", ")}`,
      );
    }

    // R6: pass allowlist into readFile so symlink resolution can be validated
    const contents = await this.ssh.readFile(normalised, ALLOWED_HOST_FILE_PREFIXES);

    // H2R4 + re-audit-3: redact env-style secrets in ALL host-file output.
    // Applying redactEnvFileContents unconditionally (rather than gating on the
    // request-path basename) closes two redaction bypasses: an uppercase ".ENV"
    // file, and a symlink whose link name doesn't look like .env but whose
    // realpath target IS an .env file. The redactor only rewrites KEY=VALUE lines
    // whose key matches SENSITIVE_KEY_RE, so it is a no-op on non-secret content.
    return redactEnvFileContents(contents);
  }
}

/**
 * Normalises a POSIX-style absolute path by resolving `.` and `..` segments.
 * Does NOT touch the filesystem. Returns the canonical path.
 *
 * Examples:
 *   normalizePosixPath("/data/coolify/../../../etc") => "/etc"
 *   normalizePosixPath("/data/coolify/./source/.env") => "/data/coolify/source/.env"
 */
function normalizePosixPath(p: string): string {
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      // skip
    } else if (part === "..") {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return "/" + stack.join("/");
}

/**
 * R6: Checks whether `normalisedPath` is permitted by the given allowlist
 * (defaults to ALLOWED_HOST_FILE_PREFIXES) using semantically-correct rules:
 *
 *   - Entries WITHOUT a trailing slash (exact files, e.g. /data/coolify/source/.env)
 *     must match the normalised path EXACTLY.  startsWith is NOT used so that
 *     /data/coolify/source/.env_production or .env.backup cannot slip past.
 *
 *   - Entries WITH a trailing slash (directory prefixes, e.g. /data/coolify/)
 *     use startsWith so all files inside the directory are permitted.
 */
export function isAllowedHostFilePath(
  normalisedPath: string,
  prefixes: string[] = ALLOWED_HOST_FILE_PREFIXES,
): boolean {
  return prefixes.some((prefix) => {
    if (prefix.endsWith("/")) {
      // directory prefix — any file inside is allowed
      return normalisedPath.startsWith(prefix);
    } else {
      // exact file entry — must be an exact match
      return normalisedPath === prefix;
    }
  });
}

/**
 * Returns true if `quote` appears in `s` un-escaped (i.e. preceded by an even
 * number of backslashes). A naive `s.includes(quote)` is fooled by `\"` — a
 * backslash-escaped quote inside a value — which caused multi-line .env secret
 * continuation lines to leak (re-audit-3). Scanning backslash parity is precise;
 * on the ambiguous `\\"` form it errs toward "unescaped", which keeps redaction
 * on for one extra line (the safe direction).
 */
function hasUnescapedQuote(s: string, quote: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== quote) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

/**
 * R6 / H2R4: Parses .env-style file contents line by line and redacts values
 * whose key matches SENSITIVE_KEY_RE.  Non-sensitive keys, blank lines, and
 * comments are left unchanged.
 *
 * Format handled: KEY=VALUE  (value may be quoted or unquoted)
 * Lines that don't match KEY=VALUE are passed through unchanged.
 *
 * Stateful multi-line handling (H2R4):
 *   - Backslash continuation: if a sensitive value line ends with `\`, subsequent
 *     lines are replaced with ***REDACTED*** until a line without a trailing `\`.
 *   - Quoted values: if the value opens with `"` or `'` and the closing quote has
 *     not been seen on the same line, subsequent continuation lines are replaced
 *     with ***REDACTED*** until the matching closing quote is found.
 */
export function redactEnvFileContents(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];

  // Tracks whether we are inside a multi-line sensitive value.
  let inSensitiveContinuation = false;
  // '"' | "'" when inside a quoted multi-line value; null otherwise.
  let openQuote: string | null = null;

  for (const line of lines) {
    if (inSensitiveContinuation) {
      // We are in a continuation of a sensitive value — mask this line.
      out.push("***REDACTED***");

      // Determine whether the continuation ends here.
      if (openQuote !== null) {
        // Quoted continuation: ends when we see the closing quote character.
        // Only an UNESCAPED quote closes the value (\" is a literal, not a close).
        if (hasUnescapedQuote(line, openQuote)) {
          inSensitiveContinuation = false;
          openQuote = null;
        }
      } else {
        // Backslash continuation: ends when line does NOT end with a backslash.
        if (!line.trimEnd().endsWith("\\")) {
          inSensitiveContinuation = false;
        }
      }
      continue;
    }

    // Skip blank lines and comments
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }

    // Match KEY=VALUE (KEY may have leading export keyword)
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) {
      out.push(line);
      continue;
    }

    const key = line.slice(0, eqIdx).replace(/^\s*export\s+/, "").trim();
    if (!SENSITIVE_KEY_RE.test(key)) {
      out.push(line);
      continue;
    }

    // Sensitive key: redact the value portion.
    out.push(`${line.slice(0, eqIdx + 1)}***REDACTED***`);

    // Check whether this sensitive value continues onto the next line(s).
    const value = line.slice(eqIdx + 1);

    // Determine continuation kind. Check QUOTED-open BEFORE backslash: a value
    // like KEY="secret\ opens an unclosed quote AND ends with a backslash; the
    // quote governs where the value ends, so quote-continuation must win (a
    // backslash inside a quoted value is just a literal char).
    const trimmedValue = value.trimStart();
    const firstChar = trimmedValue[0];
    if (
      (firstChar === '"' || firstChar === "'") &&
      !hasUnescapedQuote(trimmedValue.slice(1), firstChar)
    ) {
      // Opening quote not closed on this line — quoted continuation follows.
      inSensitiveContinuation = true;
      openQuote = firstChar;
      continue;
    }
    if (value.trimEnd().endsWith("\\")) {
      // Unquoted backslash continuation.
      inSensitiveContinuation = true;
      openQuote = null;
      continue;
    }
  }

  return out.join("\n");
}
