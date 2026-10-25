import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { I18nService } from '../src/i18n/i18n.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.5 — "users can explain the score and know whether it is current"
 * (`PLAN_Phase_19_LeadScore.md` §3.1, §5.4, §6.5, §8.2, §9.1–§9.2, §16 `19-LS.5`; report
 * `docs/implementation/lead-score-ls5-completion-report.md`).
 *
 * The write path is proved in `lead-score-calculation.test.ts`. This suite is the read half, and it is
 * where the phase's acceptance is actually checked: a number nobody can explain is the thing plan §1.2 puts
 * first ("explainability over mystery"), and a number nobody can date is worse than no number.
 *
 * Three properties get assertions here that an implementation could easily miss:
 *
 * - **the breakdown names rules, never values** — a reader with `viewScore` must not be able to read
 *   `industry` off an explanation endpoint they are allowed to call, so the reason text carries the rule's
 *   own name and outcome and the stored comparison, not the Lead's data (§6.5, §9.2);
 * - **freshness is derived, not echoed** — `scoreStatus: 'current'` written by a calculation says nothing
 *   about the record an hour later, so the read compares the stored input watermark and the active model
 *   against the Lead as it is now, and names which of the four things moved (§5.3–§5.4);
 * - **history has no second door** — `LeadScoreEvaluation` is `read: 'no'` for the generic entity API, so
 *   the paged command must work for someone the entity read refuses, and the record-level check on its Lead
 *   must be what gates it (§5.4, §8.2).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). `afterAll` restores the `leadScore` row from
 * the raw column and removes this run's Leads, model, rules and evaluations by exact id.
 */

