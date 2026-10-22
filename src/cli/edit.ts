// `instances edit <name>`: interactive re-configuration of one instance.
// Enter keeps the current value everywhere; secrets are shown redacted and
// ${ENV} references are preserved verbatim unless replaced. Changed credentials
// are verified BEFORE the write — a failed verification aborts with the file
// untouched (unlike `set`, which verifies after and keeps the write).
import type { IO } from './io.js';
import type { RawConfig } from './config-file.js';
import { CoolifyError } from '../core/errors.js';
import { parseFieldValue, redactValue } from './fields.js';
import type { VerifyFn } from './verify.js';

type Out = (line: string) => void;

interface Change {
  field: string;
  old: unknown;
  next: unknown;
}

function record(changes: Change[], field: string, old: unknown, next: unknown): void {
  if (old !== next) changes.push({ field, old, next });
}

/** Prompt for an optional string field: Enter keeps current (or stays unset). */
async function optStr(
  io: IO,
  label: string,
  field: string,
  cur: unknown,
): Promise<string | undefined> {
  const curStr = typeof cur === 'string' ? cur : undefined;
  const a = (await io.prompt(curStr ? `${label}` : `${label} (Enter to skip)`, curStr)).trim();
  if (a === '') return curStr;
  return String(parseFieldValue(field, a));
}

