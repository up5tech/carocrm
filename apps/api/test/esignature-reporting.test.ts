import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESignatureSettingsService } from '../src/esignature/esignature-settings.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.19 — authorized search, operational reports and the ESignature dashlet
 * (`PLAN_Phase_19_ESignature.md` §14, §18 `19-ES.19`).
 *
 * The acceptance criteria, one group each:
 *
 *  - **Reports obey record ACL** — the same person sees their own counts and the administrator sees
 *    every count; a recipient or subject search cannot reveal a request outside the caller's scope.
 *  - **Aggregates do not leak record details** — the response carries counts, rates, durations and
 *    opaque owner/source ids, never a request name, a recipient name or an email address.
 *  - **Date and status definitions** — this suite pins the ones the service documents: created for
 *    the status snapshot and volume, sent for the rate cohort, completed for time-to-completion, and
 *    "now" for the queues.
 *
 * Runs against the configured database (AGENTS.md §3.1). All fixture rows carry this run's marker
 * and are removed by their own ids; the ESignature settings row is restored.
 */

type Method = 'GET' | 'POST';
interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

let ctx: ApiContext;
let app: NestFastifyApplication;
let tokenOwn = '';
let tokenNone = '';
let ownUserId = '';
let baselineSettings: unknown = null;

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ROLE_OWN = `AGENT_TEST-es19-own-${runId}`;
const USER_OWN = `agent_test_es19_own_${runId}`;
const USER_NONE = `agent_test_es19_none_${runId}`;
const OTHER_CREATOR = `agent_test_es19_other_${runId}`;
const DASHBOARD_NAME = `AGENT_TEST_es19_dashboard_${runId}`;
const RUN = `AGENT_TEST_es19_${runId}`;

const created: { requests: string[]; dashboards: string[] } = { requests: [], dashboards: [] };
const now = Date.now();
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000);
const daysAgo = (days: number) => new Date(now - days * 86_400_000);

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

async function call(method: Method, url: string, token: string, payload?: unknown): Promise<CallResult> {
  const res = await app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const raw = res.body ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, raw };
}

interface Fixture {
  readonly name: string;
  readonly createdBy: string;
  readonly status: string;
  readonly createdAt?: Date;
  readonly sentAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly declinedAt?: Date | null;
  readonly approvalStatus?: string;
  readonly approvalRequestedAt?: Date | null;
  readonly failureCategory?: string | null;
  readonly sourceEntityType?: string | null;
  readonly modifiedAt?: Date;
}

/** A fixture row only; the reporting read model is what this suite tests, not the write paths. */
async function insertRequest(fixture: Fixture): Promise<string> {
  const id = randomUUID();
  const createdAt = fixture.createdAt ?? new Date(now);
  await ctx.database.db
    .insertInto('signature_requests')
    .values({
      id,
      name: fixture.name,
      status: fixture.status,
      provider_key: 'docusign',
      source_entity_type: fixture.sourceEntityType ?? null,
      created_by_id: fixture.createdBy,
      assigned_user_id: fixture.createdBy,
      team_ids: JSON.stringify([]),
      approval_required: fixture.approvalStatus !== undefined && fixture.approvalStatus !== 'not_required',
      approval_status: fixture.approvalStatus ?? 'not_required',
      approval_requested_at: fixture.approvalRequestedAt ?? null,
      sent_at: fixture.sentAt ?? null,
      completed_at: fixture.completedAt ?? null,
      declined_at: fixture.declinedAt ?? null,
      failure_category: fixture.failureCategory ?? null,
      failure_code: fixture.failureCategory === null || fixture.failureCategory === undefined ? null : 'AGENT_TEST',
      version: 1,
      created_at: createdAt,
      modified_at: fixture.modifiedAt ?? createdAt,
      deleted_at: null,
    })
    .execute();
  created.requests.push(id);
  return id;
}

async function insertRecipient(
  requestId: string,
  input: { name: string; email: string; status: string; sentAt?: Date | null; completedAt?: Date | null },
): Promise<void> {
  await ctx.database.db
    .insertInto('signature_recipients')
    .values({
      id: randomUUID(),
      request_id: requestId,
      recipient_type: 'signer',
      name: input.name,
      email: input.email,
      routing_order: 1,
      status: input.status,
      sent_at: input.sentAt ?? null,
      completed_at: input.completedAt ?? null,
      created_at: new Date(now),
      modified_at: new Date(now),
      deleted_at: null,
    })
    .execute();
}