const RUN = `AGENT_TEST_LS5R_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODEL = 'LeadScoreModel';
const RULE = 'LeadScoreRule';

let ctx: ApiContext;
let previousSettings: string | null = null;
/** The administrator's own locale preference, which decides every label this suite asserts (plan §41.6). */
let previousLocale: string | null = null;
const createdRecordIds: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface ScoreView {
  leadId: string;
  scored: boolean;
  score: {
    value: number | null;
    band: string;
    previousValue: number | null;
    coverage: number | null;
    reasonCodes: string[];
    modelId: string | null;
    modelVersion: number | null;
    calculatedAt: string | null;
    inputsAsOf: string | null;
    signature: string | null;
    evaluationId: string | null;
  };
  freshness: {
    status: string;
    label: string;
    reasons: string[];
    reasonLabels: string[];
    currentRevision: number;
    scoredRevision: number | null;
    activeModelId: string | null;
  };
  explanation: {
    reasonCodes: { positive: string[]; negative: string[]; unknown: string[]; skipped: string[] };
    breakdown: { reasonCode: string; ruleName: string; dimension: string; dimensionLabel: string; outcome: string; outcomeLabel: string; points: number }[];
    errorCodes: string[];
  };
  /** 19-LS.7 — what this caller may do about the score, answered by the gate (plan §9.1). */
  actions: {
    recalculate: { allowed: boolean; reason: string | null };
    history: { allowed: boolean; reason: string | null };
    /** 19-LS.17 — whether this caller may spend one AI run to explain the score. */
    insight: { allowed: boolean; reason: string | null };
  };
}

interface HistoryView {
  leadId: string;
  total: number;
  limit: number;
  offset: number;
  items: { evaluationId: string; modelVersion: number; scoreValue: number | null; band: string; trigger: string; calculatedAt: string | null; sourceRevision: number | null; signature: string; resultState: string; breakdown: unknown[] }[];
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string, headers?: Record<string, string>): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...authHeader(token ?? ctx.adminToken), ...(headers ?? {}) },
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
  const error = result.body['error'] as { code?: string; details?: Body } | undefined;
  return { code: String(error?.code ?? ''), details: error?.details ?? {} };
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  expect(id).not.toBe('');
  createdRecordIds.push(id);
  return id;
}

interface Fixture {
  id: string;
  companyCode: string;
  industryCode: string;
}

async function createPublishedModel(name: string): Promise<Fixture> {
  const modelId = await createRecord(MODEL, {
    name: `${RUN} ${name}`,
    description: 'Model for the LS.5 read suite.',
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
  const companyCode = `ls5r_company_${modelId.slice(-6)}`;
  const industryCode = `ls5r_industry_${modelId.slice(-6)}`;
  await createRecord(RULE, {
    name: `${RUN} has a company`,
    modelId,
    modelVersion: 1,
    reasonCode: companyCode,
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
    name: `${RUN} target industry`,
    modelId,
    modelVersion: 1,
    reasonCode: industryCode,
    dimension: 'fit',
    enabled: true,
    condition: JSON.stringify({ field: 'industry', operator: 'equals', value: 'Software' }),
    effect: 'add',
    points: 20,
    priority: 20,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  expect((await call('POST', '/api/v1/LeadScore/action/model/publish', { modelId })).status).toBe(200);
  return { id: modelId, companyCode, industryCode };
}

async function setActiveModel(modelId: string | null): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', {
    enabled: true,
    features: { modelAdministration: true, scoring: true, manualRecalculation: true, scoreExplanation: true },
    scoring: { activeModelId: modelId },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function createLead(label: string, data: Record<string, unknown> = {}): Promise<string> {
  return createRecord('Lead', { name: `${RUN} ${label}`, lastName: `${RUN} ${label}`, ...data });
}

async function recalculate(leadId: string): Promise<CallResult> {
  return call('POST', '/api/v1/LeadScore/action/score/recalculate', { leadId });
}

async function readScore(leadId: string, token?: string, locale?: string): Promise<CallResult> {
  return call('GET', `/api/v1/LeadScore/action/score/${leadId}`, undefined, token, locale === undefined ? undefined : { 'accept-language': locale });
}

async function readHistory(leadId: string, query = '', token?: string): Promise<CallResult> {
  return call('GET', `/api/v1/LeadScore/action/score/${leadId}/history${query}`, undefined, token);
}

function score(result: CallResult): ScoreView {
  return result.body as unknown as ScoreView;
}

function history(result: CallResult): HistoryView {
  return result.body as unknown as HistoryView;
}

/** Score a Lead and remember the evaluation row, so `afterAll` can remove it by exact id. */
async function scoreLeadNow(leadId: string): Promise<Body> {
  const result = await recalculate(leadId);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const id = String((result.body as Body)['evaluationId'] ?? '');
  if (id !== '') createdRecordIds.push(id);
  return result.body as Body;
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const enabled = await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { modelAdministration: true } });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

  // The platform's rule is that a reader's own preference beats `Accept-Language`, and most assertions here
  // read English labels through the shared administrator. That is only deterministic while the account has
  // no preference set — and this is a development database somebody else may have used the UI on — so the
  // suite pins it for its own run and puts it back afterwards.
  const me = await call('GET', '/api/v1/AppUser/me');
  previousLocale = (me.body['locale'] as string | null | undefined) ?? null;
  const cleared = await call('PATCH', '/api/v1/AppUser/me', { locale: null });
  expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
}, 240_000);

afterAll(async () => {
  if (previousLocale !== null) {
    await call('PATCH', '/api/v1/AppUser/me', { locale: previousLocale }).catch(() => undefined);
  }
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
  await db.deleteFrom('roles').where('name', 'like', `${RUN}%`).execute().catch(() => undefined);

  const residue = await db.selectFrom('entity_records').select('id').where('name', 'like', `${RUN}%`).execute().catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score explanation suite left records behind');
  const settingsRow = await db.selectFrom('app_settings').select('name').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  if (previousSettings === null && settingsRow !== undefined) console.warn({ run: RUN }, 'leadScore settings row survived the suite');

  await shutdownApi();
}, 240_000);

describe('the score read explains itself (plan §6.5)', () => {
  it('answers the number, the band, the coverage and one labelled entry per rule', async () => {
    const model = await createPublishedModel('explain');
    await setActiveModel(model.id);
    const leadId = await createLead('explained', { company: 'Acme Software', industry: 'Software' });
    const written = await scoreLeadNow(leadId);

    const result = await readScore(leadId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = score(result);
    expect(body.scored).toBe(true);
    expect(body.score.value).toBe(50);
    expect(body.score.band).toBe('Warm');
    expect(body.score.coverage).toBe(1);
    expect(body.score.reasonCodes).toEqual([model.companyCode, model.industryCode].sort());
    // The read reports the same signature the write produced: same version, same inputs, same answer.
    expect(body.score.signature).toBe((written.evaluation as Body)['signature']);
    expect(body.score.evaluationId).toBe(written['evaluationId']);
    expect(body.score.modelId).toBe(model.id);
    expect(body.score.modelVersion).toBe(1);
    expect(typeof body.score.calculatedAt).toBe('string');
    expect(typeof body.score.inputsAsOf).toBe('string');

    expect(body.freshness.status).toBe('current');
    expect(body.freshness.label).toBe('Current');
    expect(body.freshness.reasons).toEqual([]);
    // `currentRevision` is one ahead of the revision the evaluation names, because storing a score is itself
    // a write to the Lead. The watermark, not that number, is what says the inputs did not move.
    expect(body.freshness.scoredRevision).toBeGreaterThan(0);
    expect(body.freshness.currentRevision).toBeGreaterThanOrEqual(body.freshness.scoredRevision ?? 0);
    expect(body.freshness.activeModelId).toBe(model.id);

    expect(body.explanation.breakdown).toHaveLength(2);
    const [first, second] = body.explanation.breakdown;
    expect(first?.reasonCode).toBe(model.companyCode);
    expect(first?.ruleName).toContain('company');
    expect(first?.outcome).toBe('matched');
    expect(first?.outcomeLabel).toBe('Applied');
    expect(first?.points).toBe(10);
    expect(second?.dimensionLabel).toBe('Fit');
    expect(body.explanation.reasonCodes.positive).toEqual([model.companyCode, model.industryCode].sort());
    expect(body.explanation.errorCodes).toEqual([]);
  });

  it('says which rules could not answer, without quoting the Lead', async () => {
    const model = await createPublishedModel('partial knowledge');
    await setActiveModel(model.id);
    const leadId = await createLead('no industry', { company: 'Acme Software' });
    await scoreLeadNow(leadId);

    const body = score(await readScore(leadId));
    expect(body.score.value).toBe(30);
    expect(body.score.coverage).toBe(0.3333);
    const industry = body.explanation.breakdown.find((entry) => entry.reasonCode === model.industryCode);
    expect(industry?.outcome).toBe('unknown');
    expect(industry?.outcomeLabel).toBe('Not enough information');
    expect(industry?.points).toBe(0);
    expect(body.explanation.reasonCodes.unknown).toEqual([model.industryCode]);
    // A breakdown that quoted the compared value would be a way to read a field past its ACL (plan §9.2).
    expect(JSON.stringify(body)).not.toContain('Acme Software');
  });

  it('answers a Lead that has never been scored, and does not invent a model for it', async () => {
    const model = await createPublishedModel('never scored');
    await setActiveModel(model.id);
    const leadId = await createLead('unscored', { company: 'Acme' });

    const read = await readScore(leadId);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const body = score(read);
    expect(body.scored).toBe(false);
    expect(body.score.value).toBeNull();
    expect(body.score.modelId).toBeNull();
    expect(body.freshness.status).toBe('not_scored');
    expect(body.freshness.label).toBe('Not scored yet');
    expect(body.explanation.breakdown).toEqual([]);
  });

  it('localizes the labels in the reader’s own language (plan §6.5, §13)', async () => {
    const model = await createPublishedModel('localized');
    await setActiveModel(model.id);
    const leadId = await createLead('doc dich', { company: 'Acme', industry: 'Software' });
    await scoreLeadNow(leadId);

    const roleId = `role_${RUN}_reader`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} score reader`, permissions: { Lead: { read: 'all' }, LeadScore: { read: 'yes' } } });
    const reader = await createTestUser(ctx, { userName: `${RUN}_reader`, roleIds: [roleId] });
    // The platform's rule is that a reader's own preference wins over `Accept-Language`, so that is what the
    // test changes rather than a header.
    const patched = await call('PATCH', '/api/v1/AppUser/me', { locale: 'vi' }, reader.token);
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const english = score(await readScore(leadId));
    const vietnamese = score(await readScore(leadId, reader.token));
    expect(english.freshness.label).toBe('Current');
    expect(vietnamese.freshness.label).toBe('Hiện hành');
    expect(english.freshness.label).not.toBe(vietnamese.freshness.label);
    expect(vietnamese.explanation.breakdown[0]?.outcomeLabel).toBe('Được áp dụng');
    expect(vietnamese.explanation.breakdown[1]?.dimensionLabel).toBe('Mức phù hợp');
    // The stable codes are the same in both languages; only the labels move.
    expect(vietnamese.score.reasonCodes).toEqual(english.score.reasonCodes);
  });
});

