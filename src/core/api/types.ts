// Shared API DTOs consumed by multiple sub-clients and tools.

export type ResourceKind = "applications" | "databases" | "services";

export type DbEngine =
  | "postgresql"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "keydb"
  | "dragonfly"
  | "clickhouse";

export type HetznerResource = "locations" | "server-types" | "images" | "ssh-keys";

export interface Deployment {
  id: number;
  deployment_uuid: string;
  status: string;
  application_id?: string;
  logs?: string;
  [k: string]: unknown;
}

export interface DeployTriggerResult {
  message: string;
  resource_uuid: string;
  deployment_uuid?: string;
}

export interface ControlResult {
  message: string;
  deployment_uuid?: string;
}

export interface EnvVar {
  uuid: string;
  key: string;
  value: string;
  is_preview?: boolean;
  [k: string]: unknown;
}
