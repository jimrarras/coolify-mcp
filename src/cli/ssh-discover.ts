import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type KeyKind = "openssh" | "ppk" | "public" | "other";
export interface KeyCandidate { path: string; kind: KeyKind }

export function classifyKeyContent(content: string, filename: string): KeyKind {
  const head = content.slice(0, 200);
  if (head.includes("PuTTY-User-Key-File")) return "ppk";
  if (filename.toLowerCase().endsWith(".ppk")) return "ppk";
  if (head.includes("BEGIN OPENSSH PRIVATE KEY") || head.includes("BEGIN RSA PRIVATE KEY") || head.includes("BEGIN EC PRIVATE KEY")) return "openssh";
  // Test the first non-empty, non-comment line so a `# comment` header before the
  // key token doesn't cause a misclassification.
  const firstSignificant = content.split(/\r?\n/).find((l) => l.trim() !== "" && !l.trimStart().startsWith("#")) ?? "";
  if (head.includes("BEGIN SSH2 PUBLIC KEY") || /^(ssh-(ed25519|rsa|dss)|ecdsa-)/.test(firstSignificant.trimStart())) return "public";
  if (filename.endsWith(".pub")) return "public";
  return "other";
}

export function scanSshDir(dir = join(homedir(), ".ssh")): KeyCandidate[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: KeyCandidate[] = [];
  for (const name of names) {
    if (name === "known_hosts" || name === "known_hosts.old" || name === "config" || name === "authorized_keys") continue;
    const path = join(dir, name);
    let content = "";
    try { content = readFileSync(path, "utf8"); } catch { continue; }
    out.push({ path, kind: classifyKeyContent(content, name) });
  }
  return out;
}

export async function discoverWorkingKey(deps: {
  candidates: KeyCandidate[];
  tryKey: (path: string, passphrase?: string) => Promise<void>;
  askPassphrase: (path: string) => Promise<string>;
}): Promise<{ path: string; passphrase?: string } | { ppkOnly: true } | null> {
  const openssh = deps.candidates.filter((c) => c.kind === "openssh");
  for (const c of openssh) {
    try {
      await deps.tryKey(c.path);
      return { path: c.path };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      if (msg.includes("passphrase") || msg.includes("encrypted") || msg.includes("integrity check")) {
        const pass = await deps.askPassphrase(c.path);
        if (pass) {
          try { await deps.tryKey(c.path, pass); return { path: c.path, passphrase: pass }; }
          catch { /* try next candidate */ }
        }
      }
      // else: auth/other failure → try next candidate
    }
  }
  if (openssh.length === 0 && deps.candidates.some((c) => c.kind === "ppk")) return { ppkOnly: true };
  return null;
}
