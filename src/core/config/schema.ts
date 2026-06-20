import { CoolifyError } from "../errors.js";
import { assertCoolifyTokenFormat } from "../validate.js";

export interface ApiConfig { baseUrl: string; token: string; extraHeaders: Record<string, string>; }
export interface SshConfig { keyPath: string; host?: string; knownHostsPath?: string; fingerprint?: string; hostServer?: string; user?: string; port?: number; passphrase?: string; }
export interface DbConfig { readonlyUser: string; readonlyPassword?: string; }
export interface InstanceConfig {
  name: string; baseUrl: string; token: string; extraHeaders: Record<string, string>;
  enableHostOps: boolean; allowDestructive: boolean; ssh?: SshConfig; db?: DbConfig; pinnedCoolifyVersion?: string;
}
export interface AppConfig { instances: Record<string, InstanceConfig>; defaultInstance: string; }

function asObj(v: unknown, ctx: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new CoolifyError("invalid_input", `config: ${ctx} must be an object`);
  }
  return v as Record<string, unknown>;
}
function reqStr(o: Record<string, unknown>, key: string, ctx: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") throw new CoolifyError("invalid_input", `config: ${ctx}.${key} is required`);
  return v;
}

function validateInstance(name: string, raw: unknown): InstanceConfig {
  const o = asObj(raw, `instances.${name}`);
  const baseUrl = reqStr(o, "baseUrl", `instances.${name}`).replace(/\/+$/, "");
  const token = reqStr(o, "token", `instances.${name}`);
  assertCoolifyTokenFormat(token, `instances.${name}.token`);
  const extraHeaders = (o.extraHeaders ?? {}) as Record<string, string>;
  const inst: InstanceConfig = {
    name, baseUrl, token, extraHeaders,
    enableHostOps: o.enableHostOps === true,
    allowDestructive: o.allowDestructive === true,
    pinnedCoolifyVersion: typeof o.pinnedCoolifyVersion === "string" ? o.pinnedCoolifyVersion : undefined,
  };
  if (o.ssh !== undefined) {
    const s = asObj(o.ssh, `instances.${name}.ssh`);
    inst.ssh = {
      keyPath: reqStr(s, "keyPath", `instances.${name}.ssh`),
      host: typeof s.host === "string" ? s.host : undefined,
      knownHostsPath: typeof s.knownHostsPath === "string" ? s.knownHostsPath : undefined,
      fingerprint: typeof s.fingerprint === "string" ? s.fingerprint : undefined,
      hostServer: typeof s.hostServer === "string" ? s.hostServer : undefined,
      user: typeof s.user === "string" ? s.user : undefined,
      port: typeof s.port === "number" ? s.port : undefined,
      passphrase: typeof s.passphrase === "string" ? s.passphrase : undefined,
    };
  }
  if (o.db !== undefined) {
    const d = asObj(o.db, `instances.${name}.db`);
    inst.db = {
      readonlyUser: reqStr(d, "readonlyUser", `instances.${name}.db`),
      readonlyPassword: typeof d.readonlyPassword === "string" ? d.readonlyPassword : undefined,
    };
  }
  return inst;
}

export function validateAppConfig(raw: unknown): AppConfig {
  const o = asObj(raw, "root");
  const instancesRaw = o.instances;
  if (instancesRaw === undefined || typeof instancesRaw !== "object" || instancesRaw === null) {
    throw new CoolifyError("invalid_input", "config: 'instances' object is required");
  }
  const names = Object.keys(instancesRaw as Record<string, unknown>);
  if (names.length === 0) throw new CoolifyError("invalid_input", "config: 'instances' must have at least one entry");
  const instances: Record<string, InstanceConfig> = {};
  for (const n of names) instances[n] = validateInstance(n, (instancesRaw as Record<string, unknown>)[n]);

  let defaultInstance = typeof o.defaultInstance === "string" ? o.defaultInstance : undefined;
  if (defaultInstance && !instances[defaultInstance]) {
    throw new CoolifyError("invalid_input", `config: defaultInstance '${defaultInstance}' is not a defined instance`);
  }
  if (!defaultInstance) {
    if (names.length === 1) defaultInstance = names[0];
    else if (instances["default"]) defaultInstance = "default";
    else throw new CoolifyError("invalid_input", "config: defaultInstance must be set when multiple instances are defined");
  }
  return { instances, defaultInstance };
}
