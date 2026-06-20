/**
 * One-time staging live-probe.
 *
 * Hits the 9 open unknowns from the design spec, printing findings as a structured report.
 * Requires COOLIFY_TEST_BASE_URL and COOLIFY_TEST_TOKEN env vars.
 *
 * Usage:
 *   COOLIFY_TEST_BASE_URL=https://coolify.example.com \
 *   COOLIFY_TEST_TOKEN=1|yoursecret \
 *   npx tsx src/scripts/probe.ts
 *
 * Add --host-ops to also probe SSH-dependent endpoints (requires SSH env vars too).
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { CoolifyApiClient } from "../core/api/client.js";

export type ProbeStatus = "ok" | "error" | "skipped";

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  value?: unknown;
  error?: string;
  note?: string;
}

/**
 * Wraps a probe function and captures its result defensively.
 * Never throws.
 */
export async function parseProbeResult(
  name: string,
  fn: () => Promise<unknown>,
): Promise<ProbeResult> {
  try {
    const value = await fn();
    return { name, status: "ok", value };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { name, status: "error", error };
  }
}

/**
 * Formats an array of ProbeResults into a human-readable report string.
 */
export function formatProbeReport(results: ProbeResult[]): string {
  const lines: string[] = [];
  const total = results.length;
  const passed = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "error").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  lines.push("╔══════════════════════════════════════════════════╗");
  lines.push("║           coolify-mcp staging probe              ║");
  lines.push("╚══════════════════════════════════════════════════╝");
  lines.push("");

  for (const r of results) {
    const icon = r.status === "ok" ? "PASS" : r.status === "skipped" ? "SKIP" : "FAIL";
    lines.push(`[${icon}] ${r.name}`);
    if (r.status === "ok" && r.value !== undefined && r.value !== null) {
      const preview = JSON.stringify(r.value);
      const truncated = preview.length > 120 ? preview.slice(0, 117) + "..." : preview;
      lines.push(`       value: ${truncated}`);
    }
    if (r.status === "error" && r.error) {
      lines.push(`       error: ${r.error}`);
    }
    if (r.note) {
      lines.push(`       note:  ${r.note}`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${total} probes — ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const baseUrl = process.env["COOLIFY_TEST_BASE_URL"];
  const token = process.env["COOLIFY_TEST_TOKEN"];
  const enableHostOps = process.argv.includes("--host-ops");

  if (!baseUrl || !token) {
    console.error(
      "ERROR: COOLIFY_TEST_BASE_URL and COOLIFY_TEST_TOKEN must be set.\n" +
        "Example:\n" +
        "  COOLIFY_TEST_BASE_URL=https://coolify.example.com \\\n" +
        "  COOLIFY_TEST_TOKEN=1|yoursecret \\\n" +
        "  npx tsx src/scripts/probe.ts",
    );
    process.exit(1);
  }

  const api = new CoolifyApiClient({
    baseUrl,
    token,
    extraHeaders: {},
  });

  console.log(`Probing ${baseUrl} ...\n`);

  // ── The 9 open unknowns from the design spec ─────────────────────────────
  //
  // 1. Does GET /api/health return a meaningful body or just 200?
  // 2. Does GET /api/v1/version return a bare string or a JSON object?
  // 3. Does GET /api/v1/resources return an array or something else?
  // 4. What shape does a resource object in /resources have?
  // 5. Do /applications, /databases, /services all return empty arrays when none exist,
  //    or do they return 404 / error bodies?
  // 6. Does POST /deploy with a tag return one trigger result or many?
  // 7. What terminal statuses does GET /deployments/{uuid} cycle through?
  // 8. Does GET /servers/{uuid}/resources return server-level resources (apps+dbs+svcs)?
  // 9. Does DELETE /applications/{uuid} return { message } or { uuid } or something else?
  // ─────────────────────────────────────────────────────────────────────────

  const probes: ProbeResult[] = await Promise.all([
    // Unknown 1: GET /api/health body shape
    parseProbeResult("health_body_shape", () => api.health()),

    // Unknown 2: GET /api/v1/version — string or object?
    parseProbeResult("version_type", async () => {
      const v = await api.version();
      return { type: typeof v, value: v };
    }),

    // Unknown 3: GET /api/v1/resources — array or other?
    parseProbeResult("resources_type", async () => {
      const r = await api.resources();
      return { is_array: Array.isArray(r), length: Array.isArray(r) ? r.length : null };
    }),

    // Unknown 4: Shape of first resource object
    parseProbeResult("resources_first_object_keys", async () => {
      const r = await api.resources();
      if (!Array.isArray(r) || r.length === 0) return null;
      return Object.keys(r[0] as Record<string, unknown>);
    }),

    // Unknown 5a: Empty-array vs 404 on /applications when empty
    parseProbeResult("applications_empty_response", async () => {
      const apps = await api.applications.list();
      return { is_array: Array.isArray(apps), length: Array.isArray(apps) ? apps.length : null };
    }),

    // Unknown 5b: /databases
    parseProbeResult("databases_empty_response", async () => {
      const dbs = await api.databases.list();
      return { is_array: Array.isArray(dbs), length: Array.isArray(dbs) ? dbs.length : null };
    }),

    // Unknown 5c: /services
    parseProbeResult("services_empty_response", async () => {
      const svcs = await api.services.list();
      return { is_array: Array.isArray(svcs), length: Array.isArray(svcs) ? svcs.length : null };
    }),

    // Unknown 6: /deployments (active) — array shape?
    parseProbeResult("active_deployments_shape", async () => {
      const deps = await api.deployments.listActive();
      return {
        is_array: Array.isArray(deps),
        length: Array.isArray(deps) ? deps.length : null,
        first_keys:
          Array.isArray(deps) && deps.length > 0 ? Object.keys(deps[0]!) : [],
      };
    }),

    // Unknown 7: Terminal deployment statuses — check first deployment in history if apps exist
    parseProbeResult("deployment_status_values", async () => {
      const apps = await api.applications.list();
      if (!Array.isArray(apps) || apps.length === 0) return { note: "no applications to inspect" };
      const appUuid = apps[0]!["uuid"] as string;
      const { deployments } = await api.deployments.history(appUuid, { take: 5 });
      return deployments.map((d) => d.status);
    }),
  ]);

  // Unknown 8: /servers/{uuid}/resources — if any server exists
  const serversResult = await parseProbeResult("servers_list", () => api.servers.list());
  probes.push(serversResult);

  if (
    serversResult.status === "ok" &&
    Array.isArray(serversResult.value) &&
    serversResult.value.length > 0
  ) {
    const serverUuid = (serversResult.value[0] as Record<string, unknown>)["uuid"] as string;
    probes.push(
      await parseProbeResult("server_resources_shape", async () => {
        const resources = await api.servers.resources(serverUuid);
        return {
          is_array: Array.isArray(resources),
          length: Array.isArray(resources) ? resources.length : null,
          first_keys:
            Array.isArray(resources) && resources.length > 0 ? Object.keys(resources[0]!) : [],
        };
      }),
    );
  } else {
    probes.push({ name: "server_resources_shape", status: "skipped", note: "no servers available" });
  }

  // Unknown 9: DELETE /applications/{uuid} response shape — only if there's a non-critical app
  // We intentionally do NOT auto-delete real apps; we note the shape from history if available.
  probes.push({
    name: "delete_application_response_shape",
    status: "skipped",
    note: "Skipped by default to avoid deleting real resources. Run manually with a throwaway app.",
  });

  // ── Optional host-ops probes (--host-ops flag) ───────────────────────────
  if (enableHostOps) {
    const sshHost = process.env["COOLIFY_SSH_HOST"];
    const sshUser = process.env["COOLIFY_SSH_USER"] ?? "root";
    const sshPort = parseInt(process.env["COOLIFY_SSH_PORT"] ?? "22", 10);
    const sshKeyPath = process.env["COOLIFY_SSH_KEY_PATH"] ?? "";

    const sshFingerprint = process.env["COOLIFY_SSH_KNOWN_HOST_FINGERPRINT"] ?? "";
    const sshKnownHostsPath = process.env["COOLIFY_SSH_KNOWN_HOSTS_PATH"];
    const sshPassphrase = process.env["COOLIFY_SSH_KEY_PASSPHRASE"];

    if (!sshHost || !sshKeyPath) {
      probes.push({
        name: "ssh_connectivity",
        status: "skipped",
        note: "COOLIFY_SSH_HOST and COOLIFY_SSH_KEY_PATH must be set for --host-ops probes",
      });
    } else {
      const { SshClient } = await import("../core/ssh/client.js");
      const ssh = new SshClient({
        host: sshHost,
        user: sshUser,
        port: sshPort,
        keyPath: sshKeyPath,
        hostFingerprint: sshFingerprint,
        knownHostsPath: sshKnownHostsPath,
        passphrase: sshPassphrase,
      });

      probes.push(
        await parseProbeResult("ssh_connectivity", async () => {
          await ssh.connect();
          const result = await ssh.exec("echo coolify-mcp-probe-ok");
          await ssh.close();
          return { connected: true, stdout: result.stdout.trim() };
        }),
      );

      const { ServerResolver } = await import("../core/ssh/resolver.js");
      const { HostOps } = await import("../core/ssh/host-ops.js");
      const ssh2 = new SshClient({
        host: sshHost,
        user: sshUser,
        port: sshPort,
        keyPath: sshKeyPath,
        hostFingerprint: sshFingerprint,
        knownHostsPath: sshKnownHostsPath,
        passphrase: sshPassphrase,
      });
      await ssh2.connect();
      const resolver = new ServerResolver(api, { baseUrl });
      const hostOps = new HostOps(ssh2, resolver);

      probes.push(
        await parseProbeResult("docker_ps_on_host", async () => {
          const servers = await api.servers.list();
          if (!Array.isArray(servers) || servers.length === 0) return { note: "no servers" };
          const serverUuid = (servers[0] as Record<string, unknown>)["uuid"] as string;
          const target = await resolver.resolveByServer(serverUuid);
          const result = await hostOps.dockerExec(target, "ps --format '{{.Names}}'");
          return { code: result.code, containers: result.stdout.trim().split("\n").filter(Boolean) };
        }),
      );

      probes.push(
        await parseProbeResult("psql_select_1", async () => {
          const rows = await hostOps.psqlReadOnly("SELECT 1 AS probe_result");
          return { rows: rows.trim() };
        }),
      );

      await ssh2.close();
    }
  }

  const report = formatProbeReport(probes);
  console.log(report);

  const anyFailed = probes.some((p) => p.status === "error");
  process.exit(anyFailed ? 1 : 0);
}

// Only run main when executed directly (not when imported by tests).
// In ESM, check whether this file is the entry point.
const isMain = process.argv[1]
  ? import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")) ||
    import.meta.url.includes(process.argv[1].split(/[\\/]/).pop()!)
  : false;

if (isMain) {
  main().catch((e) => {
    console.error("probe fatal:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
