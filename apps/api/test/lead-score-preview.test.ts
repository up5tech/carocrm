import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.4 — the deterministic engine admitted through a real, side-effect-free door
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §8.1, §9.2, §9.4, §15.2 stage 3; audit §5, §11; report
 * `docs/implementation/lead-score-ls4-completion-report.md`).
 *
 * `lead-score-evaluator.test.ts` already pins the arithmetic. What only an API run can prove is the three
 * promises plan §15.2 stage 3 rests on, and each has its own group here:
 *
 * - **a preview writes nothing.** Not a projection on the Lead, not an evaluation row, not an audit entry,
 *   not even the Lead's own `modifiedAt` — §6.1 says a preview "without modifying current scores", and the
 *   only proof worth having is that the stored rows are byte-identical afterwards;
 * - **the sample is the caller's own.** Leads come from the core list path, so record ACL decides which rows
 *   are scored and field ACL decides which signals are known. A reader who may not see `company` gets an
 *   `unknown` reason, not a borrowed value;
 * - **the answer carries no Lead data.** A score model must not become an export path around Lead ACL
 *   (§9.2), so the response holds ids, scores, bands, codes and signatures — and the asserted absence of the
 *   company text it read.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No test database, no reset, no truncate.
 * `afterAll` restores the `leadScore` settings row from the raw column and removes this run's leads, model,
 * rules, role and users by exact id.
 */

const RUN = `AGENT_TEST_LS4_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODEL = 'LeadScoreModel';
const RULE = 'LeadScoreRule';
const PREVIEW_PATH = '/api/v1/LeadScore/action/model/preview';

let ctx: ApiContext;
let previousSettings: string | null = null;
const createdRecordIds: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface PreviewView {
  model: Body;
  inputFields: string[];
  sample: { bound: number; selected: number; scored: number; notReadable: number };
  distribution: { bands: Record<string, number>; min: number | null; max: number | null; average: number | null };
  writes: boolean;
  results: {
    leadId: string;
    modelId: string;
    modelVersion: number;
    recordId: string;
    scoreValue: number | null;
    band: string;
    bandSource: string;
    coverage: number;
    resultState: string;
    delta: number;
    positiveReasonCodes: string[];
    unknownReasonCodes: string[];
    skippedReasonCodes: string[];
    errorCodes: string[];
    readFields: string[];
    ruleEvaluations: { ruleId: string; reasonCode: string; outcome: string; points: number }[];
    signature: string;
    inputsHash: string;
    sourceRevision: number;
    inputsAsOf: string | null;
  }[];
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

/** A model with the shape an administrator would give a first ICP fit: base 20, one 10-point fit rule. */
async function createModel(name: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return createRecord(MODEL, {
    name: `${RUN} ${name}`,
    description: 'Draft model for the LS.4 preview suite.',
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
    allowedFieldPaths: JSON.stringify(['company', 'industry', 'status']),
    ...overrides,
  });
}

function companyRule(modelId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${RUN} company rule`,
    modelId,
    modelVersion: 1,
    reasonCode: `ls4_company_${modelId.slice(-6)}`,
    dimension: 'completeness',
    enabled: true,
    condition: JSON.stringify({ field: 'company', operator: 'isNotEmpty' }),
    effect: 'add',
    points: 10,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
    ...overrides,
  };
}

async function createLead(name: string, data: Record<string, unknown>): Promise<string> {
  return createRecord('Lead', { name: `${RUN} ${name}`, lastName: `${RUN} ${name}`, ...data });
}

async function preview(modelId: string, extra: Record<string, unknown> = {}, token?: string): Promise<CallResult> {
  return call('POST', PREVIEW_PATH, { modelId, ...extra }, token);
}

function view(result: CallResult): PreviewView {
  return result.body as unknown as PreviewView;
}

async function evaluationCount(): Promise<number> {
  const rows = await ctx.database.db.selectFrom('entity_records').select('id').where('entity_type', '=', 'LeadScoreEvaluation').execute();
  return rows.length;
}

async function auditCount(recordIds: readonly string[]): Promise<number> {
  if (recordIds.length === 0) return 0;
  const rows = await ctx.database.db.selectFrom('audit_log').select('id').where('record_id', 'in', [...recordIds]).execute();
  return rows.length;
}

async function enablePreview(): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', {
    enabled: true,
    features: { modelAdministration: true, scoringPreview: true },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

function industryRule(modelId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return companyRule(modelId, {
    name: `${RUN} industry rule`,
    reasonCode: `ls4_industry_${modelId.slice(-6)}`,
    dimension: 'fit',
    condition: JSON.stringify({ field: 'industry', operator: 'equals', value: 'Software' }),
    points: 20,
    priority: 20,
    ...overrides,
  });
}

