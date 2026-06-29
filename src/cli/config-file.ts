import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { CoolifyError } from "../core/errors.js";

export interface RawConfig {
  instances?: Record<string, unknown>;
  defaultInstance?: string;
  [k: string]: unknown;
}

/** Reads the raw config file (no ${ENV} expansion). null if absent; throws on bad JSON. */
export function readRawConfig(path: string): RawConfig | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CoolifyError("invalid_input", `config: failed to read/parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CoolifyError("invalid_input", `config: ${path} must contain a JSON object`);
  }
  return parsed as RawConfig;
}

/** Writes pretty JSON at mode 0600, creating parent dirs and backing up any existing file to <path>.bak. */
export function writeRawConfig(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, path + ".bak");
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o600 });
}
