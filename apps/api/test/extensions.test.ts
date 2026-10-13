import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seed } from '../../../database/seed.js';
import { AuthService } from '../src/auth/auth.service.js';
import { createApp, migrateDb } from '../src/bootstrap.js';
import type { AppConfig } from '../src/config.js';
import { buildConfig } from '../src/config.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, createTestRole, createTestUser } from './support/boot-api.js';

/**
 * Phase 14 — extension SDK (PLAN §38, §39).
 *
 * The suite drives the real lifecycle against the configured project database (AGENTS.md §3.1):
 * install the three sample packages through the admin API, restart the application so the loader
 * picks them up, then assert the contributions, the guards and the uninstall path.
 *
 * Every record it creates carries a run marker and is deleted at the end; extension rows are
 * removed by uninstalling through the API. Extension SQL is additive (`CREATE TABLE IF NOT
 * EXISTS`), so nothing an uninstall leaves behind is destructive.
 */

const EXTENSIONS_DIR = 'modules';
const PACKAGES = ['account-health-fields', 'webhook-integration', 'project-domain'] as const;

let previousExtensionsDir: string | undefined;
/** Audit rows are filtered from here on, so a previous run's rows cannot satisfy the assertion. */
let installStartedAt: Date;
let config: AppConfig;
let app: NestFastifyApplication;
let database: DatabaseService;
let adminToken: string;
let ctx: ApiContext;

async function boot(): Promise<void> {
  process.env.EXTENSIONS_DIR = EXTENSIONS_DIR;
  config = buildConfig();
  app = await createApp(config, { skipMigrations: true });
  database = app.get(DatabaseService);
  adminToken = await adminTokenFor(app);
  ctx = { app, config, adminToken, database, auth: app.get(AuthService) };
}

async function adminTokenFor(instance: NestFastifyApplication): Promise<string> {
  const login = await instance.inject({
    method: 'POST',
    url: '/api/v1/Authentication',
    payload: { userName: 'admin', password: 'admin' },
  });
  if (login.statusCode !== 200 && login.statusCode !== 201) {
    throw new Error(`admin login failed: ${String(login.statusCode)} ${login.body}`);
  }
  return (login.json() as { accessToken: string }).accessToken;
}

async function restart(): Promise<void> {
  await app.close();
  await boot();
}

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token = adminToken, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

beforeAll(async () => {
  previousExtensionsDir = process.env.EXTENSIONS_DIR;
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  process.env.JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME ?? 'crm-jobs-test';
  // The webhook package encrypts its signing secrets at rest; a fixed test key keeps the round
  // trip deterministic and never touches a real credential (AGENTS.md §3.3).
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  await migrateDb(buildConfig().databaseUrl);
  await seed(buildConfig().databaseUrl, { adminLogin: 'admin', adminPassword: 'admin' });
  installStartedAt = new Date();
  await clearInstalledExtensions();
  await boot();
}, 120_000);

afterAll(async () => {
  await uninstallAll();
  await app?.close();
  if (previousExtensionsDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = previousExtensionsDir;
}, 120_000);

async function clearInstalledExtensions(): Promise<void> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: buildConfig().databaseUrl, max: 1 });
  try {
    await pool.query('DELETE FROM installed_extensions');
    await pool.query('DELETE FROM extension_migrations');
  } finally {
    await pool.end();
  }
}

async function uninstallAll(): Promise<void> {
  // Dependencies first: `project-domain` requires `webhook-integration` to stay installed.
  for (const id of ['project-domain', 'webhook-integration', 'account-health-fields']) {
    await api('POST', `/api/v1/Extension/${id}/action/uninstall`).catch(() => undefined);
  }
}