describe('a preview scores a bounded authorized sample and writes nothing (19-LS.4 acceptance)', () => {
  it('derives the score the engine promises, per Lead, from the stored records', async () => {
    await enablePreview();
    const modelId = await createModel('derives');
    const companyCode = `ls4_company_${modelId.slice(-6)}`;
    const industryCode = `ls4_industry_${modelId.slice(-6)}`;
    await createRecord(RULE, companyRule(modelId));
    await createRecord(RULE, industryRule(modelId));
    const softwareCo = await createLead('software company', { company: 'Acme Software', industry: 'Software' });
    const noIndustry = await createLead('blank industry', { company: 'Acme' });

    const result = await preview(modelId, { leadIds: [softwareCo, noIndustry] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = view(result);
    expect(body.writes).toBe(false);
    expect(body.results).toHaveLength(2);
    expect(body.inputFields).toEqual(['company', 'industry']);
    expect(body.sample).toEqual({ bound: 25, selected: 2, scored: 2, notReadable: 0 });

    const matched = body.results.find((entry) => entry.leadId === softwareCo);
    // base 20 + 10 for a company + 20 for the target industry → 50, inside Warm.
    expect(matched?.scoreValue).toBe(50);
    expect(matched?.band).toBe('Warm');
    expect(matched?.bandSource).toBe('threshold');
    expect(matched?.coverage).toBe(1);
    expect(matched?.positiveReasonCodes).toEqual([industryCode, companyCode].sort());
    expect(matched?.readFields).toEqual(['company', 'industry']);
    expect(matched?.modelId).toBe(modelId);
    expect(matched?.modelVersion).toBe(1);
    expect(matched?.sourceRevision).toBeGreaterThan(0);

    const partial = body.results.find((entry) => entry.leadId === noIndustry);
    // The company answers definitely; the industry the Lead never carried does not. Missing is not negative:
    // the rule adds nothing rather than subtracting, and the hole shows in coverage and in the unknown codes.
    expect(partial?.scoreValue).toBe(30);
    expect(partial?.band).toBe('Cold');
    expect(partial?.coverage).toBe(0.3333);
    expect(partial?.unknownReasonCodes).toEqual([industryCode]);
    expect(partial?.positiveReasonCodes).toEqual([companyCode]);
    expect(body.distribution.bands).toEqual({ Warm: 1, Cold: 1 });
    expect(body.distribution.min).toBe(30);
    expect(body.distribution.max).toBe(50);
    expect(body.distribution.average).toBe(40);
  });

  it('leaves the database exactly as it found it', async () => {
    await enablePreview();
    const modelId = await createModel('side effect free');
    await createRecord(RULE, companyRule(modelId));
    const leadId = await createLead('untouched', { company: 'Acme' });

    const before = await call('GET', `/api/v1/Lead/${leadId}`);
    const evaluationsBefore = await evaluationCount();
    const auditBefore = await auditCount([leadId, modelId]);

    expect((await preview(modelId, { leadIds: [leadId] })).status).toBe(200);
    expect((await preview(modelId, { leadIds: [leadId] })).status).toBe(200);

    const after = await call('GET', `/api/v1/Lead/${leadId}`);
    // The projection fields stay absent and `modifiedAt`/`version` are untouched, so the Lead row itself did
    // not move — a preview that quietly recalculated would be visible right here (plan §6.1).
    for (const field of ['id', 'modifiedAt', 'version', 'scoreValue', 'scoreBand', 'scoreStatus', 'scoreModelId', 'scoreCoverage', 'scoreReasonCodes']) {
      expect(after.body[field], field).toEqual(before.body[field]);
    }
    expect(await evaluationCount()).toBe(evaluationsBefore);
    expect(await auditCount([leadId, modelId])).toBe(auditBefore);

    // The model is still the draft it was: previewing does not publish or stamp it.
    const model = await call('GET', `/api/v1/${MODEL}/${modelId}`);
    expect(model.body['status']).toBe('draft');
    expect(model.body['publishedAt'] ?? null).toBeNull();
  });

  it('answers the same signature for the same data, twice in a row', async () => {
    await enablePreview();
    const modelId = await createModel('repeatable');
    await createRecord(RULE, companyRule(modelId));
    const leadId = await createLead('stable', { company: 'Acme', industry: 'Software' });

    const first = view(await preview(modelId, { leadIds: [leadId] })).results[0];
    const second = view(await preview(modelId, { leadIds: [leadId] })).results[0];
    expect(second?.signature).toBe(first?.signature);
    expect(second?.inputsHash).toBe(first?.inputsHash);
    expect(second?.scoreValue).toBe(first?.scoreValue);

    // And a changed signal is a different signature, which is how a rebuild can prove it moved.
    await call('PATCH', `/api/v1/Lead/${leadId}`, { company: 'Other Co' });
    const third = view(await preview(modelId, { leadIds: [leadId] })).results[0];
    expect(third?.signature).not.toBe(first?.signature);
  });

  it('names no Lead value in the answer', async () => {
    await enablePreview();
    const modelId = await createModel('no values');
    await createRecord(RULE, companyRule(modelId, { points: 15 }));
    const leadId = await createLead('secret company', { company: 'Confidential Corp' });

    const result = await preview(modelId, { leadIds: [leadId] });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain('Confidential Corp');
    expect(view(result).results[0]?.scoreValue).toBe(35);
  });

  it('bounds the work a preview may ask for (plan §9.4)', async () => {
    await enablePreview();
    const modelId = await createModel('bounded');
    await createRecord(RULE, companyRule(modelId));

    const tooMany = await preview(modelId, { leadIds: Array.from({ length: 26 }, (_unused, index) => `lead-${index}`) });
    expect(tooMany.status).toBeGreaterThanOrEqual(400);
    expect(tooMany.status).toBeLessThan(500);

    // `maxSize` narrows the sample and can never widen it.
    expect((await preview(modelId, { maxSize: 0 })).status).toBeGreaterThanOrEqual(400);
    expect((await preview(modelId, { maxSize: 26 })).status).toBeGreaterThanOrEqual(400);
    const narrowed = await preview(modelId, { maxSize: 1 });
    expect(narrowed.status).toBe(200);
    expect(view(narrowed).results.length).toBeLessThanOrEqual(1);
  });
});

describe('the sample is the caller’s own (plan §6.5, §9.1–§9.2)', () => {
  it('scores only the Leads this caller may read, and does not say which ones they missed', async () => {
    await enablePreview();
    const modelId = await createModel('record acl');
    await createRecord(RULE, companyRule(modelId));
    const theirs = await createLead('theirs', { company: 'Other Ltd' });
    const mine = await createLead('mine', { company: 'Acme' });

    const roleId = `role_${RUN}_own`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} own leads`,
      permissions: {
        Lead: { read: 'own' },
        LeadScore: { read: 'yes' },
        LeadScoreModel: { read: 'yes', edit: 'yes' },
        LeadScoreRule: { read: 'yes', edit: 'yes' },
      },
    });
    const owner = await createTestUser(ctx, { userName: `${RUN}_owner`, roleIds: [roleId] });
    // Assign the Lead to the caller through the core path, so `own` is a real record predicate.
    expect((await call('PATCH', `/api/v1/Lead/${mine}`, { assignedUserId: owner.id })).status).toBe(200);

    const result = await preview(modelId, { leadIds: [mine, theirs] }, owner.token);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = view(result);
    expect(body.results.map((entry) => entry.leadId)).toEqual([mine]);
    expect(body.sample.notReadable).toBe(1);
    // The id the caller cannot read is not named, and its score is not computed.
    expect(JSON.stringify(result.body)).not.toContain(theirs);
  });

  it('turns a field the caller may not read into an unknown signal, not a borrowed value', async () => {
    await enablePreview();
    const modelId = await createModel('field acl');
    await createRecord(RULE, companyRule(modelId));
    const leadId = await createLead('hidden company', { company: 'Acme' });

    const roleId = `role_${RUN}_hidden`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} no company`,
      permissions: {
        Lead: { read: 'all' },
        LeadScore: { read: 'yes' },
        LeadScoreModel: { read: 'yes', edit: 'yes' },
        LeadScoreRule: { read: 'yes', edit: 'yes' },
      },
      fieldPermissions: { Lead: { company: { read: 'no', edit: 'no' } } },
    });
    const limited = await createTestUser(ctx, { userName: `${RUN}_limited`, roleIds: [roleId] });

    const body = view(await preview(modelId, { leadIds: [leadId] }, limited.token));
    expect(body.results).toHaveLength(1);
    // The rule still exists, its signal does not: the score rests at base with the hole visible.
    expect(body.results[0]?.scoreValue).toBe(20);
    expect(body.results[0]?.coverage).toBe(0);
    expect(body.results[0]?.unknownReasonCodes).toHaveLength(1);
    // The administrator who can read the field sees the point the limited reader could not.
    const adminView = view(await preview(modelId, { leadIds: [leadId] }));
    expect(adminView.results[0]?.scoreValue).toBe(30);
  });

  it('refuses a caller who may not manage models', async () => {
    await enablePreview();
    const modelId = await createModel('refused');
    await createRecord(RULE, companyRule(modelId));

    const roleId = `role_${RUN}_viewonly`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} score viewer`, permissions: { LeadScore: { read: 'yes' } } });
    const viewer = await createTestUser(ctx, { userName: `${RUN}_viewer`, roleIds: [roleId] });

    const denied = await preview(modelId, {}, viewer.token);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details['capability']).toBe('modelManage');
  });
});

describe('the preview is the door 19-LS.4 opened, and only that door', () => {
  it('reports every recalculation path as delivered and names what still waits', async () => {
    const health = await call('GET', '/api/v1/LeadScore/action/health');
    const body = health.body as unknown as {
      module: { implementedPhases: string[] };
      features: { key: string; implemented: boolean; effective: boolean; pendingPhase: string | null }[];
      operations: { operation: string; admitted: boolean; feature: string; pendingPhase: string | null }[];
      checks: { name: string; ok: boolean; detail: string }[];
    };
    expect(body.module.implementedPhases).toContain('19-LS.4');
    expect(body.features.find((feature) => feature.key === 'scoringPreview')?.pendingPhase).toBeNull();
    // 19-LS.5 kept the score, so `scoring` is no longer waiting on anything.
    expect(body.features.find((feature) => feature.key === 'scoring')?.pendingPhase).toBeNull();
    expect(body.features.find((feature) => feature.key === 'scoreExplanation')?.pendingPhase).toBeNull();
    expect(body.operations.find((operation) => operation.operation === 'previewModel')?.feature).toBe('scoringPreview');
    // 19-LS.4 proved the engine, 19-LS.5 kept a score and 19-LS.6 put both background paths behind it, so no
    // recalculation door names a pending phase any more.
    for (const feature of ['manualRecalculation', 'eventRecalculation', 'batchRecalculation']) {
      expect(body.features.find((entry) => entry.key === feature)?.pendingPhase, feature).toBeNull();
    }
    for (const operation of ['recalculateLead', 'eventRecalculate', 'batchRecalculate']) {
      expect(body.operations.find((entry) => entry.operation === operation)?.pendingPhase, operation).toBeNull();
    }
    // What still waits, waits loudly: a band-change notification is 19-LS.9's, and health says so.
    const waiting = body.operations.find((operation) => operation.operation === 'aiInsight');
    expect(waiting?.pendingPhase).toBe('19-LS.17');
    // The engine-health check is computed from the two operator lists, so it can fail on a real drift.
    const engine = body.checks.find((check) => check.name === 'scoring-engine');
    expect(engine?.ok).toBe(true);
    expect(engine?.detail).toContain('criteria operators');
  });

  it('refuses a preview while its switch is off, and admits it once it is on', async () => {
    const modelId = await createModel('switched');
    await createRecord(RULE, companyRule(modelId));
    const leadId = await createLead('switched lead', { company: 'Acme' });

    await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { modelAdministration: true, scoringPreview: false } });
    const off = await preview(modelId, { leadIds: [leadId] });
    expect(off.status).toBe(403);
    expect(errorOf(off).code).toBe('LEADSCORE_MODULE_DISABLED');
    expect(JSON.stringify(off.body)).toContain('scoringPreview');

    const probe = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation: 'previewModel' });
    expect((probe.body as Body)['admitted']).toBe(false);

    await enablePreview();
    const on = await preview(modelId, { leadIds: [leadId] });
    expect(on.status).toBe(200);
    expect(view(on).results[0]?.scoreValue).toBe(30);
    const admitted = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation: 'previewModel' });
    expect((admitted.body as Body)['admitted']).toBe(true);
    expect((admitted.body as Body)['pendingPhase']).toBeNull();
  });

  it('publishes the preview route in the generated OpenAPI document (plan §8.4)', async () => {
    const result = await call('GET', '/api/v1/OpenApi');
    const paths = (result.body as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(Object.keys(paths['/api/v1/LeadScore/action/model/preview'] ?? {})).toContain('post');
  });

  it('asks the core Lead read ACL for its sample, and never invents one', async () => {
    await enablePreview();
    const modelId = await createModel('no lead read');
    await createRecord(RULE, companyRule(modelId));
    const leadId = await createLead('invisible to the caller', { company: 'Acme' });

    const roleId = `role_${RUN}_noleadread`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} models but no leads`,
      // Model rights without Lead rights: the preview has to fail the way any Lead read would, because its
      // sample comes from the core list path rather than from a module-owned query (plan §4.4, §9.2).
      permissions: { LeadScore: { read: 'yes' }, LeadScoreModel: { read: 'yes', edit: 'yes' }, LeadScoreRule: { read: 'yes', edit: 'yes' } },
    });
    const caller = await createTestUser(ctx, { userName: `${RUN}_nolead`, roleIds: [roleId] });

    const result = await preview(modelId, { leadIds: [leadId] }, caller.token);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain(leadId);
    expect(result.body['results']).toBeUndefined();
  });
});

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
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
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score preview suite left records behind');
  const settingsRow = await db.selectFrom('app_settings').select('name').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  if (previousSettings === null && settingsRow !== undefined) console.warn({ run: RUN }, 'leadScore settings row survived the suite');

  await shutdownApi();
}, 240_000);
