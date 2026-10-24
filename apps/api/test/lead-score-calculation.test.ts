import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.5 — computing a score and keeping it
 * (`PLAN_Phase_19_LeadScore.md` §3.1, §5.3–§5.4, §8.2, §9.1–§9.2, §10.2, §16 `19-LS.5`; report
 * `docs/implementation/lead-score-ls4-completion-report.md` for the engine half).
 *
 * LS.4 proved the arithmetic. This suite is about what happens when that answer is **stored**, which is
 * where the phase's real risks live:
 *
 * - the projection and the history must agree — one evaluation and one projection write, in one transaction,
 *   so a number never exists in one place without the other (plan §5.3–§5.4);
 * - recomputing an unchanged Lead must be a genuine no-op: same deterministic key ⇒ the same history row,
 *   and a Lead `version` that does not move just because somebody pressed a button (§5.4, §10.2);
 * - the rule set is read **internally** while the Lead is read **through the core path**, so an operator
 *   without model rights still gets the published model's real answer, and still cannot score a Lead they
 *   cannot see or read past a hidden field (§4.4, §6.5, §9.2);
 * - the LS.2 write guard must still refuse a *client* write of these same fields afterwards — the internal
 *   marker is one caller's key, not an open door.
 *
 * Runs against the configured primary database (AGENTS.md §3.1): no test database, no reset, no truncate.
 * `afterAll` restores the `leadScore` row from the raw column and removes this run's Leads, model, rules and
 * evaluation rows by exact id.
 */

