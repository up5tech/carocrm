import { readdirSync,readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type AuthenticatedPrincipal, REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import { runAsLeadScoreInternal } from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.18 — the release sweep: reporting, the security matrix, concurrency, the query and migration
 * review (`PLAN_Phase_19_LeadScore.md` §16 `19-LS.18`; audit §11 `LS.18`).
 *
 * The plan's exit criterion for this phase is *"every requirement is mapped to an implementation and a
 * verification result; no unresolved critical security or data-integrity defect remains"*. The mapping lives in
 * `docs/implementation/lead-score-ls18-completion-report.md`; this suite is the part of it that can be **asserted**
 * rather than described:
 *
 *  - **the report** answers its four views, and answers them **under the reader's record scope** — a reader
 *    with `own` sees one Lead's numbers and an administrator sees the instance's;
 *  - **the ACL matrix**: every Lead Score route refuses a caller who holds none of the module's rights, with
 *    the stable `AUTHORIZATION_DENIED` and nothing else;
 *  - **the write guard** still refuses a client write of the score fields and of the module's own records, an
 *    administrator included;
 *  - **concurrency**: two simultaneous conversions of one Lead produce exactly one conversion and one Contact;
 *  - **the migration review**: every Lead Score migration is additive and index-only — no dropped table,
 *    column, truncate or destructive statement — and the schema shows only the migrations this module owns;
 *  - **no extra database**: neither the test support code nor the migrations create, drop or reset one.
 *
 * Runs against the configured primary database (AGENTS.md §3.1): no extra database, no reset, no truncate.
 */

const RUN = `AGENT_TEST_LS18_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const REPORT_PATH = '/api/v1/LeadScore/action/report';

let ctx: ApiContext;
let previousSettings: string | null = null;
let settingsAfterSetup = '';
let adminPrincipal: AuthenticatedPrincipal | undefined;
const created = { records: [] as string[], dashboards: [] as string[], users: [] as string[], roles: [] as string[] };

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface ReportSection {
  key: string;
  label: string;
  description: string;
  generatedAt: string;
  data: Record<string, unknown>;
}

interface ReportView {
  generatedAt: string;
  windowDays: number;
  sections: ReportSection[];
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function errorOf(result: CallResult): { code: string; details: Body } {
  return (result.body['error'] ?? {}) as { code: string; details: Body };
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, `${entity}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  created.records.push(id);
  return id;
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

/** The stored projection, written the way the engine writes it (the module marker), for the report to read. */
async function writeProjection(leadId: string, projection: Record<string, unknown>): Promise<void> {
  if (adminPrincipal === undefined) throw new Error('the admin principal was not resolved');
  const scope = ctx.app.get(REQUEST_SCOPE_TOKEN, { strict: false }) as RequestScope;
  const crud = ctx.app.get(EntityCrudService, { strict: false });
  await scope.runAs(adminPrincipal, () => runAsLeadScoreInternal(() => crud.update('Lead', leadId, projection)));
}

function report(result: CallResult): ReportView {
  return result.body as unknown as ReportView;
}

function sectionOf(view: ReportView, key: string): ReportSection {
  const section = view.sections.find((entry) => entry.key === key);
  if (section === undefined) throw new Error(`the report has no "${key}" section`);
  return section;
}

beforeAll(async () => {
  ctx = await bootApi();
  const admin = await ctx.database.db.selectFrom('users').select(['id', 'user_name']).where('is_admin', '=', true).where('is_deleted', '=', false).limit(1).executeTakeFirst();
  if (admin !== undefined) adminPrincipal = { userId: admin.id, userName: admin.user_name, userType: 'admin', roles: [], teams: [] };

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  await setSettings({
    enabled: true,
    features: {
      modelAdministration: true,
      scoring: true,
      scoreExplanation: true,
      // The conversion chain is a chain: the preview needs the map, the command needs the preview.
      fieldMapping: true,
      conversionPreview: true,
      leadConversion: true,
      conversionRecovery: true,
    },
  });
  settingsAfterSetup = JSON.stringify((await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst())?.data ?? {});
}, 240_000);

afterEach(async () => {
  await ctx.database.db
    .updateTable('app_settings')
    .set({ data: JSON.parse(settingsAfterSetup) as Body, modified_at: new Date() })
    .where('name', '=', SETTINGS_ROW)
    .execute();
});

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === null) await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() }).where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);

  for (const id of created.dashboards) {
    await db.deleteFrom('dashlets').where('dashboard_id', '=', id).execute().catch(() => undefined);
    await db.deleteFrom('dashboards').where('id', '=', id).execute().catch(() => undefined);
  }
  if (created.records.length > 0) {
    const linked = await db.selectFrom('entity_links').select('id').where((eb) => eb.or([eb('record_id_a', 'in', created.records), eb('record_id_b', 'in', created.records)])).execute().catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((entry) => entry.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', created.records).execute().catch(() => undefined);
  }
  if (created.users.length > 0) await db.deleteFrom('users').where('id', 'in', created.users).execute().catch(() => undefined);
  if (created.roles.length > 0) await db.deleteFrom('roles').where('id', 'in', created.roles).execute().catch(() => undefined);

  // A conversion creates its own Contact, so the run's records are also the ones the marker finds: remove
  // them by the marker (AGENTS.md §3.3 — only what this run can positively identify).
  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) {
    const ids = residue.map((row) => row.id);
    const linked = await db.selectFrom('entity_links').select('id').where((eb) => eb.or([eb('record_id_a', 'in', ids), eb('record_id_b', 'in', ids)])).execute().catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((entry) => entry.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
    const left = await db.selectFrom('entity_records').select('id').where('id', 'in', ids).execute().catch(() => [] as { id: string }[]);
    if (left.length > 0) console.warn({ residue: left.length, run: RUN }, 'lead-score release suite left records behind');
  }

  await shutdownApi();
}, 240_000);

