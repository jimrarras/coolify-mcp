// src/__tests__/readme.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

function readRepoFile(name: string): string {
  return readFileSync(resolve(repoRoot, name), "utf8");
}

describe("README.md required sections", () => {
  let readme: string;
  try {
    readme = readRepoFile("README.md");
  } catch {
    readme = "";
  }

  it("contains a Quick Start section", () => {
    expect(readme).toMatch(/##?\s+Quick\s+Start/i);
  });

  it("contains a Configuration section", () => {
    expect(readme).toMatch(/##?\s+Configuration/i);
  });

  it("documents COOLIFY_BASE_URL", () => {
    expect(readme).toContain("COOLIFY_BASE_URL");
  });

  it("documents COOLIFY_TOKEN", () => {
    expect(readme).toContain("COOLIFY_TOKEN");
  });

  it("documents --enable-host-ops flag", () => {
    expect(readme).toContain("--enable-host-ops");
  });

  it("documents --allow-destructive flag", () => {
    expect(readme).toContain("--allow-destructive");
  });

  it("contains a tool table or tool list section", () => {
    expect(readme).toMatch(/##?\s+Tools/i);
  });

  it("mentions all four access tiers: R, W, D, host", () => {
    // The table should mention read (R), write (W), destructive (D), and host tiers
    expect(readme).toMatch(/\bR\b.*read|\bread\b/i);
    expect(readme).toMatch(/\bW\b.*write|\bwrite\b/i);
    expect(readme).toMatch(/destructive|--allow-destructive/i);
    expect(readme).toMatch(/host.*ops|--enable-host-ops/i);
  });

  it("covers token scope guidance", () => {
    expect(readme).toMatch(/token\s+scope|scope.*token|read[- ]only.*token|token.*permissions?/i);
  });

  it("documents the lockout-endpoint policy (never-exposed endpoints)", () => {
    expect(readme).toMatch(/GET \/enable|GET \/disable|mcp\/enable|mcp\/disable|never\s+exposed|lockout/i);
  });

  it("documents the confirm:true requirement for destructive operations", () => {
    expect(readme).toContain("confirm");
  });

  it("is longer than 500 characters (not a stub)", () => {
    expect(readme.length).toBeGreaterThan(500);
  });

  it("documents config.json file", () => {
    expect(readme).toContain("config.json");
  });

  it("documents the instance tool argument", () => {
    expect(readme).toContain("instance");
  });

  it("documents ssh.keyPath", () => {
    expect(readme).toContain("ssh.keyPath");
  });
});

describe(".env.example required keys", () => {
  let envExample: string;
  try {
    envExample = readRepoFile(".env.example");
  } catch {
    envExample = "";
  }

  it("contains COOLIFY_BASE_URL", () => {
    expect(envExample).toContain("COOLIFY_BASE_URL");
  });

  it("contains COOLIFY_TOKEN", () => {
    expect(envExample).toContain("COOLIFY_TOKEN");
  });

  it("contains SSH_HOST or COOLIFY_SSH_HOST", () => {
    expect(envExample).toMatch(/SSH_HOST|COOLIFY_SSH_HOST/);
  });

  it("contains SSH_USER or COOLIFY_SSH_USER", () => {
    expect(envExample).toMatch(/SSH_USER|COOLIFY_SSH_USER/);
  });

  it("contains SSH_PORT or COOLIFY_SSH_PORT", () => {
    expect(envExample).toMatch(/SSH_PORT|COOLIFY_SSH_PORT/);
  });

  it("contains SSH_KEY_PATH or COOLIFY_SSH_KEY_PATH", () => {
    expect(envExample).toMatch(/SSH_KEY_PATH|COOLIFY_SSH_KEY_PATH/);
  });
});