describe('extension installation', () => {
  it('lists the sample packages as available but not installed', async () => {
    const res = await api('GET', '/api/v1/Extension');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { list: { id: string; installed: boolean; running: boolean; order: number; contributes: { migrations: string[]; navItems: number } }[] };
    expect(body.list.map((entry) => entry.id).sort()).toEqual([...PACKAGES].sort());
    for (const entry of body.list) {
      expect(entry.installed).toBe(false);
      expect(entry.running).toBe(false);
    }
    const webhook = body.list.find((entry) => entry.id === 'webhook-integration');
    expect(webhook?.contributes.migrations).toEqual(['001_webhook_endpoints.sql']);
    expect(webhook?.contributes.navItems).toBe(1);
  });

  it('refuses to install a package that is not on disk', async () => {
    const res = await api('POST', '/api/v1/Extension/action/install', adminToken, { id: 'not-a-package' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('refuses a dependent whose dependency is missing', async () => {
    const res = await api('POST', '/api/v1/Extension/action/install', adminToken, { id: 'project-domain' });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { message: string; details: Record<string, unknown> } };
    // The catalog localizes `error.message` to the generic face of the code; the specific reason
    // travels in `error.details.reason`.
    expect(String((body.error.details as Record<string, unknown>)['reason'])).toContain('webhook-integration');
    expect(body.error.details['dependency']).toBe('webhook-integration');
  });

  it('refuses extension administration to a non-admin principal', async () => {
    const user = await createRegularUser('extension-reader');
    const res = await api('GET', '/api/v1/Extension', user.token);
    expect(res.statusCode).toBe(403);
    const install = await api('POST', '/api/v1/Extension/action/install', user.token, { id: 'account-health-fields' });
    expect(install.statusCode).toBe(403);
  });

  it('installs the packages, applies extension migrations and asks for a restart', async () => {
    const health = await api('POST', '/api/v1/Extension/action/install', adminToken, { id: 'account-health-fields' });
    expect(health.statusCode).toBe(200);
    expect((health.json() as { restartRequired: true }).restartRequired).toBe(true);

    const webhook = await api('POST', '/api/v1/Extension/action/install', adminToken, { id: 'webhook-integration' });
    expect(webhook.statusCode).toBe(200);
    const webhookBody = webhook.json() as { migrations: { applied: string[]; skipped: string[] } };
    expect(webhookBody.migrations.applied).toEqual(['001_webhook_endpoints.sql']);
    expect(webhookBody.migrations.skipped).toEqual([]);

    const project = await api('POST', '/api/v1/Extension/action/install', adminToken, { id: 'project-domain' });
    expect(project.statusCode).toBe(200);

    const list = await api('GET', '/api/v1/Extension');
    const installed = (list.json() as { list: { id: string; installed: boolean; enabled: boolean; running: boolean }[] }).list;
    expect(installed.every((entry) => entry.installed && entry.enabled)).toBe(true);
    // The running process was built before the install, so nothing is loaded yet.
    expect(installed.every((entry) => !entry.running)).toBe(true);
  });

  it('is idempotent: installing twice is refused rather than re-running migrations', async () => {
    const again = await api('POST', '/api/v1/Extension/action/install', adminToken, { id: 'webhook-integration' });
    expect(again.statusCode).toBe(422);
    expect(String(((again.json() as { error: { details?: Record<string, unknown> } }).error.details ?? {})['reason'])).toContain('already installed');
  });

  it('records the install in the audit log', async () => {
    const rows = await database.db
      .selectFrom('audit_log')
      .selectAll()
      .where('entity_type', '=', 'Extension')
      .where('action', '=', 'create')
      .where('created_at', '>=', installStartedAt)
      .execute();
    expect([...new Set(rows.map((row) => row.record_id))].sort()).toEqual([...PACKAGES].sort());
  });
});

describe('extension contributions after a restart', () => {
  beforeAll(async () => {
    await restart();
  }, 120_000);

  it('loads the packages in dependency-then-order sequence', async () => {
    const res = await api('GET', '/api/v1/Extension');
    const list = (res.json() as { list: { id: string; running: boolean; order: number }[] }).list;
    expect(list.filter((entry) => entry.running).map((entry) => entry.id)).toEqual(['account-health-fields', 'webhook-integration', 'project-domain']);
  });

  it('merges contributed metadata into the core metadata document', async () => {
    const res = await api('GET', '/api/v1/Metadata');
    const metadata = res.json() as {
      Account: { fields: Record<string, { type: string }>; indexes: { name: string }[] };
      Project: { fields: Record<string, { type: string }>; label: string; indexes: { name: string }[] };
    };
    // metadata-only package
    expect(metadata.Account.fields['healthTier']?.type).toBe('enum');
    expect(metadata.Account.fields['healthScore']?.type).toBe('formula');
    // Phase 19 owns the `Project` entity itself; this package only adds fields to it, so the core
    // fields and the contributed ones must coexist after the merge.
    expect(metadata.Project.label).toBe('Project');
    expect(metadata.Project.fields['dateEnd']?.type).toBe('date');
    expect(metadata.Project.fields['isOverdue']?.type).toBe('formula');
    // An extension index declaration is additive metadata; the core indexes survive the merge.
    expect(metadata.Account.indexes.map((index) => index.name)).toContain('idx_account_health_tier');
    expect(metadata.Project.indexes.map((index) => index.name)).toContain('idx_project_progress');
  });

  it('serves a contributed entity through the generic CRUD API', async () => {
    const marker = `AGENT_TEST_PROJECT_${String(Date.now())}`;
    const created = await api('POST', '/api/v1/Project', adminToken, {
      name: marker,
      boardId: 'projectBoardDefault',
      progress: 10,
      dateEnd: '2030-01-01',
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const where = encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: marker }]));
    const listed = await api('GET', `/api/v1/Project?where=${where}`);
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { total: number }).total).toBe(1);

    // The formula field is computed on write and is not client editable.
    const record = (await api('GET', `/api/v1/Project/${id}`)).json() as Record<string, unknown>;
    expect(record['isOverdue']).toBe('false');

    // A client cannot dictate a computed field: the write that contradicts it is refused (PLAN §21).
    const contradicted = await api('PUT', `/api/v1/Project/${id}`, adminToken, { isOverdue: true });
    expect(contradicted.statusCode).toBe(422);

    const written = await api('PUT', `/api/v1/Project/${id}`, adminToken, { progress: 55 });
    expect(written.statusCode).toBe(200);
    const updated = written.json() as Record<string, unknown>;
    expect(updated['isOverdue']).toBe('false');
    expect(updated['progress']).toBe(55);

    const deleted = await api('DELETE', `/api/v1/Project/${id}`);
    expect(deleted.statusCode).toBe(200);
  }, 60_000);

  it('serves the extension frontend contributions, admin-only entries filtered', async () => {
    const res = await api('GET', '/api/v1/Extension/frontend');
    expect(res.statusCode).toBe(200);
    const nav = (res.json() as { nav: { route: string; label: string; adminOnly: boolean; extension: string }[] }).nav;
    // Sorted by the contributing package's `order`, so navigation follows metadata precedence.
    // `project-domain` contributes none: `Project` is a core Phase 19 entity and already navigable.
    expect(nav).toEqual([
      { route: '/admin/webhook-endpoints', label: 'Webhooks', order: 10, adminOnly: true, icon: 'ApiOutlined', extension: 'webhook-integration', extensionOrder: 250 },
    ]);

    const user = await createRegularUser('extension-nav');
    const userNav = await api('GET', '/api/v1/Extension/frontend', user.token);
    expect((userNav.json() as { nav: unknown[] }).nav).toEqual([]);
  });

  it('runs an extension controller route ahead of the generic record routes', async () => {
    const created = await api('POST', '/api/v1/Project', adminToken, {
      name: `AGENT_TEST_SUMMARY_${String(Date.now())}`,
      boardId: 'projectBoardDefault',
      dateEnd: '2030-01-01',
    });
    const id = (created.json() as { id: string }).id;

    const res = await api('GET', `/api/v1/Project/${id}/summary`);
    expect(res.statusCode).toBe(200);
    const summary = res.json() as { id: string; dateEnd: string; label: string; fieldCount: number };
    expect(summary.id).toBe(id);
    expect(summary.dateEnd).toBe('2030-01-01');
    expect(summary.label).toBe('Project');
    expect(summary.fieldCount).toBeGreaterThan(5);

    await api('DELETE', `/api/v1/Project/${id}`);
  }, 60_000);

  it('keeps the extension webhook API admin-only and refuses private destinations', async () => {
    const list = await api('GET', '/api/v1/WebhookEndpoint');
    expect(list.statusCode).toBe(200);
    expect((list.json() as { total: number }).total).toBe(0);

    const privateUrl = await api('POST', '/api/v1/WebhookEndpoint', adminToken, {
      name: 'AGENT_TEST local',
      url: 'http://127.0.0.1:9/hook',
      events: ['entity.created'],
    });
    expect(privateUrl.statusCode).toBe(422);
    expect(String(((privateUrl.json() as { error: { details?: Record<string, unknown> } }).error.details ?? {})['reason'])).toContain('https');

    const endpoint = await api('POST', '/api/v1/WebhookEndpoint', adminToken, {
      name: `AGENT_TEST hook ${String(Date.now())}`,
      url: 'https://example.com/hooks/carocrm',
      events: ['entity.created'],
      secret: 'shhh',
    });
    expect(endpoint.statusCode).toBe(201);
    const view = endpoint.json() as { id: string; hasSecret: boolean };
    expect(view.hasSecret).toBe(true);
    expect(JSON.stringify(endpoint.json())).not.toContain('shhh');

    const user = await createRegularUser('extension-hook-user');
    expect((await api('GET', '/api/v1/WebhookEndpoint', user.token)).statusCode).toBe(403);

    await api('DELETE', `/api/v1/WebhookEndpoint/${view.id}`);
  }, 60_000);

  it('reports extension hook phases and jobs through the normal introspection endpoints', async () => {
    const hooks = await api('GET', '/api/v1/Hook');
    expect(hooks.statusCode).toBe(200);
    expect((hooks.json() as { phases: string[] }).phases).toContain('beforeSave');

    const extensions = await api('GET', '/api/v1/Extension');
    const webhook = (extensions.json() as { list: { id: string; contributes: { jobs: string[] } }[] }).list.find(
      (entry) => entry.id === 'webhook-integration',
    );
    expect(webhook?.contributes.jobs).toEqual(['webhook.deliver']);
  });
});