async function overview(token: string, days = 30): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  return call('GET', `/api/v1/ESignature/action/reports?days=${days}`, token);
}

function section(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const sections = (body['sections'] ?? []) as { key: string; data: Record<string, unknown> }[];
  const found = sections.find((entry) => entry.key === key);
  expect(found, `section ${key}`).toBeDefined();
  return found?.data ?? {};
}

let ownCompleted = '';
let otherDeclined = '';
let otherWaiting = '';

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
  baselineSettings =
    (await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'ESignature').executeTakeFirst())?.data ?? null;

  await createTestRole(ctx, {
    id: ROLE_OWN,
    name: `AGENT_TEST ES19 own ${runId}`,
    permissions: { SignatureRequest: { read: 'own' } },
  });
  const own = await createTestUser(ctx, { userName: USER_OWN, roleIds: [ROLE_OWN] });
  ownUserId = own.id;
  tokenOwn = own.token;
  tokenNone = (await createTestUser(ctx, { userName: USER_NONE })).token;

  // The module and the request workspace must be on for a report to exist at all.
  const enabled = await call('POST', '/api/v1/ESignature/action/settings', ctx.adminToken, {
    enabled: true,
    features: { requests: true },
  });
  expect(enabled.status, enabled.raw).toBe(200);
  app.get(ESignatureSettingsService).invalidate();

  ownCompleted = await insertRequest({
    name: `${RUN}_own_completed`,
    createdBy: ownUserId,
    status: 'completed',
    sentAt: hoursAgo(2),
    completedAt: hoursAgo(1),
    sourceEntityType: 'Account',
  });
  await insertRecipient(ownCompleted, {
    name: `Own Signer ${runId}`,
    email: `own_signer_${runId}@example.invalid`,
    status: 'completed',
    sentAt: hoursAgo(2),
    completedAt: hoursAgo(1),
  });
  await insertRequest({ name: `${RUN}_own_draft`, createdBy: ownUserId, status: 'draft' });
  await insertRequest({
    name: `${RUN}_old_own_completed`,
    createdBy: ownUserId,
    status: 'completed',
    createdAt: daysAgo(400),
    sentAt: daysAgo(401),
    completedAt: daysAgo(400),
  });

  otherDeclined = await insertRequest({
    name: `${RUN}_other_declined`,
    createdBy: OTHER_CREATOR,
    status: 'declined',
    sentAt: hoursAgo(3),
    declinedAt: hoursAgo(2),
    sourceEntityType: 'Quote',
  });
  await insertRecipient(otherDeclined, {
    name: `Hidden Signer ${runId}`,
    email: `hidden_signer_${runId}@example.invalid`,
    status: 'declined',
    sentAt: hoursAgo(3),
  });
  await insertRequest({
    name: `${RUN}_other_pending`,
    createdBy: OTHER_CREATOR,
    status: 'pending_approval',
    approvalStatus: 'pending',
    approvalRequestedAt: hoursAgo(30),
    sentAt: null,
  });
  otherWaiting = await insertRequest({
    name: `${RUN}_other_waiting`,
    createdBy: OTHER_CREATOR,
    status: 'sent',
    sentAt: hoursAgo(5),
  });
  await insertRecipient(otherWaiting, {
    name: `Waiting Person ${runId}`,
    email: `waiting_person_${runId}@example.invalid`,
    status: 'delivered',
    sentAt: hoursAgo(5),
  });
  await insertRequest({
    name: `${RUN}_other_exception`,
    createdBy: OTHER_CREATOR,
    status: 'send_unknown',
    failureCategory: 'provider',
    sentAt: null,
  });
});

