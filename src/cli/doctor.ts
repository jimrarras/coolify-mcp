import { loadConfig } from "../core/config.js";
import { InstanceRegistry } from "../core/registry.js";
import { runAllChecks, type CheckResult } from "./checks.js";
import type { ResolvedInstance } from "../core/registry.js";

const ICON: Record<CheckResult["status"], string> = { ok: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export async function runDoctor(
  argv: string[],
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  deps: { runChecks?: (inst: ResolvedInstance) => Promise<CheckResult[]> } = {},
): Promise<number> {
  let registry: InstanceRegistry;
  try {
    registry = new InstanceRegistry(loadConfig(argv, env));
  } catch (e) {
    out(`config error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const runChecks = deps.runChecks ?? ((inst) => runAllChecks(inst));
  let anyFail = false;
  for (const name of registry.names()) {
    out(`\n── instance: ${name} ──`);
    const results = await runChecks(registry.get(name));
    for (const r of results) {
      out(`${ICON[r.status]}  ${r.name} — ${r.detail}`);
      if (r.status === "fail" || r.status === "warn") {
        if (r.fix) out(`        fix: ${r.fix}`);
        if (r.status === "fail") anyFail = true;
      }
    }
  }
  return anyFail ? 1 : 0;
}
