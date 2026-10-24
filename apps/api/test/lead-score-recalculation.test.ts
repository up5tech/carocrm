import { createHash } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.6 — deciding *when* to score, in the background
 * (`PLAN_Phase_19_LeadScore.md` §4.2, §9.3–§9.4, §10.2, §11.1, §16 `19-LS.6`; report
 * `docs/implementation/lead-score-ls6-completion-report.md`).
 *
 * LS.5 proved that scoring one Lead is safe to repeat. This phase is about *who* asks for it and *how often*,
 * and the properties its acceptance criteria name are the things this suite drives through the real routes:
 *
 * 1. **the hand-off is a decision, not a write.** A committed Lead change reaches the API and gets one of six
 *    answers — queued, already queued, inputs unaffected, Lead gone, no active model, switched off — each of
 *    which is a 200 response, because a subscriber that threw on "nothing to do" would retry an event forever.
 * 2. **the loop is broken by a fact, not by a flag.** The fields LS.5 writes onto a Lead can never be rule
 *    inputs (LS.3 refuses them), so a projection write's own `changed` list cannot re-trigger a
 *    recalculation. Asserted here from the outbox payload a score write actually produced.
 * 3. **a burst collapses.** Two deliveries of the same change create one job row — the deterministic id, the
 *    outstanding-job check and the duplicate-key answer are all exercised.
 * 4. **a rebuild is bounded, chunked, counted and stoppable.** Chunk size and limit cannot be raised by
 *    asking; the cursor hands on; a cancel ends the chain instead of forking a successor; a per-Lead failure
 *    comes back as a code and the run continues; and re-running a chunk records nothing a second time.
 *
 * Plus the door every one of these routes stands behind: `x-worker-secret`, the platform's shared worker
 * capability, compared in constant time and refused outright when unset.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). `afterAll` restores the `leadScore` settings
 * row and the `REPORT_WORKER_SECRET` environment, and deletes only this run's Leads, model, rules,
 * evaluations, outbox rows and job rows — by exact id or by the run marker inside the job payload.
 */

