import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_LEADSCORE_SETTINGS,
  eventTypesFor,
  LEADSCORE_EVENT_TYPES,
  MAX_SIGNAL_PLANS_PER_MODEL,
  planKeyOf,
  signalPlans,
  THRESHOLD_AUDIT_ACTION,
} from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.9 — engagement signals, threshold actions and the decay sweep
 * (`PLAN_Phase_19_LeadScore.md` §6.3, §6.4, §6.6, §10.1–§10.4, §16 `19-LS.9`; audit §7.1, gap G6, §11).
 *
 * The acceptance is two clauses, and each is driven here through the real routes against the configured
 * primary database (AGENTS.md §3.1 — no test database, no reset):
 *
 * 1. **an optional signal source failure does not break scoring.** With `engagementSignals` off, and with the
 *    source present but this Lead having no events, the same model still produces the same score from the
 *    rules that *can* answer — the engagement rule skips rather than inventing a zero, and skips out of
 *    coverage rather than into it.
 * 2. **threshold actions are auditable.** A band crossing leaves an outbox row per event, one notification for
 *    the Lead's owner and one audit row naming the crossing — and a second delivery of the same evaluation
 *    leaves a second of *none* of them, because the ids are derived from the crossing rather than generated.
 *
 * The decay sweep is asserted as a decision (run / switched off / nothing time-dependent), the engagement
 * plans as a bounded contract, and the worker route behind the shared secret.
 *
 * `afterAll` removes only what this run created — its `marketing_events` rows, notification, audit rows,
 * outbox rows, job rows, Leads, model, rules and evaluations — by exact id, and puts the `leadScore` settings
 * row back as it found it.
 */