export async function editInstance(
  ctx: {
    path: string;
    raw: RawConfig | null;
    verify: VerifyFn;
    noVerify: boolean;
    out: Out;
    io: IO;
    write: (cfg: RawConfig) => void;
  },
  name: string | undefined,
): Promise<number> {
  const cfg = ctx.raw;
  if (!cfg)
    throw new CoolifyError(
      'invalid_input',
      "No config file to edit. Run 'coolify-mcp init' to create one.",
    );
  const instances = (
    cfg.instances && typeof cfg.instances === 'object' ? cfg.instances : {}
  ) as Record<string, unknown>;
  if (!name) throw new CoolifyError('invalid_input', 'Usage: coolify-mcp instances edit <name>');
  if (instances[name] === undefined) {
    throw new CoolifyError(
      'invalid_input',
      `Unknown instance '${name}'; known: ${Object.keys(instances).join(', ') || '(none)'}`,
    );
  }
  const { io, out } = ctx;
  const orig = instances[name] as Record<string, unknown>;
  const inst = structuredClone(orig);
  const changes: Change[] = [];

  out(`Editing instance '${name}' — Enter keeps the current value.\n`);

  // API
  const baseUrl = await io.prompt(
    'Coolify base URL',
    typeof inst.baseUrl === 'string' ? inst.baseUrl : undefined,
  );
  const newBaseUrl = String(parseFieldValue('baseUrl', baseUrl));
  record(changes, 'baseUrl', inst.baseUrl, newBaseUrl);
  inst.baseUrl = newBaseUrl;

  const tokenInput = (
    await io.promptMasked(`API token (current ${redactValue('token', inst.token)}; Enter keeps it)`)
  ).trim();
  if (tokenInput !== '') {
    const newToken = String(parseFieldValue('token', tokenInput));
    record(changes, 'token', inst.token, newToken);
    inst.token = newToken;
  }

  // Flags
  const hostOps = await io.confirm(
    'Enable host-ops (SSH/Docker/live logs)?',
    inst.enableHostOps === true,
  );
  record(changes, 'enableHostOps', inst.enableHostOps === true, hostOps);
  inst.enableHostOps = hostOps;

  const destructive = await io.confirm('Allow destructive tools?', inst.allowDestructive === true);
  record(changes, 'allowDestructive', inst.allowDestructive === true, destructive);
  inst.allowDestructive = destructive;

  // SSH
  const curSsh = (inst.ssh && typeof inst.ssh === 'object' ? inst.ssh : undefined) as
    | Record<string, unknown>
    | undefined;
  if (curSsh) {
    if (await io.confirm('Edit SSH settings?', false)) {
      const ssh = { ...curSsh };
      const keyPath = await io.prompt(
        'SSH key path',
        typeof ssh.keyPath === 'string' ? ssh.keyPath : undefined,
      );
      record(changes, 'ssh.keyPath', ssh.keyPath, keyPath);
      ssh.keyPath = String(parseFieldValue('ssh.keyPath', keyPath));
      const host = await optStr(io, 'SSH host', 'ssh.host', ssh.host);
      record(changes, 'ssh.host', ssh.host, host);
      if (host !== undefined) ssh.host = host;
      const hostServer = await optStr(
        io,
        'Coolify server name/uuid for the control host',
        'ssh.hostServer',
        ssh.hostServer,
      );
      record(changes, 'ssh.hostServer', ssh.hostServer, hostServer);
      if (hostServer !== undefined) ssh.hostServer = hostServer;
      const user = await optStr(io, 'SSH user', 'ssh.user', ssh.user);
      record(changes, 'ssh.user', ssh.user, user);
      if (user !== undefined) ssh.user = user;
      const portRaw = (
        await io.prompt('SSH port', typeof ssh.port === 'number' ? String(ssh.port) : undefined)
      ).trim();
      if (portRaw !== '') {
        const port = parseFieldValue('ssh.port', portRaw) as number;
        record(changes, 'ssh.port', ssh.port, port);
        ssh.port = port;
      }
      const fingerprint = await optStr(
        io,
        'Host key fingerprint (SHA256:…)',
        'ssh.fingerprint',
        ssh.fingerprint,
      );
      record(changes, 'ssh.fingerprint', ssh.fingerprint, fingerprint);
      if (fingerprint !== undefined) ssh.fingerprint = fingerprint;
      const pass = (
        await io.promptMasked(
          `Key passphrase (current ${redactValue('ssh.passphrase', ssh.passphrase)}; Enter keeps it)`,
        )
      ).trim();
      if (pass !== '') {
        record(changes, 'ssh.passphrase', ssh.passphrase, pass);
        ssh.passphrase = pass;
      }
      inst.ssh = ssh;
    }
  } else if (await io.confirm('Add SSH settings (host-ops)?', false)) {
    const keyPath = String(parseFieldValue('ssh.keyPath', await io.prompt('SSH key path')));
    const ssh: Record<string, unknown> = { keyPath };
    record(changes, 'ssh.keyPath', undefined, keyPath);
    const host = await optStr(io, 'SSH host', 'ssh.host', undefined);
    if (host !== undefined) {
      ssh.host = host;
      record(changes, 'ssh.host', undefined, host);
    }
    const pass = (await io.promptMasked('Key passphrase (Enter to skip)')).trim();
    if (pass !== '') {
      ssh.passphrase = pass;
      record(changes, 'ssh.passphrase', undefined, pass);
    }
    inst.ssh = ssh;
  }

  // DB
  const curDb = (inst.db && typeof inst.db === 'object' ? inst.db : undefined) as
    | Record<string, unknown>
    | undefined;
  if (curDb) {
    if (await io.confirm('Edit read-only DB settings?', false)) {
      const db = { ...curDb };
      const user = await io.prompt(
        'Read-only DB role name',
        typeof db.readonlyUser === 'string' ? db.readonlyUser : undefined,
      );
      record(changes, 'db.readonlyUser', db.readonlyUser, user);
      db.readonlyUser = String(parseFieldValue('db.readonlyUser', user));
      const pw = (
        await io.promptMasked(
          `DB role password (current ${redactValue('db.readonlyPassword', db.readonlyPassword)}; Enter keeps it)`,
        )
      ).trim();
      if (pw !== '') {
        record(changes, 'db.readonlyPassword', db.readonlyPassword, pw);
        db.readonlyPassword = pw;
      }
      inst.db = db;
    }
  } else if (await io.confirm('Add read-only DB settings (query_coolify_db)?', false)) {
    const user = String(
      parseFieldValue('db.readonlyUser', await io.prompt('Read-only DB role name', 'coolify_ro')),
    );
    const db: Record<string, unknown> = { readonlyUser: user };
    record(changes, 'db.readonlyUser', undefined, user);
    const pw = (await io.promptMasked('DB role password (Enter to skip)')).trim();
    if (pw !== '') {
      db.readonlyPassword = pw;
      record(changes, 'db.readonlyPassword', undefined, pw);
    }
    inst.db = db;
  }

  if (changes.length === 0) {
    out('No changes.');
    return 0;
  }

  // Verify the CANDIDATE before writing — a broken edit never lands on disk.
  const sshChanged = changes.some((c) => c.field.startsWith('ssh.'));
  if (!ctx.noVerify) {
    const r = await ctx.verify(name, inst, { sshChanged });
    if ('skipped' in r) {
      out(`verification skipped: ${r.skipped}`);
    } else if (!r.ok) {
      out(`✗ verification failed: ${r.detail}`);
      out('  Nothing was written. Fix the values and try again.');
      return 1;
    } else {
      out(`✓ verified '${name}' — ${r.detail}`);
    }
  }

  instances[name] = inst;
  cfg.instances = instances;
  ctx.write(cfg);
  out(`\n✓ updated '${name}':`);
  for (const c of changes) {
    out(`  ${c.field}: ${redactValue(c.field, c.old)} → ${redactValue(c.field, c.next)}`);
  }
  return 0;
}