const RUN = `AGENT_TEST_LS6_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODEL = 'LeadScoreModel';
const RULE = 'LeadScoreRule';
const RECALCULATE_PATH = '/api/v1/LeadScore/action/score/recalculate';
const LEAD_CHANGED_PATH = '/api/v1/LeadScore/action/work/lead-changed';
const WORK_RECALCULATE_PATH = '/api/v1/LeadScore/action/work/recalculate';
const WORK_CHUNK_PATH = '/api/v1/LeadScore/action/work/recalculate-batch-chunk';
const BATCH_PATH = '/api/v1/LeadScore/action/recalculate-batch';

const RECALCULATE_LEAD_JOB = 'leadScore.recalculateLead';
const BATCH_JOB = 'leadScore.batchRecalculate';

/** The capability is an instance setting, so this suite installs its own and puts the previous one back. */
const previousWorkerSecret = process.env.REPORT_WORKER_SECRET;
const WORKER_SECRET = `${RUN}_capability`;
process.env.REPORT_WORKER_SECRET = WORKER_SECRET;

let ctx: ApiContext;
let previousSettings: string | null = null;
const createdRecordIds: string[] = [];
const createdRoleIds: string[] = [];
const createdUserNames: string[] = [];
/** Rebuild ids this run started, so the `jobs` rows they own can be removed by their own coordinate. */
const createdRunIds: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface Decision {
  queued: boolean;
  reason: string;
  jobId: string | null;
  modelVersion: number | null;
  debounceMs: number;
}

interface ChunkView {
  runId: string;
  processed: number;
  scored: number;
  unchanged: number;
  failed: number;
  errorCodes: string[];
  cursor: string | null;
  done: boolean;
  cancelled: boolean;
  remaining: number;
  nextJobId: string | null;
  processedTotal: number;
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

/**
 * A worker call carries the capability and nothing else.
 *
 * No bearer token, on purpose: these routes are `@Public()` and answered by the shared secret, so the test
 * proves the secret is the authorisation rather than letting an administrator session carry it.
 */
/** `secret: null` means "send no capability header at all" — the case a misconfigured worker hits. */
async function workerCall(url: string, payload: unknown, options: { secret?: string | null } = {}): Promise<CallResult> {
  const secret = 'secret' in options ? options.secret : WORKER_SECRET;
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-worker-secret': secret }) },
    payload: payload as Record<string, unknown>,
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
  const error = result.body['error'] as { code?: string; details?: Body } | undefined;
  return { code: String(error?.code ?? ''), details: error?.details ?? {} };
}

function decisionOf(result: CallResult): Decision {
  return result.body as unknown as Decision;
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  expect(id).not.toBe('');
  createdRecordIds.push(id);
  return id;
}

/** base 20 + `company` 10 + `industry=Software` 20: a Software company Lead scores 50. */
async function createPublishedModel(name = 'active'): Promise<{ id: string; version: number }> {
  const modelId = await createRecord(MODEL, {
    name: `${RUN} ${name}`,
    description: 'Model for the LS.6 recalculation suite.',
    modelVersion: 1,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 20,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: JSON.stringify([
      { band: 'Cold', min: 0, max: 39 },
      { band: 'Warm', min: 40, max: 69 },
      { band: 'Hot', min: 70, max: 89 },
      { band: 'Sales Ready', min: 90, max: 100 },
    ]),
    allowedFieldPaths: JSON.stringify(['company', 'industry']),
  });
  await createRecord(RULE, {
    name: `${RUN} company rule`,
    modelId,
    modelVersion: 1,
    reasonCode: `ls6_company_${modelId.slice(-6)}`,
    dimension: 'completeness',
    enabled: true,
    condition: JSON.stringify({ field: 'company', operator: 'isNotEmpty' }),
    effect: 'add',
    points: 10,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  await createRecord(RULE, {
    name: `${RUN} industry rule`,
    modelId,
    modelVersion: 1,
    reasonCode: `ls6_industry_${modelId.slice(-6)}`,
    dimension: 'fit',
    enabled: true,
    condition: JSON.stringify({ field: 'industry', operator: 'equals', value: 'Software' }),
    effect: 'add',
    points: 20,
    priority: 20,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  const published = await call('POST', '/api/v1/LeadScore/action/model/publish', { modelId });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return { id: modelId, version: Number(published.body['modelVersion'] ?? 1) };
}

async function patchSettings(patch: Record<string, unknown>): Promise<CallResult> {
  return call('POST', '/api/v1/LeadScore/action/settings', patch);
}

/** Everything this phase needs switched on, with the model an event or a rebuild will score under. */
async function enableScoring(modelId: string | null): Promise<void> {
  const result = await patchSettings({
    enabled: true,
    features: {
      modelAdministration: true,
      scoring: true,
      manualRecalculation: true,
      scoreExplanation: true,
      eventRecalculation: true,
      batchRecalculation: true,
    },
    scoring: { activeModelId: modelId },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function createLead(label: string, data: Record<string, unknown> = {}): Promise<string> {
  return createRecord('Lead', { name: `${RUN} ${label}`, lastName: `${RUN} ${label}`, ...data });
}

async function readLead(leadId: string): Promise<Body> {
  const result = await call('GET', `/api/v1/Lead/${leadId}`);
  expect(result.status).toBe(200);
  return result.body;
}

/**
 * Job rows for one Lead or one run.
 *
 * One of the two is required: `jobs` is instance-wide, and a suite that could ask "are there no jobs?" in
 * general would be reading other people's work — or the development queue's.
 */
async function jobRows(input: { leadId?: string; runId?: string }): Promise<{ id: string; status: string; target: Body }[]> {
  if (input.leadId === undefined && input.runId === undefined) throw new Error('jobRows needs a leadId or a runId.');
  let query = ctx.database.db.selectFrom('jobs').select(['id', 'status', 'target']).where('job', 'in', [RECALCULATE_LEAD_JOB, BATCH_JOB]);
  if (input.leadId !== undefined) query = query.where(sql`target ->> 'leadId'`, '=', input.leadId);
  if (input.runId !== undefined) query = query.where(sql`target ->> 'runId'`, '=', input.runId);
  const rows = await query.orderBy('created_at', 'asc').limit(50).execute();
  return rows.map((row) => ({ id: row.id, status: row.status, target: row.target as unknown as Body }));
}

async function evaluationRows(leadId: string): Promise<{ id: string; trigger: string }[]> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select(['id', sql`attrs ->> 'trigger'`.as('trigger')])
    .where('entity_type', '=', 'LeadScoreEvaluation')
    .where(sql`attrs ->> 'leadId'`, '=', leadId)
    .execute();
  return rows.map((row) => ({ id: row.id, trigger: String(row.trigger ?? '') }));
}

/** The deterministic job id the service computes, reproduced here so the dedupe is a fact, not a claim. */
function expectedJobId(leadId: string, modelVersion: number, revision: number): string {
  return createHash('sha256')
    .update(`${RECALCULATE_LEAD_JOB}|${leadId}|${String(modelVersion)}|${String(revision)}`)
    .digest('hex');
}

/** The `changed` list the last record write of this Lead published — the loop test reads reality, not a fixture. */
async function lastChangedFields(leadId: string): Promise<string[]> {
  const rows = await ctx.database.db
    .selectFrom('outbox_events')
    .select('payload')
    .where(sql`payload ->> 'entityId'`, '=', leadId)
    .where('event_type', '=', 'entity.updated')
    .orderBy('id', 'desc')
    .limit(1)
    .execute();
  const payload = rows[0]?.payload as unknown as { changed?: unknown };
  return Array.isArray(payload?.changed) ? (payload.changed as string[]) : [];
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const enabled = await patchSettings({ enabled: true, features: { modelAdministration: true } });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
}, 240_000);

afterAll(async () => {
  if (previousWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = previousWorkerSecret;

  const db = ctx.database.db;
  if (previousSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  } else {
    await db
      .updateTable('app_settings')
      .set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() })
      .where('name', '=', SETTINGS_ROW)
      .execute()
      .catch(() => undefined);
  }

  // Only this run's job rows: the ones naming a record it created, and the ones naming a run id or Lead id
  // carrying the run marker. Nothing else in `jobs` is touched (AGENTS.md §3.3).
  const jobIds: string[] = [];
  if (createdRecordIds.length > 0) {
    const byLead = await db
      .selectFrom('jobs')
      .select('id')
      .where('job', 'in', [RECALCULATE_LEAD_JOB, BATCH_JOB])
      .where(sql`target ->> 'leadId'`, 'in', createdRecordIds)
      .execute()
      .catch(() => [] as { id: string }[]);
    jobIds.push(...byLead.map((row) => row.id));
  }
  const byMarker = await db
    .selectFrom('jobs')
    .select('id')
    .where('job', 'in', [RECALCULATE_LEAD_JOB, BATCH_JOB])
    .where((eb) =>
      eb.or([
        eb(sql`target::text`, 'like', `%${RUN}%`),
        ...(createdRunIds.length > 0 ? [eb(sql`target ->> 'runId'`, 'in', createdRunIds)] : []),
      ]),
    )
    .execute()
    .catch(() => [] as { id: string }[]);
  jobIds.push(...byMarker.map((row) => row.id));
  const uniqueJobIds = [...new Set(jobIds)];
  if (uniqueJobIds.length > 0) {
    await db.deleteFrom('job_logs').where('job_id', 'in', uniqueJobIds).execute().catch(() => undefined);
    await db.deleteFrom('jobs').where('id', 'in', uniqueJobIds).execute().catch(() => undefined);
  }

  // Every mutation this suite made also wrote a transactional outbox row. Nothing polls it in a test run, but
  // a development worker would eventually read it, so the rows naming this run's records go with the records.
  if (createdRecordIds.length > 0) {
    await db
      .deleteFrom('outbox_events')
      .where(sql`payload ->> 'entityId'`, 'in', createdRecordIds)
      .execute()
      .catch(() => undefined);
  }

  // Evaluations are named for the score the engine produced, not for this run, so they are swept by the Lead
  // they describe. Without this a suite that scores Leads leaves rows pointing at records that are gone.
  if (createdRecordIds.length > 0) {
    await db
      .deleteFrom('entity_records')
      .where('entity_type', '=', 'LeadScoreEvaluation')
      .where(sql`attrs ->> 'leadId'`, 'in', createdRecordIds)
      .execute()
      .catch(() => undefined);
  }

  if (createdRecordIds.length > 0) {
    const linked = await db
      .selectFrom('entity_links')
      .select('id')
      .where((eb) => eb.or([eb('record_id_a', 'in', createdRecordIds), eb('record_id_b', 'in', createdRecordIds)]))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((row) => row.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', createdRecordIds).execute().catch(() => undefined);
  }

  const mine = await db.selectFrom('entity_records').select('id').where('name', 'like', `${RUN}%`).execute().catch(() => [] as { id: string }[]);
  if (mine.length > 0) {
    await db.deleteFrom('entity_records').where('id', 'in', mine.map((row) => row.id)).execute().catch(() => undefined);
  }
  const users = await db.selectFrom('users').select('id').where('user_name', 'like', `${RUN}%`).execute().catch(() => [] as { id: string }[]);
  if (users.length > 0) {
    const ids = users.map((row) => row.id);
    await db.deleteFrom('users_teams').where('user_id', 'in', ids).execute().catch(() => undefined);
    await db.deleteFrom('users_roles').where('user_id', 'in', ids).execute().catch(() => undefined);
    await db.deleteFrom('users').where('id', 'in', ids).execute().catch(() => undefined);
  }
  if (createdRoleIds.length > 0) {
    await db.deleteFrom('roles').where('id', 'in', createdRoleIds).execute().catch(() => undefined);
  }

  await shutdownApi();
});

describe('the worker door (19-LS.6)', () => {
  it('refuses every worker route without the capability, in both directions of the mistake', async () => {
    for (const url of [LEAD_CHANGED_PATH, WORK_RECALCULATE_PATH, WORK_CHUNK_PATH]) {
      const body = { leadId: `${RUN}-door`, revision: 1, changed: ['company'] };
      const missing = await workerCall(url, body, { secret: null });
      expect(missing.status, `${url} ${JSON.stringify(missing.body)}`).toBe(401);
      expect(errorOf(missing).code, url).toBe('AUTHENTICATION_FAILED');
      const wrong = await workerCall(url, body, { secret: 'not-the-capability' });
      expect(wrong.status, url).toBe(401);
      expect(errorOf(wrong).code, url).toBe('AUTHENTICATION_FAILED');

      // The shape is checked only once the capability has been: a probe cannot use an invalid body to learn
      // what a route accepts.
      const malformed = await workerCall(url, {}, { secret: null });
      expect(malformed.status, url).toBe(401);
    }
  });

  it('refuses a malformed hand-off at the shape boundary rather than guessing', async () => {
    const noLead = await workerCall(LEAD_CHANGED_PATH, { revision: 1, changed: ['company'] });
    expect(noLead.status, JSON.stringify(noLead.body)).toBe(400);
    const negative = await workerCall(LEAD_CHANGED_PATH, { leadId: `${RUN}-x`, revision: -1, changed: [] });
    expect(negative.status, JSON.stringify(negative.body)).toBe(400);

    // A rebuild chunk may not ask for more Leads than the service's own ceilings allow, even from a worker:
    // the payload is validated on the way in, not trusted because it came from a job row.
    const oversized = await workerCall(WORK_CHUNK_PATH, {
      runId: `${RUN}-shape`,
      limit: 10_000,
      chunkSize: 10_000,
      processed: 0,
      cursor: null,
      where: [],
    });
    expect(oversized.status, JSON.stringify(oversized.body)).toBe(400);
    expect(JSON.stringify(oversized.body)).toContain('limit');

    // An unknown key is a typo, and a typo in a chunk coordinate is a way to change what a run walks.
    const smuggled = await workerCall(LEAD_CHANGED_PATH, { leadId: `${RUN}-x`, revision: 1, changed: [], extra: true });
    expect(smuggled.status).toBe(400);
  });
});

describe('the Lead-change decision (19-LS.6)', () => {
  it('answers "switched off" and "no active model" as responses, never as errors', async () => {
    await patchSettings({ enabled: false });
    const off = await workerCall(LEAD_CHANGED_PATH, { leadId: `${RUN}-gone-1`, revision: 1, changed: ['company'] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(decisionOf(off).reason).toBe('disabled');
    expect(decisionOf(off).queued).toBe(false);

    await patchSettings({
      enabled: true,
      features: { modelAdministration: true, scoring: true, eventRecalculation: true },
      scoring: { activeModelId: null },
    });
    const noModel = await workerCall(LEAD_CHANGED_PATH, { leadId: `${RUN}-gone-1`, revision: 1, changed: ['company'] });
    expect(noModel.status, JSON.stringify(noModel.body)).toBe(200);
    expect(decisionOf(noModel).reason).toBe('noActiveModel');
    expect(await jobRows({ leadId: `${RUN}-gone-1` })).toEqual([]);

    // The feature named for this path is the door, not the module switch: with the module on and
    // `eventRecalculation` off, the answer is still `disabled` and still a 200.
    await patchSettings({
      enabled: true,
      features: { modelAdministration: true, scoring: true, eventRecalculation: false },
      scoring: { activeModelId: null },
    });
    const featureOff = await workerCall(LEAD_CHANGED_PATH, { leadId: `${RUN}-gone-1`, revision: 1, changed: ['company'] });
    expect(featureOff.status).toBe(200);
    expect(decisionOf(featureOff).reason).toBe('disabled');
  });

  it('queues one debounced job for a change that can move the score, and marks the Lead pending', async () => {
    const model = await createPublishedModel('event');
    await enableScoring(model.id);
    await patchSettings({ scoring: { activeModelId: model.id, debounceSeconds: 120 } });
    const leadId = await createLead('event lead', { company: 'Acme' });

    const before = await readLead(leadId);
    expect(before['scoreStatus']).toBe('not_scored');

    const result = await workerCall(LEAD_CHANGED_PATH, { leadId, revision: Number(before['version']), changed: ['company'] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const decision = decisionOf(result);
    expect(decision.queued).toBe(true);
    expect(decision.reason).toBe('queued');
    expect(decision.modelVersion).toBe(model.version);
    // The wait the administrator configured is the wait the queue is told to honour.
    expect(decision.debounceMs).toBe(120_000);
    expect(decision.jobId).toBe(expectedJobId(leadId, model.version, Number(before['version'])));

    const rows = await jobRows({ leadId });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.target['leadId']).toBe(leadId);
    expect(rows[0]?.target['source']).toBe('event');
    expect(rows[0]?.target['triggers']).toEqual(['company']);
    // A job payload is readable in the admin jobs screen, so it carries field names and never a Lead value.
    expect(JSON.stringify(rows[0]?.target)).not.toContain('Acme');

    const after = await readLead(leadId);
    // Plan §5.3: a reader is told the truth while work is waiting — the status moves, the number does not.
    expect(after['scoreStatus']).toBe('pending');
    expect(after['scoreValue'] ?? null).toBeNull();
  });

  it('collapses a repeated delivery into the one job already waiting', async () => {
    const model = await createPublishedModel('dedupe');
    await enableScoring(model.id);
    const leadId = await createLead('dedupe lead', { company: 'Acme' });

    const first = await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 3, changed: ['company'] });
    expect(decisionOf(first).queued).toBe(true);

    // The same event delivered twice: at-least-once is a property of the platform, not a bug to fix here.
    const again = await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 3, changed: ['company'] });
    expect(decisionOf(again).reason).toBe('alreadyQueued');
    expect(decisionOf(again).jobId).toBe(decisionOf(first).jobId);

    // A newer revision of the same Lead while the first job has not run: still one unit of work for this
    // Lead+version, because the job reads the inputs as they are when it runs, not as they were.
    const newer = await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 4, changed: ['industry'] });
    expect(decisionOf(newer).reason).toBe('alreadyQueued');
    expect(decisionOf(newer).jobId).toBe(decisionOf(first).jobId);

    expect((await jobRows({ leadId })).length).toBe(1);
  });

  it('does not re-trigger itself: the fields a score write changes can never move a score', async () => {
    const model = await createPublishedModel('loop');
    await enableScoring(model.id);
    const leadId = await createLead('loop lead', { company: 'Acme', industry: 'Software' });

    const scored = await call('POST', RECALCULATE_PATH, { leadId });
    expect(scored.status, JSON.stringify(scored.body)).toBe(200);

    const changed = await lastChangedFields(leadId);
    expect(changed.length, 'the score write published the fields it moved').toBeGreaterThan(0);
    for (const field of changed) expect(field.startsWith('score'), field).toBe(true);

    const answer = await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 9, changed });
    expect(decisionOf(answer).queued).toBe(false);
    expect(decisionOf(answer).reason).toBe('inputsUnaffected');
    expect(await jobRows({ leadId })).toEqual([]);

    // The second half of the same guarantee, from the other direction: a change that does reach a rule input
    // is queued, so the assertion above is a fact about the two field lists and not a stub that always says no.
    const real = await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 9, changed: ['company'] });
    expect(decisionOf(real).queued).toBe(true);
    expect((await jobRows({ leadId })).length).toBe(1);
  });

  it('answers a Lead that was deleted after the commit without queueing work for it', async () => {
    const model = await createPublishedModel('deleted');
    await enableScoring(model.id);
    const leadId = await createLead('deleted lead', { company: 'Acme' });

    expect((await call('DELETE', `/api/v1/Lead/${leadId}`)).status).toBeLessThan(300);
    const answer = await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 2, changed: ['company'] });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(decisionOf(answer).reason).toBe('leadGone');
    expect(decisionOf(answer).queued).toBe(false);
    expect(await jobRows({ leadId })).toEqual([]);
  });

  it('marks a Lead pending once, and does not move the row again for work that is already waiting', async () => {
    const model = await createPublishedModel('churn');
    await enableScoring(model.id);
    const leadId = await createLead('churn lead', { company: 'Acme' });

    expect(decisionOf(await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 1, changed: ['company'] })).queued).toBe(true);
    const afterFirst = await readLead(leadId);
    expect(afterFirst['scoreStatus']).toBe('pending');

    // A newer revision of the same Lead: the outstanding job covers it, so nothing is queued, nothing is
    // rewritten and the Lead's own version does not move. A burst of saves must not churn the record the
    // sales user is looking at — that is the whole point of the debounce in front of the same job.
    const second = decisionOf(await workerCall(LEAD_CHANGED_PATH, { leadId, revision: 2, changed: ['industry'] }));
    expect(second.reason).toBe('alreadyQueued');
    expect(second.queued).toBe(false);
    const afterSecond = await readLead(leadId);
    expect(afterSecond['version']).toBe(afterFirst['version']);
    expect(afterSecond['scoreStatus']).toBe('pending');
    expect((await jobRows({ leadId })).length).toBe(1);
  });
});

describe('the queued job runs the same engine as the button (19-LS.6)', () => {
  it('scores under the service authority, records the event trigger, and repeats as a no-op', async () => {
    const model = await createPublishedModel('queued');
    await enableScoring(model.id);
    const leadId = await createLead('queued lead', { company: 'Acme', industry: 'Software' });

    const result = await workerCall(WORK_RECALCULATE_PATH, { leadId });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const evaluation = result.body['evaluation'] as Body;
    expect(evaluation['scoreValue']).toBe(50);
    // Provenance an operator can read: this row was produced by the Lead change, not by a button.
    expect(evaluation['trigger']).toBe('lead_change');
    expect(result.body['recorded']).toBe(true);
    expect(result.body['projectionWritten']).toBe(true);

    const lead = await readLead(leadId);
    expect(lead['scoreValue']).toBe(50);
    // The pending marker LS.6 set is replaced by the truth LS.5 computed, not left waiting forever.
    expect(lead['scoreStatus']).toBe('current');

    const again = await workerCall(WORK_RECALCULATE_PATH, { leadId });
    expect(again.body['recorded']).toBe(false);
    expect(again.body['projectionWritten']).toBe(false);
    expect((await evaluationRows(leadId)).length).toBe(1);

    // A background write is still an attributable write: the row says `system`, which is the documented
    // service authority rather than an invented bypass (AGENTS.md §5.3, plan §9.2).
    // A background write is still an attributable write. The projection itself is deliberately not audited
    // (LS.2 §5.4: a rebuild would otherwise copy every Lead value into `audit_log`), so the trace lives on the
    // evaluation row, where the request id names the job path that produced it.
    const stored = await ctx.database.db
      .selectFrom('entity_records')
      .select([sql`attrs ->> 'correlationId'`.as('correlationId')])
      .where('entity_type', '=', 'LeadScoreEvaluation')
      .where(sql`attrs ->> 'leadId'`, '=', leadId)
      .execute();
    expect(stored[0]?.correlationId).toBe('leadScore:recalculate');
    const audits = await ctx.database.db
      .selectFrom('audit_log')
      .select('id')
      .where('entity_type', '=', 'Lead')
      .where('record_id', '=', leadId)
      .where('action', '=', 'update')
      .execute();
    expect(audits.length).toBe(0);
  });

  it('stops when the event switch is turned off, including for a job that is already queued', async () => {
    const model = await createPublishedModel('kill');
    await enableScoring(model.id);
    const leadId = await createLead('kill lead', { company: 'Acme' });
    expect((await workerCall(WORK_RECALCULATE_PATH, { leadId })).status).toBe(200);

    // Plan §9.3: the switch is the kill switch. An outstanding job must not finish the work after an operator
    // turned the feature off, and the answer is the module's stable refusal code.
    await patchSettings({
      enabled: true,
      features: { modelAdministration: true, scoring: true, manualRecalculation: true, eventRecalculation: false },
      scoring: { activeModelId: model.id },
    });
    const refused = await workerCall(WORK_RECALCULATE_PATH, { leadId });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe('LEADSCORE_MODULE_DISABLED');
    expect(errorOf(refused).details['feature']).toContain('eventRecalculation');

    await patchSettings({ enabled: false });
    expect(errorOf(await workerCall(WORK_RECALCULATE_PATH, { leadId })).code).toBe('LEADSCORE_MODULE_DISABLED');

    // Nothing else moved while the switch was off: the score from the first run is still what it was.
    await enableScoring(model.id);
    expect((await readLead(leadId))['scoreValue']).toBe(30);
  });

  it('answers a Lead that no longer exists with the 404 a job can stop retrying over', async () => {
    const model = await createPublishedModel('vanished');
    await enableScoring(model.id);
    const missing = await workerCall(WORK_RECALCULATE_PATH, { leadId: `${RUN}-no-such-lead` });
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe('RECORD_NOT_FOUND');
  });
});

describe('a rebuild is bounded, chunked and stoppable (19-LS.6)', () => {
  it('queues a chunked run and clamps what a caller tries to raise', async () => {
    const model = await createPublishedModel('batch');
    await enableScoring(model.id);

    // A caller may lower a chunk, never raise it above what one worker→API call may hold — and the answer is
    // a refusal, not a silent clamp: an operator who asked for 5000 per row should learn the ceiling.
    const tooWide = await call('POST', BATCH_PATH, { limit: 500, chunkSize: 5_000 });
    expect(tooWide.status, JSON.stringify(tooWide.body)).toBe(400);
    expect(JSON.stringify(tooWide.body)).toContain('chunkSize');

    const started = await call('POST', BATCH_PATH, { limit: 500, chunkSize: 20 });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const body = started.body as { job: { id: string }; runId: string; limit: number; chunkSize: number };
    createdRunIds.push(body.runId);
    expect(body.job.id).toMatch(/^[0-9a-f-]{16,64}$/);
    expect(body.limit).toBe(500);
    expect(body.chunkSize).toBe(20);

    const rows = await jobRows({ runId: body.runId });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.target['cursor']).toBeNull();
    expect(rows[0]?.target['processed']).toBe(0);
    expect(rows[0]?.target['source']).toBe('manual_batch');
    // Who asked is recorded, because a rebuild reads every Lead under the service authority.
    expect(typeof rows[0]?.target['requestedBy']).toBe('string');
    expect(String(rows[0]?.target['requestedBy'])).not.toBe('');

    const overTotal = await call('POST', BATCH_PATH, { limit: 100_000 });
    expect(overTotal.status, JSON.stringify(overTotal.body)).toBe(400);

    // No run was queued for the refused request.
    expect((await jobRows({ runId: body.runId })).length).toBe(1);
  });

  it('refuses a rebuild when no published model is active, rather than queueing an empty run', async () => {
    await enableScoring(null);
    const before = await ctx.database.db.selectFrom('jobs').select('id').where('job', '=', BATCH_JOB).execute();
    const result = await call('POST', BATCH_PATH, {});
    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(errorOf(result).code).toBe('VALIDATION_FAILED');
    expect(errorOf(result).details['state']).toBe('noActiveModel');

    // Nothing was queued for a run that could not have scored anything.
    const after = await ctx.database.db.selectFrom('jobs').select('id').where('job', '=', BATCH_JOB).execute();
    expect(after.length).toBe(before.length);
  });

  it('walks the Lead set in chunks, hands the cursor on, and finishes without a successor', async () => {
    const model = await createPublishedModel('walk');
    await enableScoring(model.id);
    const first = await createLead('walk 1', { company: 'Acme' });
    const second = await createLead('walk 2', { company: 'Beta' });
    const third = await createLead('walk 3', {});

    // `${RUN} walk` and not bare `RUN`: the filter is the caller's scope, and this suite has other Leads in
    // the database whose names carry the run marker from earlier tests.
    const where = [{ field: 'name', operator: 'contains', value: `${RUN} walk` }];
    const chunkOne = await workerCall(WORK_CHUNK_PATH, { runId: `${RUN}-walk`, limit: 3, chunkSize: 2, processed: 0, cursor: null, where });
    expect(chunkOne.status, JSON.stringify(chunkOne.body)).toBe(200);
    const view = chunkOne.body as unknown as ChunkView;
    createdRunIds.push(`${RUN}-walk`);
    expect(view.runId).toBe(`${RUN}-walk`);
    expect(view.processed).toBe(2);
    expect(view.done).toBe(false);
    expect(view.cancelled).toBe(false);
    expect(view.cursor).not.toBeNull();
    expect(view.nextJobId).not.toBeNull();
    expect(view.scored + view.unchanged).toBe(2);

    const chunkTwo = await workerCall(WORK_CHUNK_PATH, {
      runId: `${RUN}-walk`,
      limit: 3,
      chunkSize: 2,
      processed: view.processedTotal,
      cursor: view.cursor,
      where,
    });
    const tail = chunkTwo.body as unknown as ChunkView;
    expect(tail.done).toBe(true);
    expect(tail.nextJobId).toBeNull();
    expect(tail.processedTotal).toBe(3);
    expect(tail.remaining).toBe(0);

    // The three Leads are the three this run named, and each carries the number the engine gives it.
    expect((await readLead(first))['scoreValue']).toBe(30);
    expect((await readLead(second))['scoreValue']).toBe(30);
    const blank = await readLead(third);
    expect(blank['scoreValue']).toBe(20);
    expect(blank['scoreStatus']).toBe('current');

    // Re-running the run from the start is harmless: LS.5's input watermark means nothing new is recorded.
    const rerun = await workerCall(WORK_CHUNK_PATH, { runId: `${RUN}-walk`, limit: 3, chunkSize: 2, processed: 0, cursor: null, where });
    const again = rerun.body as unknown as ChunkView;
    expect(again.scored).toBe(0);
    expect(again.unchanged).toBe(2);
    expect((await evaluationRows(first)).length).toBe(1);
  });

  it('stops the chain when the run is cancelled instead of forking a successor', async () => {
    const model = await createPublishedModel('cancel');
    await enableScoring(model.id);
    for (const index of [1, 2, 3, 4]) await createLead(`cancel lead ${String(index)}`, { company: `Acme ${String(index)}` });

    const started = await call('POST', BATCH_PATH, {
      limit: 4,
      chunkSize: 2,
      where: [{ field: 'name', operator: 'contains', value: `${RUN} cancel lead` }],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const runId = String((started.body as Body)['runId']);
    const firstJobId = String((started.body as { job: { id: string } }).job.id);
    createdRunIds.push(runId);
    // Exactly what `/admin/jobs` does to a run an operator has had enough of.
    await ctx.database.db.updateTable('jobs').set({ cancel_requested: true }).where('id', '=', firstJobId).execute();

    const chunk = await workerCall(WORK_CHUNK_PATH, {
      runId,
      limit: 4,
      chunkSize: 2,
      processed: 0,
      cursor: null,
      where: [{ field: 'name', operator: 'contains', value: `${RUN} cancel lead` }],
    });
    expect(chunk.status, JSON.stringify(chunk.body)).toBe(200);
    const view = chunk.body as unknown as ChunkView;
    expect(view.cancelled).toBe(true);
    expect(view.done).toBe(true);
    expect(view.nextJobId).toBeNull();
    expect(view.processed).toBe(0);

    // And the run has no second row waiting: the chain ends where the cancel landed.
    expect((await jobRows({ runId })).length).toBe(1);

    // A cancelled *terminal* row is also a stop, not a resurrection: the same run re-checked after the fact
    // still creates no successor.
    await ctx.database.db.updateTable('jobs').set({ status: 'cancelled' }).where('id', '=', firstJobId).execute();
    const afterTerminal = await workerCall(WORK_CHUNK_PATH, {
      runId,
      limit: 4,
      chunkSize: 2,
      processed: 0,
      cursor: null,
      where: [{ field: 'name', operator: 'contains', value: `${RUN} cancel lead` }],
    });
    expect((afterTerminal.body as unknown as ChunkView).cancelled).toBe(true);
    expect((await jobRows({ runId })).length).toBe(1);
  });

  it('counts a Lead that fails, names the code, and lets the run continue', async () => {
    const published = await createPublishedModel('failing');
    await enableScoring(published.id);
    const leadIds = [await createLead('failing 1', { company: 'Acme' }), await createLead('failing 2', { company: 'Beta' })];

    // A model switched to an unpublished draft between the request and the chunk is the real version of this
    // failure: an operator (or a kill switch) moved the configuration under a run that was already walking.
    const draft = await createRecord(MODEL, {
      name: `${RUN} draft`,
      description: 'A draft cannot score anybody.',
      modelVersion: 1,
      scaleMin: 0,
      scaleMax: 100,
      baseScore: 0,
      scoreFloor: 0,
      scoreCeiling: 100,
      qualificationBands: JSON.stringify([{ band: 'Unknown', min: 0, max: 100 }]),
      allowedFieldPaths: JSON.stringify(['company']),
    });
    await patchSettings({ scoring: { activeModelId: draft } });

    const chunk = await workerCall(WORK_CHUNK_PATH, {
      runId: `${RUN}-failing`,
      limit: 2,
      chunkSize: 2,
      processed: 0,
      cursor: null,
      where: [{ field: 'id', operator: 'in', value: leadIds }],
    });
    expect(chunk.status, JSON.stringify(chunk.body)).toBe(200);
    const view = chunk.body as unknown as ChunkView;
    expect(view.processed).toBe(2);
    expect(view.scored).toBe(0);
    expect(view.failed).toBe(2);
    // The code is stable and safe to read; the message, the field list and the model id are not in it.
    expect(view.errorCodes).toEqual(['LEADSCORE_NO_ACTIVE_MODEL']);
    expect(JSON.stringify(view)).not.toContain(draft);
    expect(view.done).toBe(true);
    expect(view.nextJobId).toBeNull();

    // One Lead failing does not lose the others: restore the model and the same chunk now scores both.
    await patchSettings({ scoring: { activeModelId: published.id } });
    const healed = await workerCall(WORK_CHUNK_PATH, {
      runId: `${RUN}-failing`,
      limit: 2,
      chunkSize: 2,
      processed: 0,
      cursor: null,
      where: [{ field: 'id', operator: 'in', value: leadIds }],
    });
    const after = healed.body as unknown as ChunkView;
    expect(after.failed).toBe(0);
    expect(after.scored).toBe(2);
  });

  it('keeps a rebuild behind its own right and its own switch', async () => {
    const model = await createPublishedModel('rights');
    await enableScoring(model.id);

    const roleId = `${RUN}_role_viewonly`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} view only`, permissions: { Lead: { read: 'yes', edit: 'yes' }, LeadScore: { read: 'yes' } } });
    createdRoleIds.push(roleId);
    const viewer = await createTestUser(ctx, { userName: `${RUN}_viewer`, roleIds: [roleId] });
    createdUserNames.push(viewer.userName);

    const denied = await call('POST', BATCH_PATH, {}, viewer.token);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(errorOf(denied).code).toBe('AUTHORIZATION_DENIED');
    // The denial names the capability the caller lacks, never which roles hold it.
    expect(errorOf(denied).details['capability']).toBe('batchRecalculate');

    // The right exists and the switch does not: the gate answers with the switch, not with a phase.
    await patchSettings({
      enabled: true,
      features: { modelAdministration: true, scoring: true, batchRecalculation: false },
      scoring: { activeModelId: model.id },
    });
    const off = await call('POST', BATCH_PATH, {});
    expect(off.status).toBe(403);
    expect(errorOf(off).code).toBe('LEADSCORE_MODULE_DISABLED');
    expect(errorOf(off).details['feature']).toContain('batchRecalculation');
  });
});