const RUN = `AGENT_TEST_LS9_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODEL = 'LeadScoreModel';
const RULE = 'LeadScoreRule';
const RECALCULATE_PATH = '/api/v1/LeadScore/action/score/recalculate';
const PREVIEW_PATH = '/api/v1/LeadScore/action/model/preview';
const SWEEP_PATH = '/api/v1/LeadScore/action/work/decay-sweep';

const previousWorkerSecret = process.env.REPORT_WORKER_SECRET;
const WORKER_SECRET = `${RUN}_capability`;
process.env.REPORT_WORKER_SECRET = WORKER_SECRET;

let ctx: ApiContext;
let previousSettings: string | null = null;
let adminUserId = '';
const created: { records: string[]; events: string[]; notifications: string[]; audits: string[]; outbox: string[]; jobs: string[] } = {
  records: [],
  events: [],
  notifications: [],
  audits: [],
  outbox: [],
  jobs: [],
};

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<CallResult> {
  const res = await ctx.app.inject({ method, url, headers: { ...authHeader(ctx.adminToken), ...headers }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  created.records.push(id);
  return id;
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function publish(modelId: string): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/model/publish', { modelId });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

/** A model whose two rules are one Lead field and one engagement signal. */
async function createEngagementModel(name: string, decayPolicy = 'none'): Promise<string> {
  const modelId = await createRecord(MODEL, {
    name: `${RUN} ${name}`,
    modelVersion: 1,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 10,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: JSON.stringify([
      { band: 'Cold', min: 0, max: 39 },
      { band: 'Warm', min: 40, max: 69 },
      { band: 'Hot', min: 70, max: 89 },
      { band: 'Sales Ready', min: 90, max: 100 },
    ]),
    // The grant names the Lead field only: an engagement metric is not a Lead path and is not granted as one.
    allowedFieldPaths: JSON.stringify(['company']),
  });
  await createRecord(RULE, {
    name: `${RUN} company`,
    modelId,
    modelVersion: 1,
    reasonCode: `ls9_company_${modelId.slice(-6)}`,
    dimension: 'completeness',
    enabled: true,
    condition: JSON.stringify({ field: 'company', operator: 'isNotEmpty' }),
    effect: 'add',
    points: 20,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  await createRecord(RULE, {
    name: `${RUN} opened twice`,
    modelId,
    modelVersion: 1,
    reasonCode: `ls9_opened_${modelId.slice(-6)}`,
    dimension: 'engagement',
    enabled: true,
    condition: JSON.stringify({ field: 'eventCount', operator: 'gte', value: 2 }),
    effect: 'add',
    points: 40,
    priority: 20,
    missingDataPolicy: 'neutral',
    signalSource: 'marketingEvents',
    eventType: 'opened',
    lookbackDays: 30,
    decayPolicy,
    ...(decayPolicy === 'halfLife' ? { decayHalfLifeDays: 7 } : {}),
  });
  return modelId;
}

async function insertEvents(leadId: string, at: readonly string[]): Promise<void> {
  for (const occurredAt of at) {
    const id = `${RUN}_evt_${String(created.events.length)}`;
    // `marketing_events` is Marketing Automation's own table and not a metadata entity, so it has no Kysely
    // typing — the module itself writes it with `sql`, and a test that invents a row does the same.
    await sql`
      insert into marketing_events
        (id, provider, event_type, normalized_type, occurred_at, recipient_entity_type, recipient_entity_id, properties)
      values
        (${id}, 'agent_test', 'open', 'opened', ${new Date(occurredAt)}, 'Lead', ${leadId}, ${JSON.stringify({})}::jsonb)
    `.execute(ctx.database.db);
    created.events.push(id);
  }
}

async function score(leadId: string): Promise<CallResult> {
  return call('POST', RECALCULATE_PATH, { leadId });
}

async function outboxRows(type: string): Promise<Body[]> {
  const rows = await ctx.database.db.selectFrom('outbox_events').select(['id', 'event_type', 'payload']).where('event_type', '=', type).where('created_at', '>=', new Date(STARTED_AT)).execute();
  rows.forEach((row) => created.outbox.push(row.id));
  return rows.map((row) => ({ id: row.id, payload: row.payload as Body }));
}

async function notificationsFor(leadId: string): Promise<{ id: string; user_id: string; data: Body }[]> {
  const rows = await ctx.database.db
    .selectFrom('notifications')
    .select(['id', 'user_id', 'data'])
    .where(sql`(data->>'leadId')`, '=', leadId)
    .execute();
  rows.forEach((row) => {
    if (!created.notifications.includes(row.id)) created.notifications.push(row.id);
  });
  return rows.map((row) => ({ id: row.id, user_id: row.user_id, data: row.data as Body }));
}

async function auditRows(leadId: string): Promise<{ id: string; action: string; data: Body }[]> {
  const rows = await ctx.database.db.selectFrom('audit_log').select(['id', 'action', 'data']).where('record_id', '=', leadId).where('action', '=', THRESHOLD_AUDIT_ACTION).execute();
  rows.forEach((row) => {
    if (!created.audits.includes(row.id)) created.audits.push(row.id);
  });
  return rows.map((row) => ({ id: row.id, action: row.action, data: row.data as Body }));
}

const STARTED_AT = Date.now() - 1_000;
let modelId = '';
let leadId = '';

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const admin = await ctx.database.db.selectFrom('users').select(['id']).where('is_admin', '=', true).where('is_deleted', '=', false).limit(1).executeTakeFirst();
  adminUserId = admin?.id ?? '';

  const switches = Object.fromEntries(Object.keys(DEFAULT_LEADSCORE_SETTINGS.features).map((key) => [key, false]));
  await setSettings({
    enabled: true,
    features: { ...switches, modelAdministration: true, scoringPreview: true, scoring: true, manualRecalculation: true, engagementSignals: true, thresholdNotifications: true },
    scoring: { activeModelId: null },
  });

  modelId = await createEngagementModel('model');
  await publish(modelId);
  await setSettings({ scoring: { activeModelId: modelId } });

  leadId = await createRecord('Lead', { name: `${RUN} lead`, lastName: `${RUN} lead`, company: 'Signalworks', status: 'New' });
  // The notification goes to the Lead's owner, so the record has one.
  await call('PATCH', `/api/v1/Lead/${leadId}`, { assignedUserId: adminUserId });
  await insertEvents(leadId, [new Date(Date.now() - 2 * 86_400_000).toISOString(), new Date(Date.now() - 3 * 86_400_000).toISOString()]);
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() }).where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  }
  if (previousWorkerSecret === undefined) delete process.env.REPORT_WORKER_SECRET;
  else process.env.REPORT_WORKER_SECRET = previousWorkerSecret;

  if (created.events.length > 0) {
    await sql`delete from marketing_events where id in (${sql.join(created.events.map((id) => sql`${id}`))})`.execute(db).catch(() => undefined);
  }
  if (created.notifications.length > 0) await db.deleteFrom('notifications').where('id', 'in', created.notifications).execute().catch(() => undefined);
  if (created.audits.length > 0) await db.deleteFrom('audit_log').where('id', 'in', created.audits).execute().catch(() => undefined);
  if (created.outbox.length > 0) await db.deleteFrom('outbox_events').where('id', 'in', created.outbox).execute().catch(() => undefined);
  if (created.jobs.length > 0) await db.deleteFrom('jobs').where('id', 'in', created.jobs).execute().catch(() => undefined);

  if (created.records.length > 0) {
    // Evaluations are named by the score, not by the run marker, so they go by their own Lead.
    const evals = await db.selectFrom('entity_records').select('id').where('entity_type', '=', 'LeadScoreEvaluation').where(sql`(attrs->>'leadId')`, 'in', created.records).execute().catch(() => [] as { id: string }[]);
    const ids = [...new Set([...created.records, ...evals.map((row) => row.id)])];
    const linked = await db
      .selectFrom('entity_links')
      .select('id')
      .where((eb) => eb.or([eb('record_id_a', 'in', ids), eb('record_id_b', 'in', ids)]))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((row) => row.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
  }

  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score engagement suite left records behind');
  if (created.records.length > 0) {
    const strayEvents = await sql<{ id: string }>`
      select id from marketing_events where recipient_entity_id in (${sql.join(created.records.map((id) => sql`${id}`))})
    `.execute(db).catch(() => ({ rows: [] as { id: string }[] }));
    if (strayEvents.rows.length > 0) console.warn({ stray: strayEvents.rows.length, run: RUN }, 'lead-score engagement suite left marketing events behind');
  }

  await shutdownApi();
}, 240_000);

describe('the engagement plans are a bounded contract (plan §6.3, §9.4)', () => {
  it('derives one plan per distinct question, with a clamped window and no delivery counted as engagement', () => {
    const plans = signalPlans([
      { enabled: true, signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 30 },
      { enabled: true, signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 30 },
      { enabled: true, signalSource: 'marketingEvents', eventType: 'clicked', lookbackDays: 90 },
      { enabled: true, signalSource: 'emailLinks', eventType: 'opened', lookbackDays: 5_000 },
      { enabled: false, signalSource: 'marketingEvents', eventType: 'opened', lookbackDays: 30 },
      { enabled: true, signalSource: 'lead', eventType: undefined, lookbackDays: undefined },
    ]);
    // Two identical rules read the table once; a disabled rule asks nothing; a `lead` rule is not a plan.
    expect(plans.map((plan) => plan.key)).toEqual(['emailLinks|clicked|365', 'marketingEvents|clicked|90', 'marketingEvents|opened|30']);
    // The absurd window is clamped to the ceiling rather than becoming an unbounded scan.
    expect(plans[0]?.lookbackDays).toBe(365);
    // The default set is "any real engagement", and a delivery is not engagement.
    expect(eventTypesFor('marketingEvents', undefined)).not.toContain('delivered');
    expect(eventTypesFor('marketingEvents', 'ping')).toEqual([]);
    expect(eventTypesFor('emailLinks', undefined)).toEqual(['clicked']);
    expect(planKeyOf('marketingEvents', ['opened', 'clicked'], 30)).toBe('marketingEvents|clicked,opened|30');

    const many = Array.from({ length: MAX_SIGNAL_PLANS_PER_MODEL + 10 }, (_, index) => ({ enabled: true, signalSource: 'marketingEvents', eventType: `type_${String(index)}`, lookbackDays: 10 }));
    expect(signalPlans(many).length).toBeLessThanOrEqual(MAX_SIGNAL_PLANS_PER_MODEL);
  });
});

describe('an optional source that cannot answer leaves the score standing (exit criterion 1)', () => {
  it('scores the Lead-field rules and skips the engagement rule when the switch is off', async () => {
    const off = await call('POST', PREVIEW_PATH, { modelId, leadIds: [leadId] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await setSettings({ features: { engagementSignals: false } });
    const disabled = await call('POST', PREVIEW_PATH, { modelId, leadIds: [leadId] });
    expect(disabled.status).toBe(200);
    await setSettings({ features: { engagementSignals: true } });

    const withSignals = view(off);
    const without = view(disabled);
    expect(withSignals.engagementOutcome).toBe('matched');
    expect(without.engagementOutcome).toBe('skipped');
    // The skip is the *reason*, not a zero: the completeness rule still carries its 20 and the base still 10.
    expect(without.score).toBe(30);
    expect(withSignals.score).toBe(70);
    // The reason rides on the rule's own entry, not on the evaluation's error list: a skip is an outcome, and
    // `errorCodes` is for the rules that could not be evaluated at all.
    expect(without.engagementCode).toBe('LS_EVALUATION_SIGNAL_SOURCE_UNAVAILABLE');
    expect(without.signalsState).not.toBe('available');
    expect(withSignals.signalsState).toBe('available');
  });

  it('answers a definite zero for a Lead with no events, and no answer for a metric with nothing behind it', async () => {
    const quiet = await createRecord('Lead', { name: `${RUN} quiet`, lastName: `${RUN} quiet`, company: 'No Events Ltd', status: 'New' });
    const result = await call('POST', PREVIEW_PATH, { modelId, leadIds: [quiet] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const row = view(result);
    // `eventCount gte 2` over an empty window is a *no*, not an unknown: the Lead genuinely has no opens.
    expect(row.engagementOutcome).toBe('not_matched');
    expect(row.score).toBe(30);
    expect(row.signalsState).toBe('no_events');
  });
});

describe('a band crossing is announced once and is auditable (exit criterion 2)', () => {
  it('publishes the events, notifies the owner once, and repeats as a no-op', async () => {
    const first = await score(leadId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const write = first.body as Body;
    expect((write.evaluation as Body)['band']).toBe('Hot');
    expect((write.threshold as Body)['bandChanged']).toBe(true);
    expect((write.threshold as Body)['notificationId']).toBeTruthy();

    const updated = await outboxRows(LEADSCORE_EVENT_TYPES.updated);
    const changed = await outboxRows(LEADSCORE_EVENT_TYPES.bandChanged);
    const payload = (updated.find((row) => (row.payload as Body)['leadId'] === leadId)?.payload ?? {}) as Body;
    expect(payload['schemaVersion']).toBe(1);
    expect(payload['previousBand']).toBe('Unknown');
    expect(payload['band']).toBe('Hot');
    expect(payload['modelVersion']).toBe(1);
    expect(String(payload['correlationId'] ?? '') === '').toBe(false);
    // Plan §10.3: ids and the verdict, never the record.
    expect(JSON.stringify(payload)).not.toContain('Signalworks');
    expect(changed.some((row) => (row.payload as Body)['leadId'] === leadId)).toBe(true);

    const notices = await notificationsFor(leadId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.user_id).toBe(adminUserId);
    expect((notices[0]?.data as Body)['dedupKey']).toContain(`${leadId}:Unknown->Hot`);

    const audits = await auditRows(leadId);
    expect(audits).toHaveLength(1);
    const detail = ((audits[0]?.data as Body)['thresholdAction'] ?? {}) as Body;
    expect(detail['toBand']).toBe('Hot');
    expect(detail['notificationId']).toBe(notices[0]?.id);
    expect(Array.isArray(detail['events'])).toBe(true);

    // The same evaluation delivered again: no second history row, no second event, no second interruption.
    const second = await score(leadId);
    expect((second.body as Body)['recorded']).toBe(false);
    expect((second.body as Body)['projectionWritten']).toBe(false);
    expect((second.body as Body)['threshold']).toBeUndefined();
    expect(await notificationsFor(leadId)).toHaveLength(1);
    expect(await auditRows(leadId)).toHaveLength(1);
    expect((await outboxRows(LEADSCORE_EVENT_TYPES.bandChanged)).filter((row) => (row.payload as Body)['leadId'] === leadId)).toHaveLength(1);
  });

  it('reads the signal provenance back out of the stored evaluation', async () => {
    // The browser pass found this missing: the card prints what the *row* carries, so a state or a window that
    // only ever lived in the write response would disappear the moment anybody re-read the score.
    const read = await call('GET', `/api/v1/LeadScore/action/score/${leadId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const explanation = (read.body['explanation'] ?? {}) as Body;
    expect(explanation['signalState']).toBe('available');
    const entry = ((explanation['breakdown'] as Body[]) ?? []).find((row) => String(row['reasonCode']).startsWith('ls9_opened')) ?? {};
    const signal = (entry['signal'] ?? {}) as Body;
    expect(signal['source']).toBe('marketingEvents');
    expect(signal['windowDays']).toBe(30);
    expect(signal['metric']).toBe('eventCount');
    expect(typeof signal['value']).toBe('number');
  });

  it('stays quiet when the notification switch is off, and still publishes the event', async () => {
    await setSettings({ features: { thresholdNotifications: false } });
    const other = await createRecord('Lead', { name: `${RUN} second`, lastName: `${RUN} second`, company: 'Quiet Corp', status: 'New' });
    await call('PATCH', `/api/v1/Lead/${other}`, { assignedUserId: adminUserId });
    await insertEvents(other, [new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 2 * 86_400_000).toISOString()]);

    const result = await score(other);
    const threshold = (result.body as Body)['threshold'] as Body;
    expect(threshold['bandChanged']).toBe(true);
    expect(threshold['suppressed']).toBe('disabled');
    expect(threshold['notificationId']).toBeNull();
    expect(await notificationsFor(other)).toHaveLength(0);
    expect((await outboxRows(LEADSCORE_EVENT_TYPES.updated)).some((row) => (row.payload as Body)['leadId'] === other)).toBe(true);
    await setSettings({ features: { thresholdNotifications: true } });
  });

  it('does not claim a crossing for the first score a Lead ever had… unless a band moved', async () => {
    // The first write above *did* move a band, from nothing-but-Unknown to Hot; a second model change that
    // lands on the same band must publish `updated` and stay silent about `bandChanged`.
    await call('PATCH', `/api/v1/Lead/${leadId}`, { title: `${RUN} reclassified` });
    const result = await score(leadId);
    const write = result.body as Body;
    const threshold = (write['threshold'] ?? {}) as Body;
    expect(threshold['bandChanged'] ?? false).toBe(false);
    expect(threshold['suppressed'] ?? 'not_band_change').toBe('not_band_change');
    expect(await notificationsFor(leadId)).toHaveLength(1);
  });
});

