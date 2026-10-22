/**
 * Stringifies a loosely-typed value (an API record field, a parsed config value).
 * Only primitives are stringified; objects, functions and nullish values give the
 * fallback, so a nested object never leaks as "[object Object]".
 */
export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return fallback;
}
