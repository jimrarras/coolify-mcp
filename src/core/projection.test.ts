import { describe, it, expect } from "vitest";
import {
  project,
  projectList,
  APP_SUMMARY_FIELDS,
  DB_SUMMARY_FIELDS,
  SERVICE_SUMMARY_FIELDS,
  SERVER_SUMMARY_FIELDS,
} from "./projection.js";

describe("project", () => {
  it("keeps only the specified keys", () => {
    const obj = { uuid: "abc123", name: "myapp", status: "running", secret: "x" };
    const result = project(obj, ["uuid", "name", "status"]);
    expect(result).toEqual({ uuid: "abc123", name: "myapp", status: "running" });
    expect("secret" in result).toBe(false);
  });

  it("returns an empty object if no keys match", () => {
    const obj = { a: 1, b: 2 };
    expect(project(obj, ["c", "d"])).toEqual({});
  });

  it("handles keys that are present in keep but absent in obj", () => {
    const obj = { uuid: "x" };
    const result = project(obj, ["uuid", "name"]);
    expect(result).toEqual({ uuid: "x" });
    expect("name" in result).toBe(false);
  });

  it("returns an empty object for an empty obj", () => {
    expect(project({}, ["uuid"])).toEqual({});
  });

  it("returns an empty object when keep is empty", () => {
    expect(project({ a: 1 }, [])).toEqual({});
  });

  it("does not mutate the original object", () => {
    const obj = { uuid: "q", name: "foo", extra: "bar" };
    project(obj, ["uuid"]);
    expect(obj).toEqual({ uuid: "q", name: "foo", extra: "bar" });
  });
});

describe("projectList", () => {
  it("applies project to each item in the array", () => {
    const arr = [
      { uuid: "a", name: "alpha", status: "running", extra: "x" },
      { uuid: "b", name: "beta", status: "stopped", extra: "y" },
    ];
    const result = projectList(arr, ["uuid", "name", "status"]);
    expect(result).toEqual([
      { uuid: "a", name: "alpha", status: "running" },
      { uuid: "b", name: "beta", status: "stopped" },
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(projectList([], ["uuid"])).toEqual([]);
  });
});

describe("summary field sets", () => {
  it("APP_SUMMARY_FIELDS contains the expected fields", () => {
    expect(APP_SUMMARY_FIELDS).toContain("uuid");
    expect(APP_SUMMARY_FIELDS).toContain("name");
    expect(APP_SUMMARY_FIELDS).toContain("status");
    expect(APP_SUMMARY_FIELDS).toContain("fqdn");
    expect(APP_SUMMARY_FIELDS).toContain("build_pack");
    expect(APP_SUMMARY_FIELDS).toContain("git_repository");
    expect(APP_SUMMARY_FIELDS).toContain("server_uuid");
    expect(APP_SUMMARY_FIELDS).toHaveLength(7);
  });

  it("DB_SUMMARY_FIELDS contains the expected fields", () => {
    expect(DB_SUMMARY_FIELDS).toContain("uuid");
    expect(DB_SUMMARY_FIELDS).toContain("name");
    expect(DB_SUMMARY_FIELDS).toContain("status");
    expect(DB_SUMMARY_FIELDS).toContain("type");
    expect(DB_SUMMARY_FIELDS).toContain("server_uuid");
    expect(DB_SUMMARY_FIELDS).toHaveLength(5);
  });

  it("SERVICE_SUMMARY_FIELDS contains the expected fields", () => {
    expect(SERVICE_SUMMARY_FIELDS).toContain("uuid");
    expect(SERVICE_SUMMARY_FIELDS).toContain("name");
    expect(SERVICE_SUMMARY_FIELDS).toContain("status");
    expect(SERVICE_SUMMARY_FIELDS).toContain("server_uuid");
    expect(SERVICE_SUMMARY_FIELDS).toHaveLength(4);
  });

  it("SERVER_SUMMARY_FIELDS contains the expected fields", () => {
    expect(SERVER_SUMMARY_FIELDS).toContain("uuid");
    expect(SERVER_SUMMARY_FIELDS).toContain("name");
    expect(SERVER_SUMMARY_FIELDS).toContain("ip");
    expect(SERVER_SUMMARY_FIELDS).toContain("reachable");
    expect(SERVER_SUMMARY_FIELDS).toContain("settings");
    expect(SERVER_SUMMARY_FIELDS).toHaveLength(5);
  });
});
