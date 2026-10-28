import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CustomerSuccessSettingsService } from '../src/customer-success/customer-success-settings.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { type ProjectFixture, projectFixture } from './support/projects-fixtures.js';

/**
 * Phase 22.10 — the journey: project onboarding, Customer Success, and renewal
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §13.3, steps 1–9).
 *
 * One story, in order, through the public contracts: an Account gets a Customer Success profile and a
 * CSM, an onboarding playbook starts, the linked Project carries a milestone, the onboarding step
 * produces a real customer task, and the health is recalculated from the evidence that was actually
 * persisted.
 *
 * The step that matters most is the negative one: **completing a Project milestone moves nothing in
 * Customer Success.** The health engine reads Customer Success's own records and the account's
 * customer-linked activities — a `ProjectTask` is neither — so the profile's score, status and
 * progress stay exactly where they were. A milestone is a fact about a delivery, not about the
 * customer's health, and the journey proves the platform keeps that line.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No database is created, reset or
 * truncated; every record is created with an `AGENT_TEST_LS22C_` marker and deleted by exact id.
 */

const WORKER_SECRET = `AGENT_TEST_ls22c_worker_${Date.now().toString(36)}`;
// The worker capability is set before the app boots and restored afterwards: the shared vitest fork
// leaks `process.env` between files, and a suite that kept somebody else's secret would be refused
// by its own scans.
const originalWorkerSecret = process.env.REPORT_WORKER_SECRET;
process.env.REPORT_WORKER_SECRET = WORKER_SECRET;

const runId = Date.now().toString(36);
const marker = (suffix: string) => `AGENT_TEST_LS22C_${suffix}_${runId}`;
const ROLE_OUTSIDER = `AGENT_TEST-ls22c-outsider-${runId}`;
const USER_OUTSIDER = `agent_test_ls22c_outsider_${runId}`;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

let ctx: ApiContext;
let projects: ProjectFixture;
let tokenOutsider = '';
let accountId = '';
let profileId = '';
let projectId = '';
let groupId = '';
let milestoneId = '';
let planId = '';
let riskId = '';
let runId_ = '';
let baselineSettings: string | null = null;
const startedAt = new Date();
const created = { records: [] as string[] };