describe('the report answers under the reader’s own scope (19-LS.18)', () => {
  it('describes the score population, the bands, the freshness and the conversions', async () => {
    const scored = await createRecord('Lead', { name: `${RUN} scored`, lastName: `${RUN} scored`, company: `${RUN} Acme`, status: 'New' });
    await writeProjection(scored, {
      scoreValue: 72,
      scoreBand: 'Hot',
      scoreStatus: 'current',
      scoreModelVersion: 3,
      scoreCalculatedAt: new Date().toISOString(),
      scoreCoverage: 0.8,
      scoreReasonCodes: JSON.stringify(['ls18_reason_a']),
    });
    await createRecord('Lead', { name: `${RUN} unscored`, lastName: `${RUN} unscored`, status: 'New' });

    const contact = await createRecord('Contact', { name: `${RUN} converted contact`, lastName: `${RUN} converted contact` });
    const opportunity = await createRecord('Opportunity', { name: `${RUN} converted deal` });
    const converted = await createRecord('Lead', { name: `${RUN} converted`, lastName: `${RUN} converted`, status: 'Converted' });
    await writeProjection(converted, {
      status: 'Converted',
      convertedAt: new Date().toISOString(),
      convertedContactId: contact,
      convertedOpportunityId: opportunity,
    });
    const older = await createRecord('Lead', { name: `${RUN} older`, lastName: `${RUN} older`, status: 'Converted' });
    await writeProjection(older, {
      status: 'Converted',
      convertedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000).toISOString(),
      convertedContactId: contact,
    });

    const result = await call('GET', REPORT_PATH);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const view = report(result);
    expect(view.sections.map((section) => section.key)).toEqual(['scores', 'bands', 'freshness', 'conversions']);
    expect(view.windowDays).toBe(30);

    const scores = sectionOf(view, 'scores').data as Record<string, number>;
    expect(scores['scoredLeads']).toBeGreaterThanOrEqual(1);
    expect(scores['unscoredLeads']).toBeGreaterThanOrEqual(1);
    expect(typeof scores['averageScore']).toBe('number');

    const bands = sectionOf(view, 'bands').data as { bands: { band: string; count: number; averageScore: number | null }[] };
    expect(bands.bands.some((entry) => entry.band === 'Hot' && entry.count >= 1)).toBe(true);

    const freshness = sectionOf(view, 'freshness').data as { statuses: { status: string; count: number }[] };
    expect(freshness.statuses.some((entry) => entry.status === 'current' && entry.count >= 1)).toBe(true);
    expect(freshness.statuses.some((entry) => entry.status === 'not_scored' && entry.count >= 1)).toBe(true);

    const conversions = sectionOf(view, 'conversions').data as Record<string, number>;
    expect(conversions['convertedLeads']).toBeGreaterThanOrEqual(2);
    expect(conversions['withContact']).toBeGreaterThanOrEqual(2);
    expect(conversions['withOpportunity']).toBeGreaterThanOrEqual(1);
    // The windowed slice counts the recent conversion and not the one from two months ago.
    expect(conversions['convertedInWindow']).toBeGreaterThanOrEqual(1);
    expect(conversions['convertedInWindow']).toBeLessThan(conversions['convertedLeads']);
  });

  it('counts only the Leads the reader may read', async () => {
    const roleId = `${RUN}_own`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} own reader`, permissions: { Lead: { read: 'own', create: 'yes' }, LeadScore: { read: 'yes' } } });
    created.roles.push(roleId);
    const reader = await createTestUser(ctx, { userName: `${RUN}_own`, roleIds: [roleId] });
    created.users.push(reader.id);

    // The reader's own Lead, created by them: the `own` scope is theirs, and it is theirs alone.
    const mine = await call('POST', '/api/v1/Lead', { name: `${RUN} mine`, lastName: `${RUN} mine`, status: 'New' }, reader.token);
    expect(mine.status).toBe(201);
    created.records.push(String(mine.body['id'] ?? ''));

    const asReader = report(await call('GET', REPORT_PATH, undefined, reader.token));
    const scores = sectionOf(asReader, 'scores').data as Record<string, number>;
    expect(scores['totalLeads']).toBe(1);

    const asAdmin = report(await call('GET', REPORT_PATH));
    const adminScores = sectionOf(asAdmin, 'scores').data as Record<string, number>;
    expect(adminScores['totalLeads']).toBeGreaterThan(1);
  });

  it('runs as a dashlet, and refuses a configuration that names no view', async () => {
    const dashboard = await call('POST', '/api/v1/Dashboard', { name: `${RUN} dashboard` });
    expect(dashboard.status).toBe(201);
    const dashboardId = String(dashboard.body['id'] ?? '');
    created.dashboards.push(dashboardId);

    const added = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, {
      name: `${RUN} score dashlet`,
      kind: 'leadScore',
      position: 0,
      config: { view: 'scores' },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const dashletId = String(added.body['id'] ?? '');

    const run = await call('GET', `/api/v1/Dashboard/${dashboardId}/dashlets/${dashletId}/action/run`);
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body['kind']).toBe('leadScore');
    expect(run.body['key']).toBe('scores');
    expect((run.body['data'] as Record<string, unknown>)['totalLeads']).toBeGreaterThanOrEqual(0);

    const unknownView = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, {
      name: `${RUN} bad dashlet`,
      kind: 'leadScore',
      position: 1,
      config: { view: 'everything' },
    });
    expect(unknownView.status).toBe(422);
    const noView = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, {
      name: `${RUN} empty dashlet`,
      kind: 'leadScore',
      position: 1,
      config: {},
    });
    expect(noView.status).toBe(422);
  });
});

describe('the security sweep (19-LS.18)', () => {
  it('refuses every Lead Score route to a caller who holds none of the module’s rights', async () => {
    const roleId = `${RUN}_nobody`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} nobody`, permissions: { Lead: { read: 'all' } } });
    created.roles.push(roleId);
    const nobody = await createTestUser(ctx, { userName: `${RUN}_nobody`, roleIds: [roleId] });
    created.users.push(nobody.id);

    const leadId = await createRecord('Lead', { name: `${RUN} guarded`, lastName: `${RUN} guarded` });
    const routes: { method: 'GET' | 'POST'; path: string; payload?: unknown }[] = [
      { method: 'GET', path: '/api/v1/LeadScore/action/health' },
      { method: 'GET', path: `/api/v1/LeadScore/action/score/${leadId}` },
      { method: 'GET', path: `/api/v1/LeadScore/action/score/${leadId}/history` },
      { method: 'POST', path: '/api/v1/LeadScore/action/score/recalculate', payload: { leadId } },
      { method: 'POST', path: '/api/v1/LeadScore/action/model/validate', payload: { modelId: 'x' } },
      { method: 'POST', path: '/api/v1/LeadScore/action/conversion/preview', payload: { leadId, targets: [{ type: 'Contact', action: 'create' }] } },
      { method: 'POST', path: '/api/v1/LeadScore/action/conversion/convert', payload: { leadId, operationKey: `${RUN}_key`, targets: [{ type: 'Contact', action: 'create' }], previewHash: 'a'.repeat(64), acknowledged: ['simple'] } },
      { method: 'GET', path: '/api/v1/LeadScore/action/conversion/operations' },
      { method: 'POST', path: '/api/v1/LeadScore/action/insight', payload: { leadId } },
      { method: 'GET', path: REPORT_PATH },
    ];
    for (const route of routes) {
      const result = await call(route.method, route.path, route.payload, nobody.token);
      expect(result.status, `${route.method} ${route.path}`).toBe(403);
      expect(errorOf(result).code, `${route.method} ${route.path}`).toBe('AUTHORIZATION_DENIED');
    }
  });

  it('still refuses a client write of a score field and of a module record, an administrator included', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} guarded`, lastName: `${RUN} guarded` });

    const forgedScore = await call('PATCH', `/api/v1/Lead/${leadId}`, { scoreValue: 99 });
    expect(forgedScore.status).toBe(422);
    expect(JSON.stringify(forgedScore.body)).toContain('scoreValue');

    const forgedConversion = await call('PATCH', `/api/v1/Lead/${leadId}`, { convertedContactId: 'some-contact' });
    expect(forgedConversion.status).toBe(422);
    expect(JSON.stringify(forgedConversion.body)).toContain('convertedContactId');

    const forgedInsight = await call('POST', '/api/v1/LeadScoreInsight', {
      name: `${RUN} forged insight`,
      leadId,
      runId: 'run',
      agentId: 'agent',
      text: 'A score of 99, invented.',
      label: 'ai_generated',
      generatedAt: new Date().toISOString(),
      idempotencyKey: `${RUN}_forged`,
    });
    expect(forgedInsight.status).toBe(422);
    expect(JSON.stringify(forgedInsight.body)).toContain('LeadScoreInsight');
  });
});

describe('the concurrency sweep (19-LS.18)', () => {
  it('converts one Lead once, even when two attempts race', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} race`, lastName: `${RUN} race`, company: `${RUN} Acme`, status: 'New' });
    const targets = [{ type: 'Contact', action: 'create' }];
    const prepared = await call('POST', '/api/v1/LeadScore/action/conversion/preview', { leadId, targets });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const previewHash = String((prepared.body as Body)['previewHash'] ?? '');

    const attempt = (key: string) =>
      call('POST', '/api/v1/LeadScore/action/conversion/convert', {
        leadId,
        operationKey: key,
        targets,
        previewHash,
        acknowledged: ['simple'],
      });

    const [first, second] = await Promise.all([attempt(`${RUN}_race_a`), attempt(`${RUN}_race_b`)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    // Exactly one Contact exists for this Lead, and the Lead is converted once.
    const contacts = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Contact')
      .where(sql`attrs->>'lastName'`, '=', `${RUN} race`)
      .execute();
    expect(contacts).toHaveLength(1);
    const lead = (await call('GET', `/api/v1/Lead/${leadId}`)).body;
    expect(lead['status']).toBe('Converted');
    expect(lead['convertedContactId']).toBe(contacts[0]?.id);
  });
});