afterAll(async () => {
  const db = ctx.database.db;
  if (created.requests.length > 0) {
    await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  }
  if (created.dashboards.length > 0) {
    await db.deleteFrom('dashlets').where('dashboard_id', 'in', created.dashboards).execute();
    await db.deleteFrom('dashboards').where('id', 'in', created.dashboards).execute();
  }
  if (baselineSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'ESignature').execute();
  } else {
    const serialized = typeof baselineSettings === 'string' ? baselineSettings : JSON.stringify(baselineSettings);
    await db
      .insertInto('app_settings')
      .values({ name: 'ESignature', data: serialized, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
      .execute();
  }
  app.get(ESignatureSettingsService).invalidate();
  await db.deleteFrom('users').where('user_name', 'in', [USER_OWN, USER_NONE]).execute();
  await db.deleteFrom('roles').where('id', '=', ROLE_OWN).execute();
  await shutdownApi();
});

describe('authorized search and filters (acceptance 1)', () => {
  it('searches only inside the caller’s record scope', async () => {
    const own = await call('GET', `/api/v1/ESignature/requests?q=${encodeURIComponent(`${RUN}_own_completed`)}`, tokenOwn);
    expect(own.status, own.raw).toBe(200);
    expect((own.body['list'] as unknown[]).length).toBe(1);

    const hidden = await call('GET', `/api/v1/ESignature/requests?q=${encodeURIComponent(`${RUN}_other_declined`)}`, tokenOwn);
    expect(hidden.status, hidden.raw).toBe(200);
    expect((hidden.body['list'] as unknown[]).length).toBe(0);

    const admin = await call('GET', `/api/v1/ESignature/requests?q=${encodeURIComponent(`${RUN}_other_declined`)}`, ctx.adminToken);
    expect((admin.body['list'] as unknown[]).length).toBe(1);
  });

  it('filters by a recipient only through requests the caller can read', async () => {
    const own = await call('GET', `/api/v1/ESignature/requests?recipient=${encodeURIComponent(`own_signer_${runId}@example.invalid`)}`, tokenOwn);
    expect(own.status, own.raw).toBe(200);
    expect((own.body['list'] as unknown[]).length).toBe(1);

    const hidden = await call(
      'GET',
      `/api/v1/ESignature/requests?recipient=${encodeURIComponent(`hidden_signer_${runId}@example.invalid`)}`,
      tokenOwn,
    );
    expect(hidden.status, hidden.raw).toBe(200);
    expect((hidden.body['list'] as unknown[]).length).toBe(0);

    const admin = await call(
      'GET',
      `/api/v1/ESignature/requests?recipient=${encodeURIComponent(`hidden_signer_${runId}@example.invalid`)}`,
      ctx.adminToken,
    );
    expect((admin.body['list'] as unknown[]).length).toBe(1);
  });

  it('rejects an invalid date bound instead of guessing a timezone', async () => {
    const bad = await call('GET', '/api/v1/ESignature/requests?createdFrom=2026-10-01', tokenOwn);
    expect(bad.status).toBe(400);
  });
});

describe('operational reports honour record ACL (acceptance 1)', () => {
  it('shows a scoped user only their own aggregates', async () => {
    const response = await overview(tokenOwn, 30);
    expect(response.status, response.raw).toBe(200);

    const status = section(response.body, 'status');
    expect(status['total']).toBe(2);
    const rates = section(response.body, 'rates');
    expect(rates['cohort']).toBe(1);
    expect(rates['completed']).toBe(1);
    expect(rates['completionRate']).toBe(1);
    expect(rates['declined']).toBe(0);
    expect(section(response.body, 'approvals')['pending']).toBe(0);
    expect(section(response.body, 'waiting')['recipientsWaiting']).toBe(0);
    expect(section(response.body, 'exceptions')['total']).toBe(0);
    expect(section(response.body, 'completionTime')['completed']).toBe(1);
    expect(section(response.body, 'completionTime')['medianHours']).toBe(1);
    expect(section(response.body, 'volume')['total']).toBe(2);
  });

  it('shows the administrator every aggregate', async () => {
    const response = await overview(ctx.adminToken, 30);
    expect(response.status, response.raw).toBe(200);
    expect(section(response.body, 'status')['total']).toBe(6);
    const rates = section(response.body, 'rates');
    expect(rates['cohort']).toBe(3);
    expect(rates['completed']).toBe(1);
    expect(rates['declined']).toBe(1);
    expect(rates['inFlight']).toBe(1);
    expect(rates['completionRate']).toBeCloseTo(1 / 3, 5);
    expect(section(response.body, 'approvals')['pending']).toBe(1);
    expect(section(response.body, 'approvals')['olderThan24Hours']).toBe(1);
    expect(section(response.body, 'waiting')['requestsWaiting']).toBe(1);
    expect(section(response.body, 'waiting')['recipientsWaiting']).toBe(1);
    expect(section(response.body, 'exceptions')['total']).toBe(1);
    expect(section(response.body, 'volume')['total']).toBe(6);
    const sources = section(response.body, 'volume')['bySource'] as { sourceEntityType: string | null; count: number }[];
    expect(sources.find((row) => row.sourceEntityType === 'Quote')?.count).toBe(1);
  });

  it('applies the documented window to created, sent and completed timestamps', async () => {
    const all = await overview(ctx.adminToken, 0);
    expect(section(all.body, 'status')['total']).toBe(7);
    // Two completed requests, one hour and one day long; `percentile_cont` interpolates the median.
    expect(section(all.body, 'completionTime')['completed']).toBe(2);
    expect(section(all.body, 'completionTime')['medianHours']).toBe(12.5);

    const ninety = await overview(ctx.adminToken, 90);
    expect(section(ninety.body, 'status')['total']).toBe(6);
    expect(section(ninety.body, 'completionTime')['completed']).toBe(1);
    expect(section(ninety.body, 'completionTime')['medianHours']).toBe(1);
  });

  it('narrows the waiting report to one recipient without returning a row', async () => {
    const hit = await call(
      'GET',
      `/api/v1/ESignature/action/reports/waiting?days=30&recipient=${encodeURIComponent(`waiting_person_${runId}@example.invalid`)}`,
      ctx.adminToken,
    );
    expect(hit.status, hit.raw).toBe(200);
    const data = hit.body['data'] as Record<string, unknown>;
    expect(data['requestsWaiting']).toBe(1);
    expect(data['recipientsWaiting']).toBe(1);
    expect(JSON.stringify(hit.body)).not.toContain('waiting_person_');

    const miss = await call(
      'GET',
      `/api/v1/ESignature/action/reports/waiting?days=30&recipient=${encodeURIComponent('nobody_matches_this@example.invalid')}`,
      ctx.adminToken,
    );
    expect((miss.body['data'] as Record<string, unknown>)['recipientsWaiting']).toBe(0);
  });

  it('never returns a request name, recipient name or email in an aggregate', async () => {
    const response = await overview(ctx.adminToken, 0);
    expect(response.raw).not.toContain(RUN);
    expect(response.raw).not.toContain('Hidden Signer');
    expect(response.raw).not.toContain('@example.invalid');
    expect(response.raw).not.toContain('AGENT_TEST');
  });

  it('refuses a caller without the module read right', async () => {
    const denied = await overview(tokenNone, 30);
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe('AUTHORIZATION_DENIED');
  });

  it('refuses an unknown report key', async () => {
    const missing = await call('GET', '/api/v1/ESignature/action/reports/not-a-report', ctx.adminToken);
    expect(missing.status).toBe(404);
  });
});

describe('the ESignature dashlet runs through the shared dashboard API (acceptance 1)', () => {
  it('counts with the reader’s own scope, not the dashboard creator’s', async () => {
    const dashboard = await call('POST', '/api/v1/Dashboard', tokenOwn, { name: DASHBOARD_NAME });
    expect(dashboard.status, dashboard.raw).toBe(201);
    const dashboardId = String(dashboard.body['id']);
    created.dashboards.push(dashboardId);

    const dashlet = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, tokenOwn, {
      name: `${RUN}_status`,
      kind: 'esignature',
      config: { view: 'status', days: 30 },
    });
    expect(dashlet.status, dashlet.raw).toBe(201);
    const dashletId = String(dashlet.body['id']);

    const mine = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets/${dashletId}/action/run`, tokenOwn);
    expect(mine.status, mine.raw).toBe(200);
    expect(mine.body['kind']).toBe('esignature');
    expect(mine.body['key']).toBe('status');
    expect((mine.body['data'] as Record<string, unknown>)['total']).toBe(2);

    const asAdmin = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets/${dashletId}/action/run`, ctx.adminToken);
    expect(asAdmin.status, asAdmin.raw).toBe(200);
    expect((asAdmin.body['data'] as Record<string, unknown>)['total']).toBe(6);
  });

  it('refuses an incomplete or invented dashlet configuration', async () => {
    const dashboard = await call('POST', '/api/v1/Dashboard', tokenOwn, { name: `${DASHBOARD_NAME}_validation` });
    const dashboardId = String(dashboard.body['id']);
    created.dashboards.push(dashboardId);

    const missing = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, tokenOwn, {
      name: `${RUN}_bad`,
      kind: 'esignature',
      config: {},
    });
    expect(missing.status).toBe(422);

    const unknownView = await call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, tokenOwn, {
      name: `${RUN}_bad_view`,
      kind: 'esignature',
      config: { view: 'everything', days: 30 },
    });
    expect(unknownView.status).toBe(422);
  });
});