async function call(
  method: Method,
  url: string,
  payload?: unknown,
  token?: string,
  workerSecret?: string,
): Promise<CallResult> {
  const headers: Record<string, string> = { ...authHeader(token ?? ctx.adminToken) };
  if (workerSecret !== undefined) headers['x-worker-secret'] = workerSecret;
  const res = await ctx.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** A worker-authorised call: the shared capability, the way the scheduler calls it. */
async function workerCall(url: string, payload: Record<string, unknown>): Promise<CallResult> {
  return await call('POST', url, payload, ctx.adminToken, WORKER_SECRET);
}

async function profileRow(): Promise<Record<string, unknown>> {
  const row = await ctx.database.db
    .selectFrom('entity_records')
    .select('attrs')
    .where('entity_type', '=', 'CustomerSuccessProfile')
    .where('id', '=', profileId)
    .executeTakeFirst();
  return (row?.attrs ?? {}) as Record<string, unknown>;
}

/**
 * The notifications of one type that belong to **this journey**.
 *
 * Scoped by the dedup key on purpose: the scans walk every profile in the installation, so the
 * shared database holds notifications that belong to other suites — and a journey that counted them
 * would be asserting about somebody else's work.
 */
async function notificationsOfType(type: string, keyPrefix: string): Promise<{ id: string; dedupKey: string }[]> {
  const result = await sql<{ id: string; data: Record<string, unknown> }>`
    select id, data from notifications
    where type = ${type} and created_at >= ${startedAt}
  `.execute(ctx.database.db);
  return result.rows
    .map((row) => ({ id: row.id, dedupKey: String(row.data['dedupKey'] ?? '') }))
    .filter((row) => row.dedupKey.startsWith(keyPrefix));
}

beforeAll(async () => {
  ctx = await bootApi();
  projects = await projectFixture(ctx);

  const row = await ctx.database.db
    .selectFrom('app_settings')
    .select('data')
    .where('name', '=', 'customerSuccess')
    .executeTakeFirst();
  baselineSettings = row === undefined ? null : JSON.stringify(row.data);

  // The notification writer is off by default; the renewal and risk branches need it on.
  const settings = await call('POST', '/api/v1/CustomerSuccess/action/settings', {
    features: { notifications: true },
    notifications: { enabled: true },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  ctx.app.get(CustomerSuccessSettingsService, { strict: false }).invalidate();

  await createTestRole(ctx, {
    id: ROLE_OUTSIDER,
    name: `AGENT_TEST LS22C outsider ${runId}`,
    permissions: { Account: { read: 'own' } },
  });
  const outsider = await createTestUser(ctx, { userName: USER_OUTSIDER, roleIds: [ROLE_OUTSIDER] });
  tokenOutsider = outsider.token;
  created.records.push(outsider.id);
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  if (baselineSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'customerSuccess').execute().catch(() => undefined);
  } else {
    await db
      .insertInto('app_settings')
      .values({ name: 'customerSuccess', data: baselineSettings, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: baselineSettings, modified_at: new Date() }))
      .execute()
      .catch(() => undefined);
  }
  ctx.app.get(CustomerSuccessSettingsService, { strict: false }).invalidate();

  // The Customer Success rows this run created, by exact id and by the profile they belong to.
  const profileRows = await db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', 'in', [
      'CustomerSuccessProfile',
      'CustomerSuccessPlan',
      'CustomerSuccessGoal',
      'CustomerSuccessRisk',
      'CustomerSuccessPlaybookRun',
      'CustomerSuccessPlaybookStepRun',
      'CustomerSuccessHealthSnapshot',
      'CustomerSuccessPlaybookTemplate',
    ])
    .where((eb) => eb.or([eb('id', 'in', created.records), eb(sql`attrs->>'profileId'`, '=', profileId)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  const ids = [...new Set([...profileRows.map((row) => row.id), ...created.records])];
  if (ids.length > 0) {
    await db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
  }
  // The notifications this journey's scans wrote — identified by their own dedup keys, because the
  // scans walk every profile in the installation.
  await db
    .deleteFrom('notifications')
    .where(sql`data->>'dedupKey' like ${`renewal:${profileId}:%`}`)
    .execute()
    .catch(() => undefined);
  await db
    .deleteFrom('notifications')
    .where(sql`data->>'dedupKey' like ${`riskReview:%`}`)
    .where(sql`data->>'dedupKey' like ${`%${riskId ?? ''}`}`)
    .execute()
    .catch(() => undefined);
  await db
    .deleteFrom('outbox_events')
    .where('event_type', 'like', 'customerSuccess.%')
    .where('created_at', '>=', startedAt)
    .execute()
    .catch(() => undefined);
  await projects.cleanup();
  if (created.records.length > 0) await db.deleteFrom('users').where('id', 'in', created.records).execute().catch(() => undefined);
  await db.deleteFrom('roles').where('id', '=', ROLE_OUTSIDER).execute().catch(() => undefined);
  if (originalWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = originalWorkerSecret;
  await shutdownApi();
}, 240_000);

describe('the journey: onboarding, Customer Success, and renewal (22.10)', () => {
  it('step 1 — the Account gets a Customer Success profile', async () => {
    const account = await call('POST', '/api/v1/Account', { name: marker('account') });
    expect(account.status, JSON.stringify(account.body)).toBe(201);
    accountId = String(account.body['id']);
    created.records.push(accountId);

    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    expect(ensured.status, JSON.stringify(ensured.body)).toBe(200);
    profileId = String(ensured.body['id']);
    created.records.push(profileId);
    expect(ensured.body['created']).toBe(true);

    // The same account never gets a second profile.
    const again = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    expect(again.body['id']).toBe(profileId);
    expect(again.body['created']).toBe(false);

    const profile = await profileRow();
    expect(profile['lifecycleStage']).toBe('onboarding');
    expect(profile['onboardingStatus']).toBe('notStarted');
    expect(profile['healthStatus']).toBe('unknown');
    expect(profile['healthScore'] ?? null).toBeNull();
  });

  it('step 2 — a CSM is assigned, so somebody owns the renewal', async () => {
    const admin = await ctx.database.db
      .selectFrom('users')
      .select('id')
      .where('is_admin', '=', true)
      .where('is_deleted', '=', false)
      .limit(1)
      .executeTakeFirst();
    const assigned = await call(
      'POST',
      `/api/v1/CustomerSuccess/action/assignProfile?profileId=${profileId}`,
      { csmUserId: admin?.id },
    );
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect((await profileRow())['csmUserId']).toBe(admin?.id);
  });

  it('step 3 — the linked Project carries a milestone, and the success plan references it', async () => {
    projectId = await projects.createProject({ name: marker('project'), dateStart: '2026-10-28', dateEnd: '2026-11-28' });
    groupId = await projects.createGroup(projectId, { name: marker('group') });

    const milestone = await projects.call('POST', `/api/v1/Project/${projectId}/action/milestone`, {
      groupId,
      name: marker('milestone'),
      dateStart: '2026-11-15',
    });
    expect(milestone.status, JSON.stringify(milestone.body)).toBeLessThan(300);
    milestoneId = String((milestone.body as unknown as { id: string }).id);
    created.records.push(milestoneId);

    const plan = await call('POST', '/api/v1/CustomerSuccess/action/createPlan', {
      profileId,
      name: marker('plan'),
      planType: 'onboarding',
      startDate: '2026-10-28',
      endDate: '2026-12-31',
      projectId,
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    planId = String((plan.body as unknown as { id: string }).id);
    created.records.push(planId);

    // The link is a reference, not a copy: the plan points at the Project the CRM owns.
    const planRow = await ctx.database.db
      .selectFrom('entity_records')
      .select('attrs')
      .where('entity_type', '=', 'CustomerSuccessPlan')
      .where('id', '=', planId)
      .executeTakeFirst();
    expect((planRow?.attrs as Record<string, unknown>)['projectId']).toBe(projectId);

    // An active plan with a goal: the success-plan signal needs both to say anything at all.
    const activated = await call('POST', '/api/v1/CustomerSuccess/action/activatePlan', {
      planId,
      status: 'active',
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);

    const goal = await call('POST', '/api/v1/CustomerSuccess/action/createGoal', {
      planId,
      name: marker('goal'),
      direction: 'increase',
      baselineValue: 0,
      targetValue: 10,
      currentValue: 4,
      unit: 'workspaces',
      targetDate: '2026-12-31',
    });
    expect(goal.status, JSON.stringify(goal.body)).toBe(200);
    created.records.push(String((goal.body as unknown as { id: string }).id));
  });

  it('step 4 — the onboarding starts once, whatever happens', async () => {
    const started = await call('POST', '/api/v1/CustomerSuccess/action/startOnboarding', { profileId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    runId_ = String(started.body['runId'] ?? '');
    expect(runId_).not.toBe('');
    created.records.push(runId_);

    // The trigger key makes a second start a replay, not a second run.
    const again = await call('POST', '/api/v1/CustomerSuccess/action/startOnboarding', { profileId });
    expect(String(again.body['runId'] ?? '')).toBe(runId_);
    expect(again.body['created']).toBe(false);

    const profile = await profileRow();
    expect(profile['onboardingStatus']).toBe('inProgress');
    expect(profile['activePlaybookRunId']).toBe(runId_);
  });

  it('step 5 — the first onboarding step produces one real customer task, and only one', async () => {
    const run = await call('GET', `/api/v1/CustomerSuccess/action/playbookRun?runId=${runId_}`);
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const steps = (run.body['steps'] ?? []) as Record<string, unknown>[];
    expect(steps.length).toBeGreaterThan(0);
    const step = steps.find((entry) => entry['stepType'] === 'createTask');
    expect(step).toBeDefined();
    const stepRunId = String(step?.['id'] ?? '');

    const completed = await call('POST', '/api/v1/CustomerSuccess/action/completePlaybookStep', { stepRunId });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    // The step produced a CRM Task linked to the account.
    const tasks = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = 'Task' and created_at >= ${startedAt}
    `.execute(ctx.database.db);
    expect(tasks.rows.length).toBe(1);
    // The produced task is this journey's own record: it is removed by its id.
    created.records.push(String(tasks.rows[0]?.id ?? ''));

    // Completing the same step again produces no second task.
    const again = await call('POST', '/api/v1/CustomerSuccess/action/completePlaybookStep', { stepRunId });
    expect(again.status).toBe(200);
    const after = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = 'Task' and created_at >= ${startedAt}
    `.execute(ctx.database.db);
    expect(after.rows.length).toBe(1);
  });

  it('step 6 — the customer task is completed, so the touch is real evidence', async () => {
    const task = await sql<{ id: string }>`
      select id from entity_records where entity_type = 'Task' and created_at >= ${startedAt} limit 1
    `.execute(ctx.database.db);
    const taskId = String(task.rows[0]?.id ?? '');
    expect(taskId).not.toBe('');

    const completed = await call('PATCH', `/api/v1/Task/${taskId}`, { status: 'Completed' });
    expect(completed.status, JSON.stringify(completed.body)).toBeLessThan(300);
  });

  it('step 7 — completing the Project milestone moves nothing in Customer Success', async () => {
    const before = await profileRow();
    const healthBefore = await call('GET', `/api/v1/CustomerSuccess/action/health?profileId=${profileId}`);
    expect(healthBefore.status, JSON.stringify(healthBefore.body)).toBe(200);

    const completed = await call('POST', `/api/v1/ProjectTask/${milestoneId}/action/transition`, { kind: 'complete' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    // The milestone is done on the Project side…
    const task = await call('GET', `/api/v1/ProjectTask/${milestoneId}`);
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    expect((task.body as unknown as { status?: string }).status).toBe('Completed');

    // …and the Customer Success profile is exactly where it was: a delivery milestone is not a
    // customer touch, and it is not a health signal.
    const after = await profileRow();
    expect(after['healthScore']).toBe(before['healthScore']);
    expect(after['healthStatus']).toBe(before['healthStatus']);
    expect(after['healthScoreAt']).toBe(before['healthScoreAt']);
    expect(after['activePlanProgress']).toBe(before['activePlanProgress']);
    expect(after['onboardingStatus']).toBe(before['onboardingStatus']);
  });

  it('step 8 — the health moves when the evidence that belongs to Customer Success moves', async () => {
    const recalculated = await call('POST', '/api/v1/CustomerSuccess/action/recalculateHealth', {
      profileId,
      force: true,
    });
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);

    const profile = await profileRow();
    // The score is a number now, and the history explains it.
    expect(typeof profile['healthScore']).toBe('number');
    expect(profile['healthScoreAt']).not.toBeNull();

    const history = await call('GET', `/api/v1/CustomerSuccess/action/healthHistory?profileId=${profileId}&limit=10`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const list = (history.body['list'] ?? []) as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]?.['score']).toBe(profile['healthScore']);
  });

  it('step 9 — the renewal window notifies once, and only once', async () => {
    // 45 days out: the smallest configured window that covers it is 60 days.
    const renewalDate = new Date(startedAt.getTime() + 45 * 86_400_000).toISOString().slice(0, 10);
    const set = await call('POST', '/api/v1/CustomerSuccess/action/setRenewal', {
      profileId,
      renewalDate,
      status: 'preparing',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    const first = await workerCall('/api/v1/CustomerSuccess/action/evaluate-renewal-windows', {
      today: new Date(startedAt.getTime() + 45 * 86_400_000).toISOString().slice(0, 10),
      limit: 100,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(Number((first.body as unknown as { entered?: number }).entered ?? 0)).toBeGreaterThan(0);

    const notifications = await notificationsOfType('CustomerSuccessRenewal', `renewal:${profileId}:`);
    expect(notifications).toHaveLength(1);

    // The second scan finds the window already announced.
    const second = await workerCall('/api/v1/CustomerSuccess/action/evaluate-renewal-windows', {
      today: new Date(startedAt.getTime() + 45 * 86_400_000).toISOString().slice(0, 10),
      limit: 100,
    });
    expect(second.status).toBe(200);
    expect(await notificationsOfType('CustomerSuccessRenewal', `renewal:${profileId}:`)).toHaveLength(1);
  });

  it('step 10 — an unresolved risk is escalated once, and only once', async () => {
    const today = new Date(startedAt.getTime() + 45 * 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(startedAt.getTime() + 44 * 86_400_000).toISOString().slice(0, 10);
    const risk = await call('POST', '/api/v1/CustomerSuccess/action/createRisk', {
      profileId,
      title: marker('risk'),
      severity: 'critical',
      riskType: 'adoption',
      detectedDate: yesterday,
      targetResolutionDate: yesterday,
      mitigationPlan: 'The adoption plan is agreed; the escalation is the reminder.',
    });
    expect(risk.status, JSON.stringify(risk.body)).toBe(200);
    riskId = String((risk.body as unknown as { id: string }).id);
    created.records.push(riskId);

    const first = await workerCall('/api/v1/CustomerSuccess/action/evaluate-risk-escalations', {
      today,
      limit: 100,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(Number((first.body as unknown as { notified?: number }).notified ?? 0)).toBeGreaterThan(0);

    const notifications = await notificationsOfType('CustomerSuccessRisk', `riskReview:${riskId}:`);
    expect(notifications).toHaveLength(1);

    const second = await workerCall('/api/v1/CustomerSuccess/action/evaluate-risk-escalations', {
      today,
      limit: 100,
    });
    expect(second.status).toBe(200);
    expect(await notificationsOfType('CustomerSuccessRisk', `riskReview:${riskId}:`)).toHaveLength(1);
  });

  it('step 11 — a caller without the right sees neither the risk nor the project', async () => {
    const risks = await call('GET', '/api/v1/CustomerSuccessRisk', undefined, tokenOutsider);
    expect(risks.status).toBe(403);

    const project = await call('GET', `/api/v1/Project/${projectId}`, undefined, tokenOutsider);
    expect(project.status).toBe(403);

    const milestone = await call('GET', `/api/v1/ProjectTask/${milestoneId}`, undefined, tokenOutsider);
    expect(milestone.status).toBe(403);
  });
});