describe('freshness is derived, not stored (plan §5.3–§5.4)', () => {
  it('reports the score as out of date once the Lead has moved', async () => {
    const model = await createPublishedModel('went stale');
    await setActiveModel(model.id);
    const leadId = await createLead('edited after scoring', { company: 'Acme', industry: 'Software' });
    await scoreLeadNow(leadId);
    expect(score(await readScore(leadId)).freshness.status).toBe('current');

    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { industry: 'Hardware' })).status).toBe(200);
    const body = score(await readScore(leadId));
    // The number is still the one that was computed — and it says so, rather than being quietly re-derived or
    // silently dropped (plan §1.2 "input freshness").
    expect(body.score.value).toBe(50);
    expect(body.freshness.status).toBe('stale');
    expect(body.freshness.reasons).toEqual(['leadChanged']);
    expect(body.freshness.reasonLabels[0]).toContain('since this score was calculated');
    expect(body.freshness.currentRevision).toBeGreaterThan(body.freshness.scoredRevision ?? 0);
  });

  it('tells an unchanged recomputation from a moved record, not from the record’s version', async () => {
    const model = await createPublishedModel('watermark');
    await setActiveModel(model.id);
    const leadId = await createLead('recomputed', { company: 'Acme', industry: 'Software' });

    await scoreLeadNow(leadId);
    const afterFirst = await call('GET', `/api/v1/Lead/${leadId}`);
    // Storing a score moved the Lead's own `version`; the input watermark did not, so the read must not call
    // the score stale. This is the case a `version`-based comparison would get wrong on every second call.
    expect(score(await readScore(leadId)).freshness.status).toBe('current');

    await scoreLeadNow(leadId);
    const afterSecond = await call('GET', `/api/v1/Lead/${leadId}`);
    expect(afterSecond.body['version']).toBe(afterFirst.body['version']);
    expect(score(await readScore(leadId)).freshness.status).toBe('current');

    // A write that touches nothing the model reads still moves `version`, and the watermark keeps the read
    // honest about it: the score is not stale, because the inputs the score describes are unchanged.
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { title: 'Senior Buyer' })).status).toBe(200);
    expect(score(await readScore(leadId)).freshness.status).toBe('current');
  });

  it('names a different active model as the reason, not the record', async () => {
    const first = await createPublishedModel('first active');
    const second = await createPublishedModel('replacement');
    await setActiveModel(first.id);
    const leadId = await createLead('two models', { company: 'Acme', industry: 'Software' });
    await scoreLeadNow(leadId);

    await setActiveModel(second.id);
    const body = score(await readScore(leadId));
    expect(body.freshness.status).toBe('stale');
    expect(body.freshness.reasons).toEqual(['modelChanged']);
    expect(body.freshness.activeModelId).toBe(second.id);
    expect(body.score.modelId).toBe(first.id);

    // And with no active model at all the answer is a different reason, because the fix is different.
    await setActiveModel(null);
    expect(score(await readScore(leadId)).freshness.reasons).toEqual(expect.arrayContaining(['modelMissing']));
  });

  it('does not claim a movement it cannot see, for a reader whose field ACL hides a signal', async () => {
    const model = await createPublishedModel('limited reader');
    await setActiveModel(model.id);
    const leadId = await createLead('hidden from reader', { company: 'Acme', industry: 'Software' });
    await scoreLeadNow(leadId);

    const roleId = `role_${RUN}_nocompany`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} cannot see company`,
      permissions: { Lead: { read: 'all' }, LeadScore: { read: 'yes' }, LeadScoreExplain: { read: 'yes' } },
      fieldPermissions: { Lead: { company: { read: 'no', edit: 'no' } } },
    });
    const limited = await createTestUser(ctx, { userName: `${RUN}_nocompany`, roleIds: [roleId] });

    const body = score(await readScore(leadId, limited.token));
    // This reader's view of the inputs is not the input set the score was computed from, so the read declines
    // to answer "changed" either way rather than infer it from its own permissions.
    expect(body.freshness.reasons).not.toContain('leadChanged');
    expect(body.freshness.status).toBe('current');
    // The breakdown still cannot leak the hidden value.
    expect(JSON.stringify(body)).not.toContain('Acme');
  });
});

describe('the history command pages one Lead’s evaluations', () => {
  it('returns newest first with a total, and honours the page bounds', async () => {
    const model = await createPublishedModel('history');
    await setActiveModel(model.id);
    const leadId = await createLead('three scores', { company: 'Acme', industry: 'Hardware' });

    const first = await scoreLeadNow(leadId);
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { company: 'Other Co' })).status).toBe(200);
    const second = await scoreLeadNow(leadId);
    // Back to the data the first evaluation described, so the third call resolves to that row: history is one
    // record per (Lead, model version, inputs), which is what makes a repeated recalculation harmless to run
    // (plan §5.4, §10.2) — an edit and its reversal do not invent a third evaluation.
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { company: 'Acme' })).status).toBe(200);
    const third = await scoreLeadNow(leadId);
    expect(third['evaluationId']).toBe(first['evaluationId']);

    const fullRead = await readHistory(leadId, '?limit=10');
    expect(fullRead.status, JSON.stringify(fullRead.body)).toBe(200);
    const full = history(fullRead);
    expect(full.total).toBe(2);
    // Newest first: the 'Other Co' recording, then the original.
    expect(full.items.map((item) => item.evaluationId)).toEqual([second['evaluationId'], first['evaluationId']]);
    // The company rule matched in both, the industry rule never did: 20 + 10 both times.
    expect(full.items.map((item) => item.scoreValue)).toEqual([30, 30]);
    expect(full.items[0]?.trigger).toBe('manual_recalculate');
    expect(full.items[0]?.sourceRevision).toBeGreaterThan(0);
    expect(full.items[0]?.breakdown).toHaveLength(2);
    expect(full.items[0]?.signature).toHaveLength(64);

    const page = history(await readHistory(leadId, '?limit=1&offset=1'));
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.items[0]?.evaluationId).toBe(first['evaluationId']);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);

    // A page cannot be asked for more than the bound, and the bound is the module's, not the caller's.
    expect((await readHistory(leadId, '?limit=500')).status).toBeGreaterThanOrEqual(400);
  });

  it('keeps the entity read closed while the Lead-scoped command works', async () => {
    const model = await createPublishedModel('one door');
    await setActiveModel(model.id);
    const leadId = await createLead('history through the command', { company: 'Acme' });
    const written = await scoreLeadNow(leadId);

    const roleId = `role_${RUN}_explainer`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} score explainer`,
      permissions: { Lead: { read: 'all' }, LeadScore: { read: 'yes' }, LeadScoreExplain: { read: 'yes' } },
    });
    const explainer = await createTestUser(ctx, { userName: `${RUN}_explainer`, roleIds: [roleId] });

    const viaCommand = await readHistory(leadId, '', explainer.token);
    expect(viaCommand.status, JSON.stringify(viaCommand.body)).toBe(200);
    expect(history(viaCommand).items).toHaveLength(1);

    // The same caller cannot read the row through the generic entity API: `read: 'no'` is what makes the
    // record-level check above the only door (plan §5.4, LS.2 §5.4 note).
    const viaEntity = await call('GET', `/api/v1/LeadScoreEvaluation/${String(written['evaluationId'])}`, undefined, explainer.token);
    expect(viaEntity.status).toBeGreaterThanOrEqual(400);

    // And the badge right alone does not open the explanation door.
    const viewerRole = `role_${RUN}_badgeonly`;
    await createTestRole(ctx, { id: viewerRole, name: `${RUN} badge only`, permissions: { Lead: { read: 'all' }, LeadScore: { read: 'yes' } } });
    const badgeOnly = await createTestUser(ctx, { userName: `${RUN}_badgeonly`, roleIds: [viewerRole] });
    expect((await readScore(leadId, badgeOnly.token)).status).toBe(200);
    const refused = await readHistory(leadId, '', badgeOnly.token);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).details['capability']).toBe('explainScore');
  });

  it('refuses a Lead this caller may not read, and a switch that is off', async () => {
    const model = await createPublishedModel('gated reads');
    await setActiveModel(model.id);
    const leadId = await createLead('private score', { company: 'Acme' });
    await scoreLeadNow(leadId);

    const ownRole = `role_${RUN}_ownreads`;
    await createTestRole(ctx, {
      id: ownRole,
      name: `${RUN} own leads`,
      permissions: { Lead: { read: 'own' }, LeadScore: { read: 'yes' }, LeadScoreExplain: { read: 'yes' } },
    });
    const outsider = await createTestUser(ctx, { userName: `${RUN}_outsider2`, roleIds: [ownRole] });
    expect((await readScore(leadId, outsider.token)).status).toBe(404);
    expect((await readHistory(leadId, '', outsider.token)).status).toBe(404);

    await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { modelAdministration: true, scoring: false }, scoring: { activeModelId: model.id } });
    const closed = await readScore(leadId);
    expect(closed.status).toBe(403);
    expect(errorOf(closed).code).toBe('LEADSCORE_MODULE_DISABLED');
    await setActiveModel(model.id);
  });
});

