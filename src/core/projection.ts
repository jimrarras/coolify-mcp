// src/core/projection.ts

export function project<T extends Record<string, unknown>>(
  obj: T,
  keep: string[],
): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keep) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      (result as Record<string, unknown>)[key] = obj[key];
    }
  }
  return result;
}

export function projectList<T extends Record<string, unknown>>(
  arr: T[],
  keep: string[],
): Partial<T>[] {
  return arr.map((item) => project(item, keep));
}

export const APP_SUMMARY_FIELDS: string[] = [
  "uuid",
  "name",
  "status",
  "fqdn",
  "build_pack",
  "git_repository",
  "server_uuid",
];

export const DB_SUMMARY_FIELDS: string[] = [
  "uuid",
  "name",
  "status",
  "type",
  "server_uuid",
];

export const SERVICE_SUMMARY_FIELDS: string[] = [
  "uuid",
  "name",
  "status",
  "server_uuid",
];

export const SERVER_SUMMARY_FIELDS: string[] = [
  "uuid",
  "name",
  "ip",
  "reachable",
  "settings",
];
