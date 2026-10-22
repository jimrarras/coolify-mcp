import { describe, it, expect } from 'vitest';
import {
  parseFieldValue,
  setField,
  unsetField,
  redactValue,
  isEnvRef,
  SECRET_FIELDS,
  SETTABLE_FIELDS,
  UNSETTABLE_FIELDS,
} from './fields.js';

describe('parseFieldValue', () => {
  it('coerces booleans from true/false/on/off/1/0', () => {
    expect(parseFieldValue('enableHostOps', 'true')).toBe(true);
    expect(parseFieldValue('enableHostOps', 'off')).toBe(false);
    expect(parseFieldValue('allowDestructive', '1')).toBe(true);
    expect(parseFieldValue('allowDestructive', '0')).toBe(false);
  });
  it('rejects a non-boolean word for a boolean field', () => {
    expect(() => parseFieldValue('allowDestructive', 'maybe')).toThrow(/true|false/);
  });
  it('validates ssh.port as an integer in 1-65535', () => {
    expect(parseFieldValue('ssh.port', '2222')).toBe(2222);
    expect(() => parseFieldValue('ssh.port', '0')).toThrow(/port/i);
    expect(() => parseFieldValue('ssh.port', '70000')).toThrow(/port/i);
    expect(() => parseFieldValue('ssh.port', 'abc')).toThrow(/port/i);
  });
  it('strips trailing slashes from baseUrl and requires http(s)', () => {
    expect(parseFieldValue('baseUrl', 'https://c.example.com//')).toBe('https://c.example.com');
    expect(() => parseFieldValue('baseUrl', 'ftp://x')).toThrow(/http/);
    expect(() => parseFieldValue('baseUrl', 'not a url')).toThrow(/http/);
  });
  it('enforces token format but allows a ${ENV} reference', () => {
    expect(parseFieldValue('token', '5|abcSECRETxyz')).toBe('5|abcSECRETxyz');
    expect(parseFieldValue('token', '${COOLIFY_TOKEN}')).toBe('${COOLIFY_TOKEN}');
    expect(() => parseFieldValue('token', 'no-pipe-here')).toThrow(/<id>\|<secret>|format/i);
  });
  it('validates db.readonlyUser as a Postgres role name', () => {
    expect(parseFieldValue('db.readonlyUser', 'coolify_ro')).toBe('coolify_ro');
    expect(() => parseFieldValue('db.readonlyUser', '1bad;drop')).toThrow(/role/i);
  });
  it('rejects an unknown field, listing the valid ones', () => {
    expect(() => parseFieldValue('bogus', 'x')).toThrow(/baseUrl/);
  });
  it('rejects an empty value for string fields', () => {
    expect(() => parseFieldValue('ssh.keyPath', '')).toThrow(/empty/i);
  });
});

describe('setField', () => {
  it('sets a top-level field and returns the old value', () => {
    const inst: Record<string, unknown> = { baseUrl: 'https://old', token: '1|t' };
    const r = setField(inst, 'baseUrl', 'https://new');
    expect(inst.baseUrl).toBe('https://new');
    expect(r.old).toBe('https://old');
  });
  it('creates the ssh block when setting ssh.keyPath', () => {
    const inst: Record<string, unknown> = {};
    setField(inst, 'ssh.keyPath', '/home/u/.ssh/id_ed25519');
    expect((inst.ssh as Record<string, unknown>).keyPath).toBe('/home/u/.ssh/id_ed25519');
  });
  it('refuses ssh.host when no ssh block exists (keyPath first)', () => {
    const inst: Record<string, unknown> = {};
    expect(() => setField(inst, 'ssh.host', '203.0.113.5')).toThrow(/ssh\.keyPath/);
  });
  it('allows ssh.host once the block exists', () => {
    const inst: Record<string, unknown> = { ssh: { keyPath: '/k' } };
    setField(inst, 'ssh.host', '203.0.113.5');
    expect((inst.ssh as Record<string, unknown>).host).toBe('203.0.113.5');
  });
  it('creates the db block when setting db.readonlyUser, refuses password-first', () => {
    const inst: Record<string, unknown> = {};
    expect(() => setField(inst, 'db.readonlyPassword', 'pw')).toThrow(/db\.readonlyUser/);
    setField(inst, 'db.readonlyUser', 'ro');
    setField(inst, 'db.readonlyPassword', 'pw');
    expect(inst.db).toEqual({ readonlyUser: 'ro', readonlyPassword: 'pw' });
  });
});

describe('unsetField', () => {
  it('clears an optional scalar and returns the old value', () => {
    const inst: Record<string, unknown> = { pinnedCoolifyVersion: '4.0.0' };
    const r = unsetField(inst, 'pinnedCoolifyVersion');
    expect('pinnedCoolifyVersion' in inst).toBe(false);
    expect(r.old).toBe('4.0.0');
  });
  it('removes a whole ssh or db block', () => {
    const inst: Record<string, unknown> = { ssh: { keyPath: '/k' }, db: { readonlyUser: 'ro' } };
    unsetField(inst, 'ssh');
    unsetField(inst, 'db');
    expect(inst.ssh).toBeUndefined();
    expect(inst.db).toBeUndefined();
  });
  it('refuses required fields, pointing at the block for block-required ones', () => {
    const inst: Record<string, unknown> = {
      baseUrl: 'https://x',
      token: '1|t',
      ssh: { keyPath: '/k' },
    };
    expect(() => unsetField(inst, 'token')).toThrow(/cannot/i);
    expect(() => unsetField(inst, 'ssh.keyPath')).toThrow(/unset .*ssh/i);
  });
  it('rejects a field that is not unsettable', () => {
    const inst: Record<string, unknown> = {};
    expect(() => unsetField(inst, 'bogus')).toThrow(/ssh/); // error lists valid fields
  });
});

describe('redaction and env refs', () => {
  it('isEnvRef detects ${VAR} exactly', () => {
    expect(isEnvRef('${COOLIFY_TOKEN}')).toBe(true);
    expect(isEnvRef('abc${X}')).toBe(false);
    expect(isEnvRef('plain')).toBe(false);
  });
  it('redacts a token keeping id and last 4', () => {
    expect(redactValue('token', '5|CfeZnuO6gs1qUFZCsecret8652d095')).toBe('5|****d095');
  });
  it('redacts other secrets fully except last 4 when long enough', () => {
    expect(redactValue('db.readonlyPassword', 'supersecretpassword')).toBe('****word');
    expect(redactValue('ssh.passphrase', 'short')).toBe('****');
  });
  it('shows ${ENV} references verbatim (no secret to leak)', () => {
    expect(redactValue('token', '${COOLIFY_TOKEN}')).toBe('${COOLIFY_TOKEN}');
  });
  it('passes non-secret fields through', () => {
    expect(redactValue('baseUrl', 'https://c.example.com')).toBe('https://c.example.com');
  });
  it('exports coherent field sets', () => {
    for (const f of SECRET_FIELDS) expect(Object.keys(SETTABLE_FIELDS)).toContain(f);
    expect(UNSETTABLE_FIELDS.has('ssh')).toBe(true);
    expect(UNSETTABLE_FIELDS.has('baseUrl')).toBe(false);
  });
});

describe('redactValue for block values', () => {
  it("shows '(configured)' for object values instead of [object Object]", () => {
    expect(redactValue('ssh', { keyPath: '/k' })).toBe('(configured)');
  });
});
