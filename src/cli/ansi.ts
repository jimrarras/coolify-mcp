// Minimal ANSI color helper — deliberately hand-rolled instead of a dependency
// so the esbuild bundle stays lean.

export interface Palette {
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
}

const ESC = String.fromCharCode(27);
const wrap = (open: number, close: number) => (s: string) => `${ESC}[${open}m${s}${ESC}[${close}m`;
const id = (s: string) => s;

export function makePalette(enabled: boolean): Palette {
  if (!enabled) return { green: id, red: id, yellow: id, bold: id, dim: id };
  return {
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
  };
}

/** Per the NO_COLOR spec, presence of the variable (even empty) disables color. */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if ("NO_COLOR" in env) return false;
  return isTTY;
}

/** The palette for this process's real stdout/env. */
export function defaultPalette(): Palette {
  return makePalette(colorEnabled(process.env as Record<string, string | undefined>, Boolean(process.stdout.isTTY)));
}

/**
 * Colorize the CLI's established line markers: doctor statuses (PASS/FAIL/
 * WARN/SKIP), change markers (✓/✗/⚠), and 'error:' prefixes. Everything else
 * passes through, so this is safe to apply at the output boundary.
 */
export function paintLine(line: string, c: Palette): string {
  const m = line.match(/^(PASS|FAIL|WARN|SKIP|✓|✗|⚠|error:)(?=\s)/u);
  if (!m) return line;
  const token = m[1];
  const rest = line.slice(token.length);
  switch (token) {
    case "PASS": case "✓": return c.green(token) + rest;
    case "FAIL": case "✗": case "error:": return c.red(token) + rest;
    case "WARN": case "⚠": return c.yellow(token) + rest;
    case "SKIP": return c.dim(token) + rest;
    default: return line;
  }
}
