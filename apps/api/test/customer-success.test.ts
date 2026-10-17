import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CS — Customer Success API/integration tests (PLAN_Phase_19_Customer_Success.md §15.2, §15.3).
 *
 * These run against the already-configured primary database through the real HTTP API (AGENTS.md §3.1):
 * no database, schema or container is created. Every record this suite makes carries the `runId` marker
 * and is removed by exact id in `cleanup()` (§3.3).
 *
 * The worker-authorised scan endpoints share the platform's `REPORT_WORKER_SECRET` capability, which
 * `phase17-reports.integration.test.ts` already establishes as an environment-level test seam: it is set
 * for the duration of this suite and restored afterwards, so a later suite in the same fork still sees
 * the installation's own value.
 */
const originalWorkerSecret = process.env.REPORT_WORKER_SECRET;
process.env.REPORT_WORKER_SECRET = 'AGENT_TEST_cs_worker_secret';
const WORKER_SECRET = 'AGENT_TEST_cs_worker_secret';

/** Everything this run produced carries a timestamp at or after this one. */
const suiteStartedAt = new Date();

let ctx: ApiContext;
let runId: string;
const created: { entity: string; id: string }[] = [];

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(ctx.adminToken),
    ...(payload !== undefined ? { payload } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function create(entity: string, payload: Record<string, unknown>): Promise<string> {
  const res = await call('POST', `/api/v1/${entity}`, payload);
  expect(res.status, `create ${entity}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const id = String(res.body['id']);
  created.push({ entity, id });
  return id;
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `cs${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
});

afterAll(async () => {
  // Reverse order so children go before parents; exact ids only (§3.3).
  for (const entry of [...created].reverse()) {
    await call('DELETE', `/api/v1/${entry.entity}/${entry.id}`);
  }
  // Templates, runs and step runs carry `delete: 'no'` by design (a finished run is history), so
  // the record API refuses them — including for an administrator. A test must still clean up its
  // own records, so the rows this run created are removed by exact id from the database (§3.3).
  const NON_DELETABLE = new Set([
    'CustomerSuccessPlaybookTemplate',
    'CustomerSuccessPlaybookRun',
    'CustomerSuccessPlaybookStepRun',
  ]);
  const historyIds = created.filter((entry) => NON_DELETABLE.has(entry.entity)).map((entry) => entry.id);
  if (historyIds.length > 0) {
    await ctx.database.db
      .deleteFrom('entity_records')
      .where('id', 'in', historyIds)
      .execute()
      .catch(() => undefined);
  }
  // Health snapshots are written by the engine during recalculation, not through `create()`, so
  // they carry no tracked id. They are removed by the precise predicate that identifies them: a
  // snapshot belongs to a profile this run created. Never a global delete (§3.3).
  const profileIds = created
    .filter((entry) => entry.entity === 'CustomerSuccessProfile')
    .map((entry) => entry.id);
  if (profileIds.length > 0) {
    await ctx.database.db
      .deleteFrom('entity_records')
      .where('entity_type', '=', 'CustomerSuccessHealthSnapshot')
      .where(sql<boolean>`attrs ->> 'profileId'`, 'in', profileIds)
      .execute()
      .catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, [
    'CustomerSuccessProfile',
    'CustomerSuccessHealthSnapshot',
    'CustomerSuccessPlan',
    'CustomerSuccessGoal',
    'CustomerSuccessRisk',
    'CustomerSuccessPlaybookTemplate',
    'CustomerSuccessPlaybookRun',
    'CustomerSuccessPlaybookStepRun',
    'CustomerSuccessReview',
  ]);
  // The module's events are not `entity.*` events, so the shared helper's `payload->>'entityType'`
  // cannot see them. Delete the ones this run produced: same module family, created since the suite
  // started — a narrow predicate, never a global delete (§3.3).
  await ctx.database.db
    .deleteFrom('outbox_events')
    .where('event_type', 'like', 'customerSuccess.%')
    .where('created_at', '>=', suiteStartedAt)
    .execute();
  // In-app notifications this run wrote (§11.3 allows rows; a test must still clean up after itself).
  await ctx.database.db
    .deleteFrom('notifications')
    .where('created_at', '>=', suiteStartedAt)
    .where(sql`data ->> 'module'`, '=', 'CustomerSuccess')
    .execute()
    .catch(() => undefined);
  if (originalWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = originalWorkerSecret;
  await shutdownApi();
});

describe('Customer Success profiles (§5.1)', () => {
  it('creates one profile per account idempotently and rejects a second one', async () => {
    const accountId = await create('Account', { name: marker('account') });

    const first = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    expect(first.status).toBe(200);
    expect(first.body['created']).toBe(true);
    const profileId = String(first.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });

    // Idempotent: a second call returns the same profile rather than creating a duplicate.
    const second = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    expect(second.body['created']).toBe(false);
    expect(second.body['id']).toBe(profileId);

    // The database constraint is the second line of defence: a hand-made duplicate is refused.
    const duplicate = await call('POST', '/api/v1/CustomerSuccessProfile', {
      name: marker('duplicate profile'),
      accountId,
    });
    expect(duplicate.status).toBeGreaterThanOrEqual(400);

    const read = await call('GET', `/api/v1/CustomerSuccessProfile/${profileId}`);
    expect(read.status).toBe(200);

    const summary = await call('GET', `/api/v1/CustomerSuccess/action/profileSummary?profileId=${profileId}`);
    expect(summary.status).toBe(200);
    expect(summary.body['accountId']).toBe(accountId);
    expect(summary.body['lifecycleStage']).toBe('onboarding');
  });
});

describe('health scoring and overrides (§5.4, §5.5)', () => {
  let profileId: string;

  beforeAll(async () => {
    const accountId = await create('Account', { name: marker('health account') });
    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    profileId = String(ensured.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });
  });

  it('returns unknown — never zero — when coverage is insufficient, and writes a snapshot', async () => {
    const recalc = await call('POST', '/api/v1/CustomerSuccess/action/recalculateHealth', {
      profileId,
      force: true,
    });
    expect(recalc.status).toBe(200);
    expect(recalc.body['score']).toBeNull();
    expect(recalc.body['status']).toBe('unknown');
    expect(recalc.body['snapshotWritten']).toBe(true);
  });

  it('applies a manual override without overwriting the calculated result', async () => {
    const set = await call('POST', '/api/v1/CustomerSuccess/action/setHealthOverride', {
      profileId,
      status: 'healthy',
      reason: marker('exec agreed a green status'),
    });
    expect(set.status).toBe(200);
    expect(set.body['calculatedStatus']).toBe('unknown');

    const explanation = await call(
      'GET',
      `/api/v1/CustomerSuccess/action/healthExplanation?profileId=${profileId}`,
    );
    expect(explanation.status).toBe(200);
    expect(explanation.body['calculatedStatus'] ?? explanation.body['status']).toBe('unknown');
    expect(explanation.body['effectiveStatus']).toBe('healthy');
    expect(explanation.body['override']).toMatchObject({ status: 'healthy', active: true });
  });

  it('requires a reason for an override', async () => {
    const bad = await call('POST', '/api/v1/CustomerSuccess/action/setHealthOverride', {
      profileId,
      status: 'healthy',
      reason: '',
    });
    // A missing reason is a malformed request: 400 with the issue list, the convention every
    // controller in this repository follows (`InvalidQueryError`). The domain rule in
    // `HealthService.setOverride` is the second line of defence.
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('at least 1 character');
  });

  it('returns the score history newest-first', async () => {
    const history = await call('GET', `/api/v1/CustomerSuccess/action/healthHistory?profileId=${profileId}`);
    expect(history.status).toBe(200);
    const list = history.body['list'] as Record<string, unknown>[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('configurationVersion');
  });
});

describe('lifecycle, plans, goals and risks (§5.3, §5.6, §5.7, §5.8)', () => {
  let profileId: string;

  beforeAll(async () => {
    const accountId = await create('Account', { name: marker('plan account') });
    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    profileId = String(ensured.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });
  });

  it('validates a lifecycle transition and requires a reason for atRisk', async () => {
    const refused = await call('POST', `/api/v1/CustomerSuccess/action/transitionLifecycle?profileId=${profileId}`, {
      to: 'mature',
    });
    expect(refused.status).toBe(422);

    const ok = await call('POST', `/api/v1/CustomerSuccess/action/transitionLifecycle?profileId=${profileId}`, {
      to: 'atRisk',
      reason: marker('usage dropped'),
    });
    expect(ok.status).toBe(200);
    expect(ok.body['to']).toBe('atRisk');
  });

  it('creates a plan, a goal and computes direction-aware progress', async () => {
    const plan = await call('POST', '/api/v1/CustomerSuccess/action/createPlan', {
      profileId,
      name: marker('plan'),
    });
    expect(plan.status).toBe(200);
    const planId = String(plan.body['id']);
    created.push({ entity: 'CustomerSuccessPlan', id: planId });

    const activate = await call('POST', '/api/v1/CustomerSuccess/action/activatePlan', {
      planId,
      status: 'active',
    });
    expect(activate.status).toBe(200);

    const goal = await call('POST', '/api/v1/CustomerSuccess/action/createGoal', {
      planId,
      name: marker('goal'),
      direction: 'increase',
      baselineValue: 0,
      targetValue: 100,
      currentValue: 25,
    });
    expect(goal.status).toBe(200);
    expect(goal.body['progress']).toBe(25);
    const goalId = String(goal.body['id']);
    created.push({ entity: 'CustomerSuccessGoal', id: goalId });

    const updated = await call('POST', '/api/v1/CustomerSuccess/action/updateGoalProgress', {
      goalId,
      currentValue: 60,
    });
    expect(updated.status).toBe(200);
    expect(updated.body['progress']).toBe(60);

    const summary = await call('GET', `/api/v1/CustomerSuccess/action/planSummary?profileId=${profileId}`);
    expect(summary.status).toBe(200);
    expect((summary.body['activePlan'] as Record<string, unknown>)['progress']).toBeTypeOf('number');
  });

  it('requires mitigation for a high risk and resolves with an outcome', async () => {
    const refused = await call('POST', '/api/v1/CustomerSuccess/action/createRisk', {
      profileId,
      title: marker('critical risk'),
      severity: 'critical',
    });
    expect(refused.status).toBe(422);

    const risk = await call('POST', '/api/v1/CustomerSuccess/action/createRisk', {
      profileId,
      title: marker('risk'),
      severity: 'high',
      nextAction: marker('call the sponsor'),
    });
    expect(risk.status).toBe(200);
    const riskId = String(risk.body['id']);
    created.push({ entity: 'CustomerSuccessRisk', id: riskId });

    const escalated = await call('POST', '/api/v1/CustomerSuccess/action/escalateRisk', { riskId });
    expect(escalated.status).toBe(200);
    expect(escalated.body['status']).toBe('escalated');

    const resolved = await call('POST', '/api/v1/CustomerSuccess/action/resolveRisk', {
      riskId,
      outcome: marker('mitigated'),
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body['status']).toBe('resolved');
  });
});

describe('onboarding playbook (§5.11, §5.5)', () => {
  let profileId: string;

  beforeAll(async () => {
    const accountId = await create('Account', { name: marker('onboarding account') });
    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    profileId = String(ensured.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });
  });

  it('starts a run idempotently, executes a step and creates a real Task', async () => {
    const template = await call('POST', '/api/v1/CustomerSuccess/action/createPlaybookTemplate', {
      name: marker('onboarding template'),
      playbookType: 'onboarding',
      steps: [
        { key: 'kickoff', name: marker('kickoff call'), stepType: 'createTask', order: 0 },
        { key: 'review', name: marker('week-one review'), stepType: 'manual', order: 1 },
      ],
    });
    expect(template.status).toBe(200);
    const templateId = String(template.body['id']);
    created.push({ entity: 'CustomerSuccessPlaybookTemplate', id: templateId });

    const triggerKey = `AGENT_TEST_${runId}:onboarding:${profileId}`;
    const started = await call('POST', '/api/v1/CustomerSuccess/action/startPlaybook', {
      profileId,
      templateId,
      triggerKey,
    });
    expect(started.status).toBe(200);
    const playbookRunId = String(started.body['runId']);
    created.push({ entity: 'CustomerSuccessPlaybookRun', id: playbookRunId });

    // A repeated trigger returns the same run — no duplicate run, no duplicate task.
    const again = await call('POST', '/api/v1/CustomerSuccess/action/startPlaybook', {
      profileId,
      templateId,
      triggerKey,
    });
    expect(again.body['created']).toBe(false);
    expect(again.body['runId']).toBe(playbookRunId);

    const run = await call('GET', `/api/v1/CustomerSuccess/action/playbookRun?runId=${playbookRunId}`);
    expect(run.status).toBe(200);
    const steps = run.body['steps'] as Record<string, unknown>[];
    expect(steps).toHaveLength(2);
    const firstStepId = String(steps[0]?.['id']);
    created.push({ entity: 'CustomerSuccessPlaybookStepRun', id: firstStepId });

    const completed = await call('POST', '/api/v1/CustomerSuccess/action/completePlaybookStep', {
      stepRunId: firstStepId,
    });
    expect(completed.status).toBe(200);
    expect(completed.body['status']).toBe('completed');
    const produced = completed.body['produced'] as Record<string, unknown> | undefined;
    expect(produced?.['entityType']).toBe('Task');
    if (typeof produced?.['id'] === 'string') created.push({ entity: 'Task', id: produced['id'] });

    // It is idempotent: completing the same step again changes nothing.
    const repeated = await call('POST', '/api/v1/CustomerSuccess/action/completePlaybookStep', {
      stepRunId: firstStepId,
    });
    expect(repeated.body['changed']).toBe(false);
  });

  it('runs the seeded default onboarding playbook when no template is named (§6.6)', async () => {
    const template = await call('GET', '/api/v1/CustomerSuccessPlaybookTemplate/csTemplateOnboarding');
    expect(template.status, JSON.stringify(template.body)).toBe(200);

    const accountId = await create('Account', { name: marker('onboarded account') });
    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    const profileId = String(ensured.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });

    const started = await call('POST', '/api/v1/CustomerSuccess/action/startOnboarding', { profileId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    // Not the manual fallback: the installation ships an onboarding playbook.
    expect(started.body['manual']).toBeUndefined();
    expect(started.body['runId']).toBeTruthy();
    const playbookRunId = String(started.body['runId']);
    created.push({ entity: 'CustomerSuccessPlaybookRun', id: playbookRunId });

    const view = await call('GET', `/api/v1/CustomerSuccess/action/playbookRun?runId=${playbookRunId}`);
    const steps = view.body['steps'] as Record<string, unknown>[];
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const step of steps) created.push({ entity: 'CustomerSuccessPlaybookStepRun', id: String(step['id']) });
    expect(view.body['onboarding']).toBe(true);

    const profile = await call('GET', `/api/v1/CustomerSuccessProfile/${profileId}`);
    expect(profile.body['onboardingStatus']).toBe('inProgress');

    // Starting onboarding again is idempotent: the same run, no second set of steps.
    const again = await call('POST', '/api/v1/CustomerSuccess/action/startOnboarding', { profileId });
    expect(again.status).toBe(200);
    expect(again.body['created']).toBe(false);
    expect(again.body['runId']).toBe(playbookRunId);
  });
});

describe('portfolio queues and dashlets (§5.2, §5.12)', () => {
  it('returns ACL-scoped queues and an aggregate', async () => {
    const queues = await call('GET', '/api/v1/CustomerSuccess/action/portfolioQueues?queue=myPortfolio&limit=5');
    expect(queues.status).toBe(200);
    expect(Array.isArray(queues.body['list'])).toBe(true);

    const summary = await call('GET', '/api/v1/CustomerSuccess/action/portfolioSummary');
    expect(summary.status).toBe(200);
    expect(summary.body['byHealth']).toBeTypeOf('object');

    const dashlets = await call('GET', '/api/v1/CustomerSuccess/action/dashlets');
    expect(dashlets.status).toBe(200);
    expect((dashlets.body['list'] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('security and integrity (§9, §13)', () => {
  it('refuses a client write to a server-computed health field', async () => {
    const accountId = await create('Account', { name: marker('guard account') });
    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    const profileId = String(ensured.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });

    const forged = await call('PUT', `/api/v1/CustomerSuccessProfile/${profileId}`, { healthScore: 99 });
    expect(forged.status).toBe(422);

    const read = await call('GET', `/api/v1/CustomerSuccessProfile/${profileId}`);
    expect(read.body['healthScore'] ?? null).toBeNull();
  });

  it('keeps health snapshots append-only', async () => {
    const attempt = await call('POST', '/api/v1/CustomerSuccessHealthSnapshot', {
      name: marker('forged snapshot'),
      profileId: 'nope',
      score: 100,
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);
  });

  it('reports the module as a dependency of the generic :entity wildcard order, and Sales reports Customer Success available (§12.8)', async () => {
    const health = await call('GET', '/api/v1/CustomerSuccess/action/health');
    expect(health.status).toBe(200);
    expect(health.body['module']).toMatchObject({ id: 'CustomerSuccess' });
    const checks = health.body['checks'] as { name: string; ok: boolean }[];
    expect(checks.find((check) => check.name === 'sales-integration-marker')?.ok).toBe(true);

    const sales = await call('GET', '/api/v1/Sales/action/health');
    expect(sales.status).toBe(200);
    const integrations = sales.body['optionalIntegrations'] as { id: string; status: string }[];
    expect(integrations.find((entry) => entry.id === 'customer-success')?.status).toBe('available');
  });
});

describe('background job surface (§8.2, §11.1)', () => {
  /** Calls a worker-authorised scan with the shared capability. */
  const workerCall = async (url: string, payload: Record<string, unknown>) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { ...authHeader(ctx.adminToken), 'x-worker-secret': WORKER_SECRET },
      payload,
    });
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.statusCode, body };
  };

  it('runs bulk health recalculation as an administrator-only background job', async () => {
    const res = await call('POST', '/api/v1/CustomerSuccess/action/bulkRecalculateHealth', {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const job = res.body['job'] as { id: string; job: string; status: string };
    expect(job.job).toBe('customerSuccess.recalculateHealthBatch');
    expect(job.status).toBe('pending');
    // A test never leaves queued work behind: cancel exactly what it created.
    const cancel = await call('POST', `/api/v1/Job/${job.id}/action/cancel`, {});
    expect(cancel.status).toBeLessThan(300);
  });

  it('refuses bulk health recalculation to a user who is not an administrator', async () => {
    const user = await createTestUser(ctx, { userName: `cs_noAdmin_${runId}` });
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/CustomerSuccess/action/bulkRecalculateHealth',
        headers: authHeader(user.token),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
    }
  });

  it('refuses a worker scan without the shared capability', async () => {
    const noSecret = await call('POST', '/api/v1/CustomerSuccess/action/update-goal-overdue-state', { limit: 1 });
    expect(noSecret.status).toBe(401);

    const wrongSecret = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/CustomerSuccess/action/update-goal-overdue-state',
      headers: { ...authHeader(ctx.adminToken), 'x-worker-secret': 'not-the-capability' },
      payload: { limit: 1 },
    });
    expect(wrongSecret.statusCode).toBe(401);
  });

  it('answers every §11.1 scan with its own bounded counts and duration', async () => {
    // `1900-01-01` makes every date condition false, so the run is a scan that reports counts rather
    // than one that changes state — the only writes left are the derived indicators and the in-app
    // notifications the plan allows a test to create (§11.3).
    const scans = [
      '/api/v1/CustomerSuccess/action/update-goal-overdue-state',
      '/api/v1/CustomerSuccess/action/evaluate-renewal-windows',
      '/api/v1/CustomerSuccess/action/evaluate-risk-escalations',
      '/api/v1/CustomerSuccess/action/evaluate-review-reminders',
      '/api/v1/CustomerSuccess/action/process-playbook-wait-steps',
      '/api/v1/CustomerSuccess/action/repair-stale-playbook-runs',
      '/api/v1/CustomerSuccess/action/expire-overrides',
    ];
    for (const url of scans) {
      const res = await workerCall(url, { today: '1900-01-01', limit: 25 });
      expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(200);
      for (const key of ['processed', 'skipped', 'errors', 'durationMs']) {
        expect(typeof res.body[key], `${url} → ${key}`).toBe('number');
      }
    }

    const batch = await workerCall('/api/v1/CustomerSuccess/action/recalculate-batch', { limit: 5 });
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    for (const key of ['processed', 'skipped', 'errors', 'durationMs']) {
      expect(typeof batch.body[key], `recalculate-batch → ${key}`).toBe('number');
    }
  });
});

describe('assignment and request shapes (§5.2, §8.2)', () => {
  it('assigns a CSM without clearing the team, clears it explicitly, and refuses an empty request', async () => {
    const accountId = await create('Account', { name: marker('assign account') });
    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    expect(ensured.status).toBe(200);
    const profileId = String(ensured.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });
    const assign = (payload: Record<string, unknown>) =>
      call('POST', `/api/v1/CustomerSuccess/action/assignProfile?profileId=${profileId}`, payload);

    const team = await assign({ csmTeamId: 'teamSales' });
    expect(team.status, JSON.stringify(team.body)).toBe(200);

    // Setting the CSM must not silently clear the team that was set a moment earlier.
    const csm = await assign({ csmUserId: 'adminUserId' });
    expect(csm.status, JSON.stringify(csm.body)).toBe(200);
    const read = await call('GET', `/api/v1/CustomerSuccessProfile/${profileId}`);
    expect(read.body['csmUserId']).toBe('adminUserId');
    expect(read.body['csmTeamId']).toBe('teamSales');

    // An explicit null clears it — that is what makes "left unassigned" representable.
    const cleared = await assign({ csmUserId: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    const after = await call('GET', `/api/v1/CustomerSuccessProfile/${profileId}`);
    expect(after.body['csmUserId']).toBeNull();
    expect(after.body['csmTeamId']).toBe('teamSales');

    const empty = await assign({});
    expect(empty.status).toBe(422);
    expect(JSON.stringify(empty.body)).toContain('must name a CSM or a team');
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const res = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', {
      accountId: 'not-checked-because-the-shape-fails-first',
      unexpectedField: 1,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('unexpectedField');
  });
});

describe('playbook failure state (§5.11.3, §11.2, §16.3)', () => {
  it('records a retry-safe failure when the step producer fails, and reports it', async () => {
    const accountId = await create('Account', { name: marker('failure account') });
    const ensured = await call('POST', '/api/v1/CustomerSuccess/action/ensureProfile', { accountId });
    expect(ensured.status).toBe(200);
    const profileId = String(ensured.body['id']);
    created.push({ entity: 'CustomerSuccessProfile', id: profileId });
    const assigned = await call(
      'POST',
      `/api/v1/CustomerSuccess/action/assignProfile?profileId=${profileId}`,
      { csmUserId: 'adminUserId' },
    );
    expect(assigned.status).toBe(200);

    const template = await call('POST', '/api/v1/CustomerSuccess/action/createPlaybookTemplate', {
      name: marker('failure template'),
      playbookType: 'custom',
      steps: [{ key: 'risk', name: marker('log the risk'), stepType: 'createRisk', order: 0 }],
    });
    expect(template.status, JSON.stringify(template.body)).toBe(200);
    const templateId = String(template.body['id']);
    created.push({ entity: 'CustomerSuccessPlaybookTemplate', id: templateId });

    const started = await call('POST', '/api/v1/CustomerSuccess/action/startPlaybook', {
      profileId,
      templateId,
      triggerKey: `AGENT_TEST_${runId}:failure:${profileId}`,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const playbookRunId = String(started.body['runId']);
    created.push({ entity: 'CustomerSuccessPlaybookRun', id: playbookRunId });
    const first = await call('GET', `/api/v1/CustomerSuccess/action/playbookRun?runId=${playbookRunId}`);
    const firstStepId = String((first.body['steps'] as Record<string, unknown>[])[0]?.['id']);
    created.push({ entity: 'CustomerSuccessPlaybookStepRun', id: firstStepId });

    // Removing the profile makes the producer fail: `createRisk` resolves the profile first and
    // answers "not found" instead of writing a record.
    const removed = await call('DELETE', `/api/v1/CustomerSuccessProfile/${profileId}`);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);

    const failed = await call('POST', '/api/v1/CustomerSuccess/action/completePlaybookStep', {
      stepRunId: firstStepId,
    });
    // The real reason still reaches the caller — nothing is swallowed to keep the test quiet.
    expect(failed.status).toBe(404);
    expect(JSON.stringify(failed.body)).toContain('NOT_FOUND');

    const after = await call('GET', `/api/v1/CustomerSuccess/action/playbookRun?runId=${playbookRunId}`);
    const step = (after.body['steps'] as Record<string, unknown>[])[0];
    expect(step?.['status']).toBe('failed');
    expect(String(step?.['errorSummary'] ?? '')).not.toBe('');
    expect(Number(step?.['attemptCount'])).toBe(1);
    // A failed step is not progress: the run stays open for a person or a retry.
    expect(after.body['status']).toBe('running');

    // §8.2 `retryFailedSteps`: there is now something real to retry.
    const retried = await call('POST', '/api/v1/CustomerSuccess/action/retryFailedSteps', {
      runId: playbookRunId,
    });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body['retried']).toBe(1);
    const retriedView = await call('GET', `/api/v1/CustomerSuccess/action/playbookRun?runId=${playbookRunId}`);
    const retriedStep = (retriedView.body['steps'] as Record<string, unknown>[])[0];
    expect(retriedStep?.['status']).toBe('pending');
    expect(retriedStep?.['errorSummary'] ?? null).toBeNull();
  });
});