const RUN = `AGENT_TEST_LS5_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODEL = 'LeadScoreModel';
const RULE = 'LeadScoreRule';
const RECALCULATE_PATH = '/api/v1/LeadScore/action/score/recalculate';

let ctx: ApiContext;
let previousSettings: string | null = null;
const createdRecordIds: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface WriteView {
  leadId: string;
  evaluationId: string;
  recorded: boolean;
  projectionWritten: boolean;
  model: { id: string; name: string; modelVersion: number };
  evaluation: {
    scoreValue: number | null;
    band: string;
    coverage: number;
    resultState: string;
    signature: string;
    idempotencyKey: string;
    trigger: string;
    sourceRevision: number;
    positiveReasonCodes: string[];
    negativeReasonCodes: string[];
    unknownReasonCodes: string[];
    skippedReasonCodes: string[];
    errorCodes: string[];
  };
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

/** base 20, a 10-point completeness rule and a 20-point fit rule: 50 for a Software company Lead. */
async function createPublishedModel(name = 'active'): Promise<{ id: string; companyCode: string; industryCode: string }> {
  const modelId = await createRecord(MODEL, {
    name: `${RUN} ${name}`,
    description: 'Model for the LS.5 persistence suite.',
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
  const companyCode = `ls5_company_${modelId.slice(-6)}`;
  const industryCode = `ls5_industry_${modelId.slice(-6)}`;
  await createRecord(RULE, {
    name: `${RUN} company rule`,
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
    name: `${RUN} industry rule`,
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
  const published = await call('POST', '/api/v1/LeadScore/action/model/publish', { modelId });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return { id: modelId, companyCode, industryCode };
}

async function setActiveModel(modelId: string | null): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', {
    enabled: true,
    features: { modelAdministration: true, scoringPreview: true, scoring: true, manualRecalculation: true, scoreExplanation: true },
    scoring: { activeModelId: modelId },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function createLead(label: string, data: Record<string, unknown> = {}): Promise<string> {
  return createRecord('Lead', { name: `${RUN} ${label}`, lastName: `${RUN} ${label}`, ...data });
}

async function readLead(leadId: string, token?: string): Promise<CallResult> {
  return call('GET', `/api/v1/Lead/${leadId}`, undefined, token);
}

async function recalculate(leadId: string, token?: string): Promise<CallResult> {
  return call('POST', RECALCULATE_PATH, { leadId }, token);
}

function write(result: CallResult): WriteView {
  return result.body as unknown as WriteView;
}

async function evaluationIds(leadId: string): Promise<string[]> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'LeadScoreEvaluation')
    .where((eb) => eb(sql`attrs ->> 'leadId'`, '=', leadId))
    .execute();
  return rows.map((row) => row.id);
}

async function auditRows(recordId: string): Promise<number> {
  const rows = await ctx.database.db.selectFrom('audit_log').select('id').where('record_id', '=', recordId).execute();
  return rows.length;
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  // The model lifecycle is a switched-on capability, and every test here publishes a model before it selects
  // one — so the module and `modelAdministration` come on once, here, rather than in each fixture.
  const enabled = await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { modelAdministration: true } });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
}, 240_000);

afterAll(async () => {
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

  // Leads and configuration rows carry this run's name; evaluations do not (their display name is the score
  // the engine produced), so they are removed by the ids the commands returned.
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
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score calculation suite left records behind');
  // Evaluations are named by the score they carry, not by this run's marker, so they are removed by the ids
  // the commands returned plus, defensively, every evaluation whose `leadId` is one of this run's Leads.
  if (mine.length > 0) {
    const evaluations = await db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'LeadScoreEvaluation')
      .where((eb) => eb(sql`attrs ->> 'leadId'`, 'in', mine.map((row) => row.id)))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (evaluations.length > 0) {
      await db.deleteFrom('entity_records').where('id', 'in', evaluations.map((row) => row.id)).execute().catch(() => undefined);
    }
  }
  const settingsRow = await db.selectFrom('app_settings').select('name').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  if (previousSettings === null && settingsRow !== undefined) console.warn({ run: RUN }, 'leadScore settings row survived the suite');

  await shutdownApi();
}, 240_000);

describe('a recalculation stores an evaluation and the projection that matches it', () => {
  it('writes the number, the band, the codes and the history row in one call', async () => {
    const model = await createPublishedModel('stores');
    await setActiveModel(model.id);
    const leadId = await createLead('software', { company: 'Acme Software', industry: 'Software' });

    const result = await recalculate(leadId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = write(result);
    expect(body.recorded).toBe(true);
    expect(body.projectionWritten).toBe(true);
    expect(body.evaluation.scoreValue).toBe(50);
    expect(body.evaluation.band).toBe('Warm');
    expect(body.evaluation.coverage).toBe(1);
    expect(body.evaluation.trigger).toBe('manual_recalculate');
    expect(body.model.modelVersion).toBe(1);

    const lead = await readLead(leadId);
    // The projection as plan §5.3 defines it, on the Lead itself — which is what lets a list read a score
    // without running the engine.
    expect(lead.body['scoreValue']).toBe(50);
    expect(lead.body['scoreBand']).toBe('Warm');
    expect(lead.body['scoreStatus']).toBe('current');
    expect(lead.body['scoreModelId']).toBe(model.id);
    expect(lead.body['scoreModelVersion']).toBe(1);
    expect(lead.body['scoreCoverage']).toBe(1);
    expect(typeof lead.body['scoreCalculatedAt']).toBe('string');
    expect(JSON.parse(String(lead.body['scoreReasonCodes']))).toEqual([model.companyCode, model.industryCode].sort());

    const evaluations = await evaluationIds(leadId);
    expect(evaluations).toEqual([body.evaluationId]);
    createdRecordIds.push(body.evaluationId);
  });

  it('keeps the history row and the projection describing the same input revision', async () => {
    const model = await createPublishedModel('provenance');
    await setActiveModel(model.id);
    const leadId = await createLead('provenance lead', { company: 'Acme', industry: 'Hardware' });
    const before = await readLead(leadId);

    const result = await recalculate(leadId);
    expect(result.status).toBe(200);
    createdRecordIds.push(write(result).evaluationId);

    const row = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', write(result).evaluationId).executeTakeFirst();
    const attrs = row?.attrs as Body;
    expect(attrs['leadId']).toBe(leadId);
    expect(attrs['modelId']).toBe(model.id);
    expect(attrs['modelVersion']).toBe(1);
    expect(attrs['sourceRevision']).toBe(before.body['version']);
    expect(attrs['inputsAsOf']).toBe(before.body['modifiedAt']);
    expect(attrs['signature']).toHaveLength(64);
    // The input watermark 19-LS.5 compares against on the next read. The Lead's own `version` cannot serve
    // that purpose, because storing the score moves it.
    expect(attrs['inputsHash']).toHaveLength(64);
    expect(attrs['evaluationStatus']).toBe('current');
    expect(attrs['resultState']).toBe('success');
    expect(String(attrs['idempotencyKey'])).toMatch(/^[0-9a-f]{64}$/);
    // The breakdown is stored whole, so LS.5's explanation is a read of what produced the number.
    const ruleResults = JSON.parse(String(attrs['ruleResults'])) as { reasonCode: string; ruleName: string; outcome: string; points: number }[];
    expect(ruleResults.map((entry) => [entry.reasonCode, entry.outcome])).toEqual([
      [model.companyCode, 'matched'],
      [model.industryCode, 'not_matched'],
    ]);
    expect(ruleResults[0]?.ruleName).toContain('company rule');
    expect(typeof attrs['correlationId']).toBe('string');
  });

  it('recomputing an unchanged Lead records nothing new and does not move the record', async () => {
    const model = await createPublishedModel('no-op');
    await setActiveModel(model.id);
    const leadId = await createLead('steady', { company: 'Acme', industry: 'Software' });

    const first = write(await recalculate(leadId));
    createdRecordIds.push(first.evaluationId);
    const leadAfterFirst = await readLead(leadId);

    const second = write(await recalculate(leadId));
    expect(second.recorded).toBe(false);
    expect(second.projectionWritten).toBe(false);
    expect(second.evaluationId).toBe(first.evaluationId);
    expect(second.evaluation.signature).toBe(first.evaluation.signature);

    // `version` and `modifiedAt` identical is the assertion that matters: a recalculation of unchanged data
    // must not look like an edit of the Lead (plan §5.4, §10.2).
    const leadAfterSecond = await readLead(leadId);
    expect(leadAfterSecond.body['version']).toBe(leadAfterFirst.body['version']);
    expect(leadAfterSecond.body['modifiedAt']).toBe(leadAfterFirst.body['modifiedAt']);
    expect(await evaluationIds(leadId)).toEqual([first.evaluationId]);
  });

  it('a changed signal produces a new evaluation, keeps the old one, and reports the movement', async () => {
    const model = await createPublishedModel('movement');
    await setActiveModel(model.id);
    const leadId = await createLead('industry arrives', { company: 'Acme', industry: 'Hardware' });

    const cold = write(await recalculate(leadId));
    createdRecordIds.push(cold.evaluationId);
    expect(cold.evaluation.scoreValue).toBe(30);

    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { industry: 'Software' })).status).toBe(200);
    const warm = write(await recalculate(leadId));
    createdRecordIds.push(warm.evaluationId);

    expect(warm.evaluationId).not.toBe(cold.evaluationId);
    expect(warm.evaluation.scoreValue).toBe(50);
    const lead = await readLead(leadId);
    // `scorePreviousValue` is what lets the panel show movement without paging the history (plan §5.3).
    expect(lead.body['scorePreviousValue']).toBe(30);
    const history = await evaluationIds(leadId);
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([cold.evaluationId, warm.evaluationId]));
  });

  it('does not audit the projection: the evaluations are the score’s audit trail', async () => {
    const model = await createPublishedModel('quiet write');
    await setActiveModel(model.id);
    const leadId = await createLead('unaudited', { company: 'Acme' });

    const before = await auditRows(leadId);
    const result = write(await recalculate(leadId));
    createdRecordIds.push(result.evaluationId);
    // Creating the Lead itself was audited; the score fields deliberately are not — a batch rebuild would
    // otherwise write every Lead's value into `audit_log` (LS.2 §5.4 decision).
    expect(await auditRows(leadId)).toBe(before);
    expect(result.projectionWritten).toBe(true);
  });

  it('still refuses a client that writes these fields itself afterwards', async () => {
    const model = await createPublishedModel('guard holds');
    await setActiveModel(model.id);
    const leadId = await createLead('guarded', { company: 'Acme' });
    const result = write(await recalculate(leadId));
    createdRecordIds.push(result.evaluationId);

    const forged = await call('PATCH', `/api/v1/Lead/${leadId}`, { scoreValue: 99 });
    expect(forged.status).toBe(422);
    expect(JSON.stringify(forged.body)).toContain('scoreValue');

    // And the stored row is not a general-purpose write target either.
    const historyEdit = await call('PATCH', `/api/v1/LeadScoreEvaluation/${result.evaluationId}`, { scoreValue: 99 });
    expect(historyEdit.status).toBeGreaterThanOrEqual(400);
    const stillThere = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', result.evaluationId).executeTakeFirst();
    expect((stillThere?.attrs as Body)['scoreValue']).toBe(result.evaluation.scoreValue);
  });
});

describe('the doors a recalculation passes', () => {
  it('refuses when no model is active, and says which of the three states it found', async () => {
    const model = await createPublishedModel('state reporting');
    const leadId = await createLead('unconfigured', { company: 'Acme' });

    await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { scoring: true, manualRecalculation: true }, scoring: { activeModelId: null } });
    const unset = await recalculate(leadId);
    expect(unset.status).toBe(409);
    expect(errorOf(unset).code).toBe('LEADSCORE_NO_ACTIVE_MODEL');
    expect(errorOf(unset).details['state']).toBe('unset');

    await setActiveModel('does-not-exist');
    const missing = await recalculate(leadId);
    expect(errorOf(missing).details['state']).toBe('missing');
    // An id that names nothing is not echoed back: the answer must not confirm or deny anything (§9.2).
    expect(JSON.stringify(missing.body)).not.toContain('does-not-exist');

    const draft = await createRecord(MODEL, {
      name: `${RUN} draft active`,
      modelVersion: 1,
      scaleMin: 0,
      scaleMax: 100,
      baseScore: 0,
      scoreFloor: 0,
      scoreCeiling: 100,
      qualificationBands: JSON.stringify([{ band: 'Cold', min: 0, max: 100 }]),
    });
    await setActiveModel(draft);
    const notPublished = await recalculate(leadId);
    expect(errorOf(notPublished).details['state']).toBe('notPublished');
    expect(errorOf(notPublished).details['modelStatus']).toBe('draft');

    await setActiveModel(model.id);
    expect((await recalculate(leadId)).status).toBe(200);
    createdRecordIds.push(...(await evaluationIds(leadId)));
  });

  it('refuses a caller without the recalculate right, and one who cannot read the Lead', async () => {
    const model = await createPublishedModel('rights');
    await setActiveModel(model.id);
    const leadId = await createLead('rights lead', { company: 'Acme' });

    const scoreViewerRole = `role_${RUN}_scoreviewer`;
    await createTestRole(ctx, { id: scoreViewerRole, name: `${RUN} score viewer`, permissions: { LeadScore: { read: 'yes' }, Lead: { read: 'all' } } });
    const viewer = await createTestUser(ctx, { userName: `${RUN}_viewer`, roleIds: [scoreViewerRole] });
    const denied = await recalculate(leadId, viewer.token);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details['capability']).toBe('recalculate');

    // The record door is the core one: an invisible Lead cannot be scored by someone who cannot see it.
    const ownRole = `role_${RUN}_ownonly`;
    await createTestRole(ctx, {
      id: ownRole,
      name: `${RUN} own leads only`,
      permissions: { Lead: { read: 'own', edit: 'own' }, LeadScore: { read: 'yes' }, LeadScoreRecalculate: { read: 'yes', edit: 'yes' }, LeadScoreEvaluation: { create: 'yes' } },
    });
    const outsider = await createTestUser(ctx, { userName: `${RUN}_outsider`, roleIds: [ownRole] });
    const refused = await recalculate(leadId, outsider.token);
    // The record door answers before anything is computed, and it answers the way any unseen record does. The
    // id the caller already held is echoed by the platform's own not-found envelope, so the leak test is about
    // the Lead's *data*, not about its identifier.
    expect(refused.status).toBe(404);
    expect(errorOf(refused).code).toBe('RECORD_NOT_FOUND');
    expect(JSON.stringify(refused.body)).not.toContain('Acme');
  });

  it('scores against the whole published rule set for an operator who may not read model configuration', async () => {
    const model = await createPublishedModel('internal read');
    await setActiveModel(model.id);
    const leadId = await createLead('operator lead', { company: 'Acme', industry: 'Software' });

    const operatorRole = `role_${RUN}_operator`;
    await createTestRole(ctx, {
      id: operatorRole,
      name: `${RUN} scorer without model rights`,
      // Deliberately no `LeadScoreModel`/`LeadScoreRule`: those rights govern configuration, not the score.
      permissions: {
        Lead: { read: 'all', edit: 'all' },
        LeadScore: { read: 'yes' },
        LeadScoreRecalculate: { read: 'yes', edit: 'yes' },
        // The history row is a record this module owns, and creating it is part of what recalculating means
        // (its content is engine output, and `read: 'no'` still keeps it out of a general entity read).
        LeadScoreEvaluation: { create: 'yes' },
      },
    });
    const operator = await createTestUser(ctx, { userName: `${RUN}_operator`, roleIds: [operatorRole] });

    const attempted = await recalculate(leadId, operator.token);
    expect(attempted.status, JSON.stringify(attempted.body)).toBe(200);
    const result = write(attempted);
    createdRecordIds.push(result.evaluationId);
    // 20 + 10 + 20 rather than 30: the second rule was read even though this caller could not list it.
    expect(result.evaluation.scoreValue).toBe(50);
    expect(result.evaluation.positiveReasonCodes).toHaveLength(2);

    // While the same caller is refused a general rule read.
    const rulesList = await call('GET', `/api/v1/${MODEL}/${model.id}/rules`, undefined, operator.token);
    expect(rulesList.status).toBeGreaterThanOrEqual(400);
  });

  it('turns a field the operator may not read into an unknown signal, not a borrowed one', async () => {
    const model = await createPublishedModel('field acl');
    await setActiveModel(model.id);
    const leadId = await createLead('hidden industry', { company: 'Acme', industry: 'Software' });

    const limitedRole = `role_${RUN}_hidden`;
    await createTestRole(ctx, {
      id: limitedRole,
      name: `${RUN} no industry`,
      permissions: { Lead: { read: 'all', edit: 'all' }, LeadScore: { read: 'yes' }, LeadScoreRecalculate: { read: 'yes', edit: 'yes' }, LeadScoreEvaluation: { create: 'yes' } },
      fieldPermissions: { Lead: { industry: { read: 'no', edit: 'no' } } },
    });
    const limited = await createTestUser(ctx, { userName: `${RUN}_limited`, roleIds: [limitedRole] });

    const attempted = await recalculate(leadId, limited.token);
    expect(attempted.status, JSON.stringify(attempted.body)).toBe(200);
    const result = write(attempted);
    createdRecordIds.push(result.evaluationId);
    // The withheld signal contributes nothing and the coverage says so; the stored score is not the 50 that a
    // reader who can see the field gets.
    expect(result.evaluation.scoreValue).toBe(30);
    expect(result.evaluation.coverage).toBe(0.3333);
    expect(result.evaluation.unknownReasonCodes).toEqual([model.industryCode]);
    expect(JSON.stringify(result)).not.toContain('Software');
  });

  it('rolls the whole command back when the history row is not permitted, leaving the projection untouched', async () => {
    const model = await createPublishedModel('atomic');
    await setActiveModel(model.id);
    const leadId = await createLead('half written', { company: 'Acme', industry: 'Software' });

    const role = `role_${RUN}_nocreate`;
    await createTestRole(ctx, {
      id: role,
      name: `${RUN} scorer without history rights`,
      // The recalculate right without the right to create the history row the command writes: the grant story
      // LS.5 documents, tested from the other side.
      permissions: { Lead: { read: 'all', edit: 'all' }, LeadScore: { read: 'yes' }, LeadScoreRecalculate: { read: 'yes', edit: 'yes' } },
    });
    const caller = await createTestUser(ctx, { userName: `${RUN}_nocreate`, roleIds: [role] });

    const refused = await recalculate(leadId, caller.token);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorOf(refused).details['entity']).toBe('LeadScoreEvaluation');

    // Plan §5.3–§5.4: a number and its history arrive together or not at all. A projection left behind by a
    // command whose evaluation row was refused would describe a score nothing recorded.
    const lead = await readLead(leadId);
    expect(lead.body['scoreValue'] ?? null).toBeNull();
    expect(lead.body['scoreStatus']).toBe('not_scored');
    expect(await evaluationIds(leadId)).toEqual([]);
  });

  it('obeys the switches: off by module and off by feature are different refusals', async () => {
    const model = await createPublishedModel('switches');
    await setActiveModel(model.id);
    const leadId = await createLead('switched lead', { company: 'Acme' });

    await call('POST', '/api/v1/LeadScore/action/settings', { enabled: false });
    const disabled = await recalculate(leadId);
    expect(disabled.status).toBe(403);
    expect(errorOf(disabled).code).toBe('LEADSCORE_MODULE_DISABLED');

    await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { modelAdministration: true, scoring: true, manualRecalculation: false }, scoring: { activeModelId: model.id } });
    const featureOff = await recalculate(leadId);
    expect(featureOff.status).toBe(403);
    expect(JSON.stringify(featureOff.body)).toContain('manualRecalculation');

    await setActiveModel(model.id);
    expect((await recalculate(leadId)).status).toBe(200);
    createdRecordIds.push(...(await evaluationIds(leadId)));
  });

  it('asks for exactly one Lead and nothing else', async () => {
    const model = await createPublishedModel('shape');
    await setActiveModel(model.id);

    const noLead = await call('POST', RECALCULATE_PATH, {});
    expect(noLead.status).toBeGreaterThanOrEqual(400);
    expect(noLead.status).toBeLessThan(500);

    const extraKey = await call('POST', RECALCULATE_PATH, { leadId: 'x', maxSize: 500 });
    expect(extraKey.status).toBeGreaterThanOrEqual(400);
    expect(extraKey.status).toBeLessThan(500);
  });
});

describe('a stored score keeps naming the version that produced it (plan §5.1, §9.3)', () => {
  it('refuses to recalculate under an active model that stopped being published, and leaves the score alone', async () => {
    const model = await createPublishedModel('archived later');
    await setActiveModel(model.id);
    const leadId = await createLead('scored then archived', { company: 'Acme', industry: 'Software' });

    const good = write(await recalculate(leadId));
    createdRecordIds.push(good.evaluationId);
    expect(good.evaluation.scoreValue).toBe(50);

    const archived = await call('POST', '/api/v1/LeadScore/action/model/archive', { modelId: model.id });
    expect(archived.status).toBe(200);
    const afterArchive = await recalculate(leadId);
    expect(afterArchive.status).toBe(409);
    expect(errorOf(afterArchive).code).toBe('LEADSCORE_NO_ACTIVE_MODEL');
    expect(errorOf(afterArchive).details['modelStatus']).toBe('archived');

    // The fast off-switch plan §9.3 asks for leaves history and projection untouched: what is displayed is
    // still the score the archived version produced, and the evaluation still names it.
    const lead = await readLead(leadId);
    expect(lead.body['scoreValue']).toBe(50);
    expect(lead.body['scoreStatus']).toBe('current');
    expect(lead.body['scoreModelVersion']).toBe(1);
    const row = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', good.evaluationId).executeTakeFirst();
    expect((row?.attrs as Body)['modelId']).toBe(model.id);
  });

  it('writes a failed evaluation as a visible state when the engine could not compute — and says what it did', async () => {
    // Not exercised through a published model on purpose: 19-LS.3 refuses to publish a rule the engine would
    // have to fail on, and a published version is immutable, so an API-level `failed` row needs the metadata
    // underneath a version to change. The state itself is the engine's, asserted in
    // `lead-score-evaluator.test.ts` (`scoreValue: null` + `resultState: 'failed'`), and LS.5's contract is
    // that such a run is *stored* as `failed` with the number cleared rather than swallowed — the mapping is
    // exercised here against a draft-selected model so the branch is not left untested by claim alone.
    const model = await createPublishedModel('failure shape');
    await setActiveModel(model.id);
    const leadId = await createLead('blank lead', {});

    // No field the model reads is filled in on this Lead. That is not a failure and it is not uniform: the
    // completeness rule *can* answer that the company is missing (definitely `not_matched`), while the
    // industry comparison cannot answer at all. LS.4's three states, now arriving from stored records.
    const result = write(await recalculate(leadId));
    createdRecordIds.push(result.evaluationId);
    expect(result.evaluation.resultState).toBe('success');
    expect(result.evaluation.scoreValue).toBe(20);
    expect(result.evaluation.coverage).toBe(0.3333);
    expect(result.evaluation.unknownReasonCodes).toEqual([model.industryCode]);

    const lead = await readLead(leadId);
    expect(lead.body['scoreStatus']).toBe('current');
    expect(lead.body['scoreCoverage']).toBe(0.3333);
    expect(JSON.parse(String(lead.body['scoreReasonCodes']))).toEqual([model.industryCode]);
  });
});