describe('the score read says what this caller may do (19-LS.7)', () => {
  it('answers the affordance the button would meet, from the gate rather than from the SPA', async () => {
    const model = await createPublishedModel('affordances');
    await setActiveModel(model.id);
    const leadId = await createLead('actionable', { company: 'Acme' });
    await scoreLeadNow(leadId);

    const view = score(await readScore(leadId));
    // An administrator holds every right and the module is switched on: both doors open, no reason attached.
    // The AI insight is its own door and stays closed while its feature is off (19-LS.17).
    expect(view.actions).toEqual({
      recalculate: { allowed: true, reason: null },
      history: { allowed: true, reason: null },
      insight: { allowed: false, reason: 'LEADSCORE_MODULE_DISABLED' },
    });

    // A reader with the badge right alone gets the number and is told, in stable codes, why there is no
    // button — the panel renders this answer rather than guessing from a role name (AGENTS.md §5.3).
    const badgeRole = `role_${RUN}_badge_affordance`;
    await createTestRole(ctx, { id: badgeRole, name: `${RUN} badge affordance`, permissions: { Lead: { read: 'all' }, LeadScore: { read: 'yes' } } });
    const badgeOnly = await createTestUser(ctx, { userName: `${RUN}_badge_affordance`, roleIds: [badgeRole] });
    const viewer = score(await readScore(leadId, badgeOnly.token));
    expect(viewer.actions.recalculate).toEqual({ allowed: false, reason: 'AUTHORIZATION_DENIED' });
    expect(viewer.actions.history).toEqual({ allowed: false, reason: 'AUTHORIZATION_DENIED' });
    expect(viewer.actions.insight).toEqual({ allowed: false, reason: 'AUTHORIZATION_DENIED' });
  });

  it('does not offer a recalculation to a caller who cannot edit a Lead', async () => {
    const model = await createPublishedModel('recalculate needs edit');
    await setActiveModel(model.id);
    const leadId = await createLead('read-only recalc', { company: 'Acme' });
    await scoreLeadNow(leadId);

    // `LeadScoreRecalculate` is the module's right; writing a score is also a write onto a Lead, and the
    // panel must show the union of the two, not one of them.
    const roleId = `role_${RUN}_score_write_no_lead_edit`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} recalculate without edit`,
      permissions: { Lead: { read: 'all' }, LeadScore: { read: 'yes' }, LeadScoreExplain: { read: 'yes' }, LeadScoreRecalculate: { edit: 'yes' } },
    });
    const caller = await createTestUser(ctx, { userName: `${RUN}_no_lead_edit`, roleIds: [roleId] });

    const view = score(await readScore(leadId, caller.token));
    expect(view.actions.recalculate).toEqual({ allowed: false, reason: 'LEAD_NOT_EDITABLE' });
    // The explanation door is unaffected by the record right.
    expect(view.actions.history.allowed).toBe(true);

    // The answer is not decoration. Asked to score a Lead it has never scored — so the projection really is
    // a write — the same caller is refused by the core `Lead:edit` right, which is what the affordance answer
    // predicted. (A Lead whose stored projection already says this answers as a no-op without writing, so the
    // scored record above would prove nothing here.)
    const unscored = await createLead('recalc attempt', { company: 'Beta' });
    const attempted = await call('POST', '/api/v1/LeadScore/action/score/recalculate', { leadId: unscored }, caller.token);
    expect(attempted.status, JSON.stringify(attempted.body)).toBe(403);
    expect(errorOf(attempted).code).toBe('AUTHORIZATION_DENIED');
    // Nothing was stored: the refusal left no projection and no history row behind.
    expect(history(await readHistory(unscored, '', caller.token)).items).toEqual([]);
  });

  it('reports a switch as the reason while manual recalculation is off', async () => {
    const model = await createPublishedModel('switched affordance');
    await setActiveModel(model.id);
    const leadId = await createLead('switched action', { company: 'Acme' });
    await scoreLeadNow(leadId);

    await call('POST', '/api/v1/LeadScore/action/settings', {
      enabled: true,
      features: { modelAdministration: true, scoring: true, scoreExplanation: true, manualRecalculation: false },
      scoring: { activeModelId: model.id },
    });
    const view = score(await readScore(leadId));
    expect(view.actions.recalculate).toEqual({ allowed: false, reason: 'LEADSCORE_MODULE_DISABLED' });
    expect(view.actions.history.allowed).toBe(true);

    await setActiveModel(model.id);
    expect(score(await readScore(leadId)).actions.recalculate.allowed).toBe(true);
  });
});

describe('the words 19-LS.7 renders exist in both catalogs', () => {
  it('resolves every label the Lead Score card asks the server or the SPA for', async () => {
    const i18n = ctx.app.get(I18nService, { strict: false }) as I18nService;
    // A catalog key that breaks the platform's naming convention does not fail one label: the loader aborts
    // and *every* translation in the instance falls back to its code. This suite would not notice — the card
    // would silently render `not_scored` and `sales_ready` to a user — so the keys are asserted here.
    const keys = [
      'leadscore.panel.title',
      'leadscore.panel.recalculate',
      'leadscore.panel.history',
      'leadscore.panel.notScored',
      'leadscore.panel.rules',
      'leadscore.panel.coverage',
      'leadscore.panel.movement',
      'leadscore.panel.loadMore',
      'leadscore.panel.triggerHeader',
      'leadscore.panel.showing',
      'leadscore.panel.unchanged',
      'leadscore.panel.recordsWritten',
      'leadscore.panel.historyFailed',
      'leadscore.panel.noRules',
      'leadscore.band.unknown',
      'leadscore.band.cold',
      'leadscore.band.warm',
      'leadscore.band.hot',
      'leadscore.band.sales_ready',
      'leadscore.band.disqualified',
      'leadscore.panel.trigger.lead_change',
      'leadscore.panel.trigger.manual_recalculate',
      'leadscore.panel.trigger.batch_rebuild',
      // 19-LS.9's words. The card prints the signal it read and the state that explains a skip, the preview
      // names the window, and the rule form is the only way an engagement rule gets authored — every one of
      // those strings must exist in *both* catalogs, because one bad key turns the whole instance's labels
      // back into codes.
      'leadscore.panel.signal',
      'leadscore.panel.signalState.disabled',
      'leadscore.panel.signalState.absent',
      'leadscore.operator.gte',
      'leadscore.admin.source.marketingEvents',
      'leadscore.admin.source.emailLinks',
      'leadscore.admin.metric.eventCount',
      'leadscore.admin.metric.lastEventAt',
      'leadscore.admin.metric.daysSinceLastEvent',
      'leadscore.admin.metric.clickCount',
      'leadscore.admin.event.opened',
      'leadscore.admin.event.clicked',
      'leadscore.admin.preview.planWindow',
      'leadscore.admin.preview.signalState.available',
      'leadscore.admin.preview.signalState.no_events',
      'leadscore.admin.preview.signalState.disabled',
      'leadscore.admin.preview.signalState.absent',
      'leadscore.admin.rule.eventTypeHint',
      'leadscore.admin.rule.anyEvent',
      'leadscore.admin.rule.lookbackRequired',
      'leadscore.admin.rule.halfLifeDays',
      'leadscore.admin.rule.engagementNote',
      'leadscore.admin.builder.noMetrics',
      'leadscore.admin.settings.sweep',
      'leadscore.admin.settings.sweepTablePresent',
      'leadscore.admin.settings.sweepTableAbsent',
    ];
    for (const locale of ['en', 'vi']) {
      for (const key of keys) {
        const value = i18n.translate(locale, key);
        expect(value, `${locale} ${key}`).toBeTruthy();
        expect(value, `${locale} ${key}`).not.toBe(key);
      }
    }
    // The freshness, outcome and dimension labels the read already served come from the same catalog, so a
    // load failure would show up as a code in the response the card prints.
    const model = await createPublishedModel('labels survive');
    await setActiveModel(model.id);
    const leadId = await createLead('labelled', { company: 'Acme' });
    await scoreLeadNow(leadId);
    const view = score(await readScore(leadId));
    expect(view.freshness.label).not.toBe('current');
    expect(view.explanation.breakdown[0]?.outcomeLabel).toBeTruthy();
    expect(view.explanation.breakdown[0]?.outcomeLabel).not.toBe('matched');
  });
});

describe('the module reports what a score would be computed under', () => {
  it('shows the active model in health, usable only when it is published', async () => {
    const model = await createPublishedModel('health view');
    await setActiveModel(model.id);

    const health = await call('GET', '/api/v1/LeadScore/action/health');
    const settings = (health.body as { settings: { scoring: { activeModelId: string | null; status: string | null; usable: boolean; state: string | null } } }).settings;
    expect(settings.scoring.activeModelId).toBe(model.id);
    expect(settings.scoring.status).toBe('published');
    expect(settings.scoring.usable).toBe(true);
    expect(settings.scoring.state).toBeNull();

    const archived = await call('POST', '/api/v1/LeadScore/action/model/archive', { modelId: model.id });
    expect(archived.status).toBe(200);
    const afterArchive = await call('GET', '/api/v1/LeadScore/action/health');
    const reported = (afterArchive.body as { settings: { scoring: { usable: boolean; state: string | null } } }).settings.scoring;
    expect(reported.usable).toBe(false);
    expect(reported.state).toBe('notPublished');
    // A configuration gap is reported, not treated as a broken installation: `ok` stays about the platform.
    expect((afterArchive.body as { ok: boolean }).ok).toBe(true);
  });
});