describe('the migration and database review (19-LS.18)', () => {
  it('keeps every Lead Score migration additive and index-only', () => {
    const directory = fileURLToPath(new URL('../../../database/migrations/', import.meta.url));
    const files = readdirSync(directory).filter((name) => name.includes('lead_score'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    const forbidden = ['DROP TABLE', 'DROP COLUMN', 'TRUNCATE', 'DELETE FROM', 'ALTER COLUMN', 'CREATE DATABASE', 'CREATE SCHEMA', 'REFRESH MATERIALIZED'];
    for (const file of files) {
      // Only the statements count: a migration's header explains what it does *not* do, and those words
      // ("nothing is truncated") are prose, not SQL.
      const statements = readFileSync(`${directory}/${file}`, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .toUpperCase();
      for (const statement of forbidden) {
        expect(statements.includes(statement), `${file} contains ${statement}`).toBe(false);
      }
    }
  });

  it('applies only the migrations this module owns, and creates no table of its own', async () => {
    const applied = await ctx.database.db.selectFrom('schema_migrations').select('name').where('name', 'like', '%lead_score%').execute();
    const names = applied.map((row) => row.name);
    expect(names).toContain('073_phase19_lead_score.sql');
    expect(names).toContain('074_phase19_lead_score_signals.sql');
    expect(names).toContain('075_phase19_lead_score_insights.sql');
    expect(names).toContain('076_phase19_lead_score_dashlet.sql');

    // The module stores its records in the shared table; it owns no relation of its own.
    const tables = await ctx.database.db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .where((eb) => eb.or([eb('table_name', 'like', '%lead_score%'), eb('table_name', 'like', '%leadscore%')]))
      .execute();
    expect(tables).toEqual([]);
  });

  it('creates no database and resets no schema in the test support code', () => {
    const directory = fileURLToPath(new URL('./support/', import.meta.url));
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(`${directory}/${file}`, 'utf8').toUpperCase();
      for (const statement of ['CREATE DATABASE', 'DROP DATABASE', 'DROP SCHEMA', 'TRUNCATE']) {
        expect(text.includes(statement), `${file} contains ${statement}`).toBe(false);
      }
    }
  });

  it('bounds the report it publishes', async () => {
    const result = await call('GET', REPORT_PATH);
    expect(result.status).toBe(200);
    const view = report(result);
    const bands = sectionOf(view, 'bands').data as { bands: unknown[] };
    const statuses = sectionOf(view, 'freshness').data as { statuses: unknown[] };
    expect(bands.bands.length).toBeLessThanOrEqual(50);
    expect(statuses.statuses.length).toBeLessThanOrEqual(50);
  });
});