describe('the surface LS.6 added is a documented one', () => {
  it('publishes the rebuild command and reports both background features as delivered', async () => {
    const openapi = await call('GET', '/api/v1/OpenApi');
    const paths = (openapi.body as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(Object.keys(paths['/api/v1/LeadScore/action/recalculate-batch'] ?? {})).toContain('post');

    const health = await call('GET', '/api/v1/LeadScore/action/health');
    const body = health.body as unknown as {
      module: { implementedPhases: string[] };
      features: { key: string; implemented: boolean; pendingPhase: string | null }[];
      operations: { operation: string; pendingPhase: string | null }[];
    };
    expect(body.module.implementedPhases).toContain('19-LS.6');
    for (const key of ['eventRecalculation', 'batchRecalculation']) {
      const feature = body.features.find((entry) => entry.key === key);
      expect(feature?.implemented, key).toBe(true);
      expect(feature?.pendingPhase, key).toBeNull();
    }
    expect(body.operations.find((entry) => entry.operation === 'eventRecalculate')?.pendingPhase).toBeNull();
    expect(body.operations.find((entry) => entry.operation === 'batchRecalculate')?.pendingPhase).toBeNull();
  });

  it('reports the debounce in the settings document so an operator can see the wait', async () => {
    await enableScoring(null);
    const saved = await patchSettings({ scoring: { debounceSeconds: 45 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const view = saved.body as { settings: { scoring: { debounceSeconds: number } }; defaults: { scoring: { debounceSeconds: number } } };
    expect(view.settings.scoring.debounceSeconds).toBe(45);
    expect(view.defaults.scoring.debounceSeconds).toBe(60);

    // A window long enough to be a queue joke is refused rather than stored.
    const tooLong = await patchSettings({ scoring: { debounceSeconds: 901 } });
    expect(tooLong.status, JSON.stringify(tooLong.body)).toBe(422);
  });
});