describe('the decay sweep decides, it does not assume (plan §6.4, §10.2)', () => {
  it('refuses a caller without the worker capability', async () => {
    // A wrong capability and a missing one answer identically, and neither says which half was wrong: the
    // worker secret is one shared value and an oracle for guessing it must not be a status code.
    expect((await call('POST', SWEEP_PATH, {}, { 'x-worker-secret': 'wrong' })).status).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: SWEEP_PATH, payload: {} })).statusCode).toBe(401);
  });

  it('answers that it is switched off, that nothing decays, and then queues a bounded rebuild', async () => {
    const workerHeaders = { 'x-worker-secret': WORKER_SECRET };
    const off = await call('POST', SWEEP_PATH, {}, workerHeaders);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body['started']).toBe(false);
    expect(off.body['skipped']).toBe('disabled');

    const switches = Object.fromEntries(Object.keys(DEFAULT_LEADSCORE_SETTINGS.features).map((key) => [key, false]));
    await setSettings({
      features: { ...switches, modelAdministration: true, scoring: true, engagementSignals: true, batchRecalculation: true },
      signals: { decaySweep: { enabled: true, limit: 5, chunkSize: 2 } },
    });
    const nothing = await call('POST', SWEEP_PATH, {}, workerHeaders);
    expect(nothing.status).toBe(200);
    // The active model's engagement rule has no decay policy, so a sweep would rewrite nothing.
    expect(nothing.body['skipped']).toBe('noDecayingRules');

    const decaying = await createEngagementModel('decaying', 'halfLife');
    await publish(decaying);
    await setSettings({ scoring: { activeModelId: decaying } });
    const started = await call('POST', SWEEP_PATH, {}, workerHeaders);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body['started']).toBe(true);
    expect(started.body['limit']).toBe(5);
    expect(started.body['chunkSize']).toBe(2);
    const job = started.body['job'] as Body;
    expect(String(job['id'] ?? '')).not.toBe('');
    created.jobs.push(String(job['id']));
    // The sweep is a rebuild with a source, so the run it starts is the one the LS.6 chunk path already runs.
    const row = await ctx.database.db.selectFrom('jobs').select(['job', 'status', 'target']).where('id', '=', String(job['id'])).executeTakeFirst();
    expect(row?.job).toBe('leadScore.batchRecalculate');
    expect((row?.target as Body)['source']).toBe('decay_sweep');
    // Cancel it here: no worker is running in this suite, and a queued rebuild must not outlive the test.
    await ctx.database.db.deleteFrom('jobs').where('id', '=', String(job['id'])).execute().catch(() => undefined);
    created.jobs = created.jobs.filter((id) => id !== String(job['id']));
  });
});

function view(result: CallResult): {
  score: number | null;
  engagementOutcome: string;
  engagementCode: string;
  signalsState: string;
  codes: string[];
} {
  const body = result.body as Body;
  const results = (body['results'] ?? []) as Body[];
  const evaluation = results[0] ?? {};
  const entries = (evaluation['ruleEvaluations'] ?? []) as Body[];
  const engagement = entries.find((entry) => String(entry['reasonCode']).startsWith('ls9_opened'));
  return {
    score: (evaluation['scoreValue'] as number | null | undefined) ?? null,
    engagementOutcome: String(engagement?.['outcome'] ?? 'missing'),
    engagementCode: String(engagement?.['code'] ?? ''),
    signalsState: String(((body['signals'] as Body | undefined)?.['state'] as string | undefined) ?? 'missing'),
    codes: (evaluation['errorCodes'] as string[] | undefined) ?? [],
  };
}
