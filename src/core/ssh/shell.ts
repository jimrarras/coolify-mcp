// src/core/ssh/shell.ts

/**
 * Wraps `value` in POSIX single quotes so it becomes a single inert shell token.
 *
 * Shell metacharacters (; | & $ ` ( ) < > newline, space, etc.) are all
 * neutralised because nothing inside single quotes is interpreted by the shell.
 *
 * Embedded single quotes are escaped using the standard POSIX technique:
 *   end the current quoted segment  →  '
 *   emit an escaped literal '       →  \'
 *   reopen the quoted segment       →  '
 *
 * Example:  it's  →  'it'\''s'
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