describe('extension removal', () => {
  it('refuses to uninstall a package another installed package depends on', async () => {
    const res = await api('POST', '/api/v1/Extension/webhook-integration/action/uninstall');
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { message: string; details: { dependents: string[] } } };
    expect(body.error.details.dependents).toEqual(['project-domain']);
  });

  it('uninstalls the packages and stops contributing metadata after a restart', async () => {
    for (const id of ['project-domain', 'webhook-integration', 'account-health-fields']) {
      const res = await api('POST', `/api/v1/Extension/${id}/action/uninstall`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { restartRequired: true }).restartRequired).toBe(true);
    }

    await restart();

    const metadata = (await api('GET', '/api/v1/Metadata')).json() as {
      Project?: { fields: Record<string, unknown> };
      Account: { fields: Record<string, unknown> };
    };
    // `Project` is core since Phase 19, so the entity itself stays; only the contributed fields go.
    expect(metadata.Project?.fields['isOverdue']).toBeUndefined();
    expect(metadata.Project?.fields['progress']).toBeUndefined();
    expect(metadata.Project?.fields['dateEnd']).toBeDefined();
    expect(metadata.Account.fields['healthTier']).toBeUndefined();

    const list = await api('GET', '/api/v1/Extension');
    const entries = (list.json() as { list: { installed: boolean; running: boolean }[] }).list;
    expect(entries.every((entry) => !entry.installed && !entry.running)).toBe(true);

    // The extension controller is gone with its package.
    expect((await api('GET', '/api/v1/WebhookEndpoint')).statusCode).toBe(404);
  }, 120_000);

  it('refuses to uninstall something that is not installed', async () => {
    const res = await api('POST', '/api/v1/Extension/account-health-fields/action/uninstall');
    expect(res.statusCode).toBe(404);
  });
});

async function createRegularUser(suffix: string): Promise<{ id: string; token: string }> {
  const userName = `AGENT_TEST_${suffix}_${String(Math.floor(Math.random() * 100_000))}`;
  await createTestRole(ctx, {
    id: `role-${userName}`,
    name: `Role ${userName}`,
    permissions: { '*': { create: 'no', read: 'no', edit: 'no', delete: 'no', stream: 'no' } },
  });
  const user = await createTestUser(ctx, { userName, password: 'secret-password', roleIds: [`role-${userName}`] });
  return { id: user.id, token: user.token };
}