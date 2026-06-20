// src/__tests__/integration.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { InstanceRegistry } from "../core/registry.js";
import { validateAppConfig } from "../core/config/schema.js";

// This file is an opt-in integration test. It requires:
//   COOLIFY_TEST_BASE_URL  — base URL of a staging Coolify instance
//   COOLIFY_TEST_TOKEN     — API token for that instance
//   COOLIFY_TEST_ALLOW_DESTRUCTIVE=1  — required for any destructive tests
//
// All tests in this file are skipped unless the env vars are set.

const BASE_URL = process.env["COOLIFY_TEST_BASE_URL"];
const TOKEN = process.env["COOLIFY_TEST_TOKEN"];
const ALLOW_DESTRUCTIVE = process.env["COOLIFY_TEST_ALLOW_DESTRUCTIVE"] === "1";

const skip = !BASE_URL || !TOKEN;

describe.skipIf(skip)("Integration: Coolify REST API (live staging)", () => {
  let api: import("../core/api/client.js").CoolifyApiClient;

  beforeAll(async () => {
    const { CoolifyApiClient } = await import("../core/api/client.js");
    api = new CoolifyApiClient({
      baseUrl: BASE_URL!,
      token: TOKEN!,
      extraHeaders: {},
    });
  });

  it("GET /api/health returns a truthy response", async () => {
    const result = await api.health();
    expect(result).toBeTruthy();
  });

  it("GET /api/v1/version returns a version string", async () => {
    const version = await api.version();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("GET /api/v1/resources returns an array (possibly empty)", async () => {
    const resources = await api.resources();
    expect(Array.isArray(resources)).toBe(true);
  });

  it("GET /api/v1/applications returns an array", async () => {
    const apps = await api.applications.list();
    expect(Array.isArray(apps)).toBe(true);
  });

  it("GET /api/v1/databases returns an array", async () => {
    const dbs = await api.databases.list();
    expect(Array.isArray(dbs)).toBe(true);
  });

  it("GET /api/v1/services returns an array", async () => {
    const svcs = await api.services.list();
    expect(Array.isArray(svcs)).toBe(true);
  });

  it("GET /api/v1/servers returns an array", async () => {
    const servers = await api.servers.list();
    expect(Array.isArray(servers)).toBe(true);
  });

  it("GET /api/v1/projects returns an array", async () => {
    const projects = await api.projects.list();
    expect(Array.isArray(projects)).toBe(true);
  });

  it("GET /api/v1/security/keys returns an array", async () => {
    const keys = await api.security.listKeys();
    expect(Array.isArray(keys)).toBe(true);
  });

  it("GET /api/v1/teams returns an array", async () => {
    const teams = await api.teams.list();
    expect(Array.isArray(teams)).toBe(true);
  });

  it("GET /api/v1/teams/current returns an object", async () => {
    const team = await api.teams.current();
    expect(typeof team).toBe("object");
    expect(team).not.toBeNull();
  });

  // Destructive tests — only run when COOLIFY_TEST_ALLOW_DESTRUCTIVE=1
  describe.skipIf(!ALLOW_DESTRUCTIVE)("Destructive integration tests", () => {
    it("POST /api/v1/applications/public then DELETE — round-trip create+delete", async () => {
      // This test creates a throwaway application and immediately deletes it.
      // Requires a server_uuid and project_uuid from the staging environment — skip
      // gracefully if none are available.
      const servers = await api.servers.list();
      const projects = await api.projects.list();
      if (servers.length === 0 || projects.length === 0) {
        console.log("Skipping destructive create+delete: no servers or projects available");
        return;
      }
      const serverUuid = servers[0]!["uuid"] as string;
      const projectUuid = projects[0]!["uuid"] as string;

      const created = await api.applications.createPublic({
        name: `coolify-mcp-probe-${Date.now()}`,
        repository: "https://github.com/coollabsio/coolify-examples",
        branch: "main",
        server_uuid: serverUuid,
        project_uuid: projectUuid,
      });
      expect(typeof created.uuid).toBe("string");

      const deleted = await api.applications.delete(created.uuid);
      expect(deleted).toBeDefined();
    });
  });
});

const RUN = !!process.env["COOLIFY_TEST_BASE_URL"] && !!process.env["COOLIFY_TEST_TOKEN"];
(RUN ? describe : describe.skip)("multi-instance routing (integration)", () => {
  it("routes to the selected instance's baseUrl", async () => {
    const cfg = validateAppConfig({
      defaultInstance: "a",
      instances: {
        a: { baseUrl: process.env["COOLIFY_TEST_BASE_URL"], token: process.env["COOLIFY_TEST_TOKEN"] },
        b: { baseUrl: "https://unused.example.com", token: "1|x" },
      },
    });
    const reg = new InstanceRegistry(cfg);
    expect(reg.get("a").config.baseUrl).toBe(process.env["COOLIFY_TEST_BASE_URL"]);
    expect(reg.get().name).toBe("a");
  });
});
