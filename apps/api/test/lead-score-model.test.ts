import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthenticatedPrincipal, REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import { runAsLeadScoreInternal } from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.3 — the score model lifecycle: validate, publish, archive, new version
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §9.1, §16 `19-LS.3`; audit §5.1; report
 * `docs/implementation/lead-score-ls3-completion-report.md`).
 *
 * The phase's exit criterion is two sentences, and each gets its own group of assertions:
 *
 * - **invalid models cannot be published** — the publish command re-runs validation and refuses with the
 *   full issue list, so an editor cannot skip the `validate` call, and a rule that was edited after a good
 *   validation cannot sneak through;
 * - **published versions are immutable** — enforced in the storage path, not the UI: a client, an
 *   administrator included, cannot change a frozen model or the rules attached to it, and the only way
 *   forward is a new version that leaves the old one byte-identical.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No test database, no reset, no truncate.
 * `afterAll` restores the `leadScore` settings row from the raw column, removes this run's model, rule and
 * Lead rows by exact id, and deletes the role and users it created. Publishing and archiving must also
 * provably **not** score anything: a score is a later phase's decision, so no evaluation row may appear
 * and no Lead may gain a projection attribute because a model was published.
 */

const RUN = `AGENT_TEST_LS3_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODEL = 'LeadScoreModel';
const RULE = 'LeadScoreRule';

let ctx: ApiContext;
let previousSettings: string | null = null;
let adminPrincipal: AuthenticatedPrincipal | undefined;
const createdRecordIds: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface Report {
  readonly valid: boolean;
  readonly errors: { code: string; path: string; message: string; ruleId?: string }[];
  readonly warnings: { code: string; path: string; message: string; ruleId?: string }[];
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

function crud(): EntityCrudService {
  return ctx.app.get(EntityCrudService, { strict: false });
}

/** A write as a Lead Score command performs it: a principal in scope and the module marker set. */
function writeAsModule<T>(work: () => Promise<T>): Promise<T> {
  const scope = ctx.app.get(REQUEST_SCOPE_TOKEN, { strict: false }) as RequestScope;
  if (adminPrincipal === undefined) throw new Error('the admin principal was not resolved before this write');
  return scope.runAs(adminPrincipal, () => runAsLeadScoreInternal(work));
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  expect(id).not.toBe('');
  createdRecordIds.push(id);
  return id;
}

/** A model draft, created the way an administrator creates one: the generic entity API. */
async function createModel(name: string, version: number, overrides: Record<string, unknown> = {}): Promise<string> {
  return createRecord(MODEL, {
    name: `${RUN} ${name}`,
    description: 'Draft model for the LS.3 lifecycle suite.',
    modelVersion: version,
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
    // Real Lead fields only: `allowedFieldPaths` names fields of the scored entity, and the validator says
    // so when a model grants a path the metadata does not declare.
    allowedFieldPaths: JSON.stringify(['company', 'industry', 'status', 'emailAddress']),
    ...overrides,
  });
}

const VALID_CONDITION = JSON.stringify({ all: [{ field: 'company', operator: 'isNotEmpty' }] });

async function createRule(modelId: string, version: number, overrides: Record<string, unknown> = {}): Promise<string> {
  return createRecord(RULE, {
    name: `${RUN} rule`,
    modelId,
    modelVersion: version,
    reasonCode: `company_known_${modelId.slice(-6)}`,
    dimension: 'completeness',
    enabled: true,
    condition: VALID_CONDITION,
    effect: 'add',
    points: 10,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
    ...overrides,
  });
}

async function validate(modelId: string, token?: string): Promise<CallResult> {
  return call('POST', '/api/v1/LeadScore/action/model/validate', { modelId }, token);
}

async function publish(modelId: string, extra: Record<string, unknown> = {}, token?: string): Promise<CallResult> {
  return call('POST', '/api/v1/LeadScore/action/model/publish', { modelId, ...extra }, token);
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const admin = await ctx.database.db.selectFrom('users').select(['id', 'user_name']).where('is_admin', '=', true).limit(1).executeTakeFirst();
  if (admin !== undefined) {
    adminPrincipal = { userId: admin.id, userName: admin.user_name, userType: 'admin', roles: [], teams: [] };
  }
  // The lifecycle is a feature an administrator switches on (plan §15.2 stages 2–4).
  expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { modelAdministration: true } })).status).toBe(200);
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
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score lifecycle suite left records behind');

  await shutdownApi();
}, 240_000);

describe('validation command (19-LS.3)', () => {
  it('answers with the model’s problems without writing anything', async () => {
    const modelId = await createModel('validating', 1);
    await createRule(modelId, 1, { reasonCode: 'Bad Code' });

    const result = await validate(modelId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const report = result.body as unknown as Report;
    expect(report.valid).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toContain('LS_RULE_REASON_CODE_INVALID');

    // Read-only by construction: the model is still a draft and no evaluation was stored for it. From
    // 19-LS.5 on, evaluation rows are an ordinary thing to find in this database, so the claim names whose
    // history is absent instead of counting the whole table.
    const stored = await call('GET', `/api/v1/${MODEL}/${modelId}`);
    expect(stored.body['status']).toBe('draft');
    const evaluations = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'LeadScoreEvaluation')
      .where((eb) => eb(sql`attrs ->> 'modelId'`, '=', modelId))
      .execute();
    expect(evaluations).toEqual([]);
  });

  it('refuses a condition that is not declarative, and reports the rule it belongs to', async () => {
    const modelId = await createModel('formula', 1);
    const ruleId = await createRule(modelId, 1, { condition: 'ifThen(equals(field("industry"), "Software"), 20, 0)' });

    const report = (await validate(modelId)).body as unknown as Report;
    expect(report.valid).toBe(false);
    const codes = report.errors.map((issue) => issue.code);
    expect(codes).toContain('LS_CONDITION_NOT_JSON');
    expect(report.errors.find((issue) => issue.code === 'LS_CONDITION_NOT_JSON')?.ruleId).toBe(ruleId);
  });

  it('lists every problem at once so one call is enough to fix a draft', async () => {
    const modelId = await createModel('many problems', 1, { scoreCeiling: 500, qualificationBands: '', dimensionWeights: '{oops' });
    await createRule(modelId, 1, { points: 900, condition: JSON.stringify({ field: 'monthlyRevenue', operator: 'isNotEmpty' }) });

    const report = (await validate(modelId)).body as unknown as Report;
    expect(report.errors.length).toBeGreaterThanOrEqual(4);
    for (const code of ['LS_MODEL_BOUNDS_INVALID', 'LS_MODEL_BANDS_EMPTY', 'LS_MODEL_WEIGHTS_INVALID_JSON', 'LS_RULE_POINTS_OUT_OF_BOUNDS', 'LS_CONDITION_FIELD_UNKNOWN']) {
      expect(report.errors.map((issue) => issue.code), code).toContain(code);
    }
    for (const issue of report.errors) {
      expect(issue.message.length, issue.code).toBeGreaterThan(10);
      expect(issue.path.length, issue.code).toBeGreaterThan(0);
    }
  });

  it('refuses a caller who may not manage models, and a model that is not theirs to read', async () => {
    const modelId = await createModel('gated', 1);
    const roleId = `role_${RUN}_viewer`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} viewer role`, permissions: { LeadScore: { read: 'yes' } } });
    const viewer = await createTestUser(ctx, { userName: `${RUN}_viewer`, roleIds: [roleId] });

    const denied = await validate(modelId, viewer.token);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details['capability']).toBe('modelManage');

    // A caller with no rights at all cannot even learn whether the id is a model.
    const roleId2 = `role_${RUN}_none`;
    await createTestRole(ctx, { id: roleId2, name: `${RUN} empty role`, permissions: {} });
    const nobody = await createTestUser(ctx, { userName: `${RUN}_nobody`, roleIds: [roleId2] });
    expect((await validate(modelId, nobody.token)).status).toBe(403);
  });
});

describe('publish refuses what validation refuses (19-LS.3 acceptance)', () => {
  it('refuses an invalid model with its issue list, and leaves it a draft', async () => {
    const modelId = await createModel('unpublishable', 1);
    await createRule(modelId, 1, { points: 500, reasonCode: 'fine_code' });

    const result = await publish(modelId);
    expect(result.status).toBe(422);
    const failure = errorOf(result);
    expect(failure.code).toBe('VALIDATION_FAILED');
    const issues = failure.details['issues'] as { code: string }[];
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.map((issue) => issue.code)).toContain('LS_RULE_POINTS_OUT_OF_BOUNDS');

    const stored = await call('GET', `/api/v1/${MODEL}/${modelId}`);
    expect(stored.body['status']).toBe('draft');
    expect(stored.body['publishedAt'] ?? null).toBeNull();
  });

  it('refuses a model whose rules describe a different version, and warns about one that scores nothing', async () => {
    // A stored evaluation names (modelId, modelVersion). Rules carrying another version would make a
    // published version's rule set ambiguous, so the publish command refuses it (plan §3.1, §5.1).
    const mismatched = await createModel('mismatched rules', 5);
    await createRule(mismatched, 4, { reasonCode: 'wrong_version' });
    const refused = await publish(mismatched);
    expect(refused.status).toBe(422);
    expect(((errorOf(refused).details['issues'] ?? []) as { code: string }[]).map((issue) => issue.code)).toContain('LS_RULE_MODEL_VERSION_MISMATCH');

    // An empty model is valid but pointless: that distinction is a warning, not a block, and the answer
    // says so rather than failing silently later (plan §6.1 "errors/warnings").
    const ruleless = await createModel('rule-less', 1);
    const report = (await validate(ruleless)).body as unknown as Report;
    expect(report.valid).toBe(true);
    expect(report.warnings.map((issue) => issue.code)).toContain('LS_MODEL_HAS_NO_ENABLED_RULES');
  });

  it('refuses a second publication of the same version, and a publication of an archived one', async () => {
    const modelId = await createModel('publishable', 1);
    await createRule(modelId, 1);
    expect((await publish(modelId)).status).toBe(200);

    const again = await publish(modelId);
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('LEADSCORE_INVALID_STATE');

    const archived = await createModel('to archive', 2);
    await createRule(archived, 2);
    expect((await call('POST', '/api/v1/LeadScore/action/model/archive', { modelId: archived })).status).toBe(200);
    const publishArchived = await publish(archived);
    expect(publishArchived.status).toBe(409);
    expect(errorOf(publishArchived).details['state']).toBe('archived');
  });

  it('honours the concurrency token so two hands cannot freeze two different drafts of one version', async () => {
    const modelId = await createModel('contended', 3);
    await createRule(modelId, 3);
    const loaded = await call('GET', `/api/v1/${MODEL}/${modelId}`);
    const staleVersion = Number(loaded.body['version'] ?? 1);

    expect((await publish(modelId, { expectedVersion: staleVersion })).status).toBe(200);
    const replayed = await publish(modelId, { expectedVersion: staleVersion });
    // The first publish wins; the second cannot stomp it — and the refusal is a state conflict, which is
    // also what a lost race between two administrators looks like (plan §7.8's concurrency story).
    expect(replayed.status).toBe(409);
    expect(errorOf(replayed).code).toBe('LEADSCORE_INVALID_STATE');
  });
});

describe('a published version is immutable (19-LS.3 acceptance)', () => {
  it('refuses every client write to the model and to the rules attached to it', async () => {
    const modelId = await createModel('frozen', 1);
    const ruleId = await createRule(modelId, 1);
    expect((await publish(modelId)).status).toBe(200);

    const writes: ['PATCH' | 'POST' | 'DELETE', string, Body][] = [
      ['PATCH', `/api/v1/${MODEL}/${modelId}`, { description: 'trying to edit a frozen version' }],
      ['PATCH', `/api/v1/${MODEL}/${modelId}`, { status: 'draft' }],
      ['PATCH', `/api/v1/${MODEL}/${modelId}`, { modelVersion: 9 }],
      ['PATCH', `/api/v1/${RULE}/${ruleId}`, { points: 40 }],
      ['DELETE', `/api/v1/${RULE}/${ruleId}`, {}],
      ['POST', `/api/v1/${RULE}`, { name: `${RUN} smuggled rule`, modelId, modelVersion: 1, reasonCode: 'smuggled', condition: VALID_CONDITION, points: 50, priority: 1, missingDataPolicy: 'neutral', signalSource: 'lead', dimension: 'fit', enabled: true, effect: 'add' }],
    ];
    for (const [method, url, payload] of writes) {
      const result = await call(method, url, method === 'DELETE' ? undefined : payload);
      expect(result.status, `${method} ${url} ${JSON.stringify(result.body)}`).toBe(409);
      expect(errorOf(result).code, url).toBe('LEADSCORE_MODEL_IMMUTABLE');
    }

    // A published model cannot be deleted either — here by the kernel's own `record.removable: false`
    // rule, with the module's delete guard behind it, so neither a metadata change nor a guard gap can
    // open that door (19-LS.2 §1.3).
    const deleted = await call('DELETE', `/api/v1/${MODEL}/${modelId}`);
    expect(deleted.status).toBe(422);
    expect(JSON.stringify(deleted.body)).toContain('cannot be deleted');

    // Nothing changed: the rules that a stored evaluation names are still the ones that were published.
    const rules = await call('GET', `/api/v1/${MODEL}/${modelId}/rules`);
    const list = (rules.body as { list?: Body[] }).list ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.['points']).toBe(10);
  });

  it('refuses a client that claims publication by writing status or the stamps directly', async () => {
    const modelId = await createModel('self-published', 1);
    await createRule(modelId, 1);

    for (const payload of [{ status: 'published' }, { publishedAt: new Date().toISOString() }, { publishedById: 'someoneelse' }]) {
      const result = await call('PATCH', `/api/v1/${MODEL}/${modelId}`, payload);
      expect(result.status, JSON.stringify(result.body)).toBe(422);
      expect(errorOf(result).details['fields']).toBeDefined();
    }

    // Publishing is the command, and the command validates first — which is why the stamp fields are owned
    // even while a row is still a draft (plan §6.1).
    const created = await call('POST', `/api/v1/${MODEL}`, { name: `${RUN} claimed published`, modelVersion: 7, status: 'published' });
    expect(created.status).toBe(422);
    expect(errorOf(created).details['fields']).toEqual(['status']);
  });

  it('leaves the score untouched: no evaluation row and no Lead projection appears because a model was published', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} unscored`, lastName: `${RUN} unscored`, company: 'Acme' });
    const modelId = await createModel('no side effect', 1);
    await createRule(modelId, 1);

    const evaluationsBefore = await ctx.database.db.selectFrom('entity_records').select('id').where('entity_type', '=', 'LeadScoreEvaluation').execute();
    expect((await publish(modelId)).status).toBe(200);
    const evaluationsAfter = await ctx.database.db.selectFrom('entity_records').select('id').where('entity_type', '=', 'LeadScoreEvaluation').execute();
    expect(evaluationsAfter.length).toBe(evaluationsBefore.length);

    const lead = await call('GET', `/api/v1/Lead/${leadId}`);
    // "Not scored" is carried honestly: `scoreBand`/`scoreStatus` take their declared defaults on create,
    // so a Lead reads Unknown / not_scored, while the fields that would *claim* an evaluation — a value, a
    // model, a timestamp — stay absent. Plan §15.1 forbids a publication from scoring history.
    for (const field of ['scoreValue', 'scoreModelId', 'scoreModelVersion', 'scoreCalculatedAt', 'scoreInputsAsOf', 'scorePreviousValue', 'scoreCoverage', 'scoreReasonCodes']) {
      expect(lead.body[field] ?? null, field).toBeNull();
    }
    expect(lead.body['scoreBand']).toBe('Unknown');
    expect(lead.body['scoreStatus']).toBe('not_scored');
    // Plan §15.1: publishing does not silently recalculate anything — the absent projection above is the
    // proof. A recalculation stays an explicit request or an explicit rebuild: 19-LS.5 delivered the one-Lead
    // command, and 19-LS.6 the queued job and the batch rebuild behind it. All three switches are left off in
    // this suite, so each refuses as a switch rather than as a missing phase.
    for (const operation of ['recalculateLead', 'eventRecalculate', 'batchRecalculate']) {
      const gate = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation });
      expect((gate.body as { pendingPhase: string | null }).pendingPhase, operation).toBeNull();
      expect((gate.body as { admitted: boolean; code: string }).admitted, operation).toBe(false);
      expect((gate.body as { code: string }).code, operation).toBe('LEADSCORE_MODULE_DISABLED');
    }
  });
});

describe('new version and archive (19-LS.3)', () => {
  it('copies a published model into an editable draft, leaving the frozen version byte-identical', async () => {
    const modelId = await createModel('to revise', 1);
    const ruleId = await createRule(modelId, 1, { points: 12, reasonCode: 'company_present' });
    expect((await publish(modelId)).status).toBe(200);
    const before = await call('GET', `/api/v1/${MODEL}/${modelId}`);
    const beforeRules = await call('GET', `/api/v1/${MODEL}/${modelId}/rules`);

    const created = await call('POST', '/api/v1/LeadScore/action/model/new-version', { modelId });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const draftId = String((created.body as Body)['id'] ?? '');
    expect(draftId).not.toBe('');
    createdRecordIds.push(draftId);
    expect((created.body as Body)['status']).toBe('draft');
    expect((created.body as Body)['modelVersion']).toBe(2);

    const copied = await call('GET', `/api/v1/${MODEL}/${draftId}/rules`);
    const copyList = (copied.body as { list?: Body[] }).list ?? [];
    expect(copyList).toHaveLength(1);
    expect(copyList[0]?.['reasonCode']).toBe('company_present');
    expect(copyList[0]?.['points']).toBe(12);
    expect(copyList[0]?.['modelId']).toBe(draftId);
    expect(copyList[0]?.['modelVersion']).toBe(2);
    const copiedRuleId = String(copyList[0]?.['id'] ?? '');
    if (copiedRuleId !== '') createdRecordIds.push(copiedRuleId);

    // The frozen version is unchanged — this is the property that lets a stored evaluation keep naming it.
    const after = await call('GET', `/api/v1/${MODEL}/${modelId}`);
    expect(after.body['status']).toBe(before.body['status']);
    expect(after.body['modelVersion']).toBe(before.body['modelVersion']);
    expect(after.body['qualificationBands']).toBe(before.body['qualificationBands']);
    const afterRules = await call('GET', `/api/v1/${MODEL}/${modelId}/rules`);
    expect((afterRules.body as { list?: Body[] }).list ?? []).toEqual((beforeRules.body as { list?: Body[] }).list ?? []);
    expect(String(((afterRules.body as { list?: Body[] }).list ?? [])[0]?.['id'] ?? '')).toBe(ruleId);

    // The new draft is editable, which is the point of forking rather than unfreezing.
    const edited = await call('PATCH', `/api/v1/${MODEL}/${draftId}`, { description: 'revised weighting' });
    expect(edited.status).toBe(200);
    expect(await call('PATCH', `/api/v1/${RULE}/${copiedRuleId}`, { points: 18 })).toMatchObject({ status: 200 });
  });

  it('refuses to open a second draft while one is already open', async () => {
    const modelId = await createModel('single draft', 1);
    await createRule(modelId, 1);
    expect((await publish(modelId)).status).toBe(200);

    const first = await call('POST', '/api/v1/LeadScore/action/model/new-version', { modelId });
    expect(first.status).toBe(200);
    const firstDraftId = String((first.body as Body)['id'] ?? '');
    createdRecordIds.push(firstDraftId);

    const second = await call('POST', '/api/v1/LeadScore/action/model/new-version', { modelId });
    expect(second.status).toBe(409);
    expect(errorOf(second).code).toBe('LEADSCORE_DRAFT_EXISTS');
    // The answer names the draft to edit, because "there can only be one" is useless without it.
    expect(errorOf(second).details['draftId']).toBe(firstDraftId);
  });

  it('refuses to copy a draft, which is already the editable version', async () => {
    const modelId = await createModel('already draft', 1);
    const result = await call('POST', '/api/v1/LeadScore/action/model/new-version', { modelId });
    expect(result.status).toBe(409);
    expect(errorOf(result).code).toBe('LEADSCORE_INVALID_STATE');
  });

  it('copies every rule of the version, so a fork is not a half-configured draft', async () => {
    const modelId = await createModel('three rules', 4);
    const fixtures = [
      { reasonCode: 'company_present', dimension: 'fit', points: 10 },
      { reasonCode: 'industry_target', dimension: 'fit', points: 10 },
      { reasonCode: 'status_new', dimension: 'recency', points: -5 },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      await createRule(modelId, 4, {
        name: `${RUN} rule ${fixture.reasonCode}`,
        reasonCode: fixture.reasonCode,
        dimension: fixture.dimension,
        points: fixture.points,
        priority: (index + 1) * 10,
      });
    }
    const publication = await publish(modelId);
    expect(publication.status, JSON.stringify(publication.body)).toBe(200);

    const forked = await call('POST', '/api/v1/LeadScore/action/model/new-version', { modelId });
    expect(forked.status, JSON.stringify(forked.body)).toBe(200);
    const draftId = String((forked.body as Body)['id'] ?? '');
    createdRecordIds.push(draftId);

    const rules = (await call('GET', `/api/v1/${MODEL}/${draftId}/rules`)).body as { list?: Body[] };
    const list = rules.list ?? [];
    expect(list.map((row) => row['reasonCode']).sort()).toEqual(['company_present', 'industry_target', 'status_new']);
    expect(list.map((row) => row['dimension']).sort()).toEqual(['fit', 'fit', 'recency']);
    for (const row of list) {
      expect(row['modelVersion']).toBe(5);
      expect(row['modelId']).toBe(draftId);
      createdRecordIds.push(String(row['id'] ?? ''));
    }
    // The copy validates cleanly, which is the proof that nothing was dropped or renamed on the way.
    const report = (await validate(draftId)).body as unknown as Report;
    expect(report.errors).toEqual([]);
  });

  it('archives a model and refuses to archive it twice', async () => {
    const modelId = await createModel('to archive once', 1);
    await createRule(modelId, 1);
    expect((await publish(modelId)).status).toBe(200);

    const archived = await call('POST', '/api/v1/LeadScore/action/model/archive', { modelId });
    expect(archived.status).toBe(200);
    expect((archived.body as Body)['status']).toBe('archived');
    expect((archived.body as Body)['archivedById']).toBeDefined();

    const twice = await call('POST', '/api/v1/LeadScore/action/model/archive', { modelId });
    expect(twice.status).toBe(409);
    expect(errorOf(twice).code).toBe('LEADSCORE_INVALID_STATE');

    // Archiving is the quick off switch and it destroys nothing: the version and its rules stay readable.
    const rules = (await call('GET', `/api/v1/${MODEL}/${modelId}/rules`)).body as { list?: Body[] };
    expect((rules.list ?? []).length).toBe(1);
  });
});

describe('the lifecycle respects the module switches and rights (19-LS.3)', () => {
  it('refuses every lifecycle command while the module is switched off', async () => {
    const modelId = await createModel('while disabled', 1);
    await createRule(modelId, 1);
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: false })).status).toBe(200);

    for (const [route, payload] of [
      ['validate', { modelId }],
      ['publish', { modelId }],
      ['archive', { modelId }],
      ['new-version', { modelId }],
    ] as const) {
      const result = await call('POST', `/api/v1/LeadScore/action/model/${route}`, payload);
      expect(result.status, route).toBe(403);
      expect(errorOf(result).code, route).toBe('LEADSCORE_MODULE_DISABLED');
    }

    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true })).status).toBe(200);
  });

  it('refuses a model manager who may not publish', async () => {
    const modelId = await createModel('publisher gate', 1);
    await createRule(modelId, 1);
    const roleId = `role_${RUN}_manager`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} model manager`,
      // The role may read and edit configuration but holds no publication right: the two are separate
      // capabilities exactly so that "who can freeze a version" can be a narrower group (plan §9.1).
      permissions: {
        LeadScore: { read: 'yes' },
        LeadScoreModel: { read: 'yes', edit: 'yes' },
        LeadScoreRule: { read: 'yes', edit: 'yes' },
      },
    });
    const manager = await createTestUser(ctx, { userName: `${RUN}_manager`, roleIds: [roleId] });

    expect((await validate(modelId, manager.token)).status).toBe(200);
    const refused = await publish(modelId, {}, manager.token);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).details['capability']).toBe('modelPublish');

    // …and the administrator with the publish right can do it.
    expect((await publish(modelId)).status).toBe(200);
  });

  it('records who published and archived, because a frozen version must have an author', async () => {
    const modelId = await createModel('stamped', 1);
    await createRule(modelId, 1);
    const published = await publish(modelId);
    expect(published.status).toBe(200);
    // The author is the caller of the command, which is the same identity that created the row here. It is
    // asserted against the record rather than against a `users` lookup because the shared development
    // database carries several hundred leftover `tmpadmin-*` administrator rows.
    expect((published.body as Body)['publishedById']).toBe((await call('GET', `/api/v1/${MODEL}/${modelId}`)).body['createdById']);
    expect(typeof (published.body as Body)['publishedAt']).toBe('string');

    const archived = await call('POST', '/api/v1/LeadScore/action/model/archive', { modelId });
    expect((archived.body as Body)['archivedById']).toBe((published.body as Body)['publishedById']);

    // The record trail is the platform's own audit log: these were ordinary record writes on an `audited`
    // field, so `status` shows both transitions in order, with the actor.
    const audit = await ctx.database.db
      .selectFrom('audit_log')
      .select(['action', 'data', 'username'])
      .where('entity_type', '=', MODEL)
      .where('record_id', '=', modelId)
      .orderBy('created_at', 'asc')
      .orderBy('order', 'asc')
      .execute();
    const statusChanges = audit
      .filter((row) => (row.data as Body)['field'] === 'status')
      .map((row) => `${String((row.data as Body)['oldValue'])}>${String((row.data as Body)['newValue'])}`);
    expect(statusChanges).toEqual(['draft>published', 'published>archived']);
    expect(audit.every((row) => row.username === 'admin')).toBe(true);
  });

  it('treats the module marker as the only seam that may write a lifecycle field', async () => {
    // The guard's exemption is `runAsLeadScoreInternal`, not "some server-side code". This asserts the seam
    // behaves as documented — the publish command uses it after validating — and the same write from the
    // record API is refused, which is the other half of the pair tested above.
    const modelId = await createModel('internal path', 1);
    await createRule(modelId, 1);
    await writeAsModule(() => crud().update(MODEL, modelId, { status: 'published', publishedAt: new Date() }));
    expect((await call('GET', `/api/v1/${MODEL}/${modelId}`)).body['status']).toBe('published');

    // And an evaluation row is still unreachable from the record API in either direction.
    const forged = await call('POST', '/api/v1/LeadScoreEvaluation', { name: `${RUN} forged`, leadId: 'x', modelId, modelVersion: 1, calculatedAt: new Date().toISOString() });
    expect(forged.status).toBe(422);
  });
});

describe('the lifecycle is a documented surface (19-LS.3)', () => {
  it('reports the lifecycle as implemented and the rest as pending', async () => {
    const health = await call('GET', '/api/v1/LeadScore/action/health');
    expect(health.status).toBe(200);
    const body = health.body as unknown as {
      features: { key: string; implemented: boolean; effective: boolean; pendingPhase: string | null }[];
      operations: { operation: string; admitted: boolean; pendingPhase: string | null }[];
      ready: boolean;
      checks: { name: string; ok: boolean }[];
    };
    const features = new Map(body.features.map((feature) => [feature.key, feature]));
    expect(features.get('modelAdministration')?.implemented).toBe(true);
    expect(features.get('modelAdministration')?.effective).toBe(true);
    // 19-LS.5 delivered the switch named `scoring`: a score is now computed *and* kept. This suite leaves its
    // own half of the flags off, so it is implemented without being effective.
    expect(features.get('scoring')?.implemented).toBe(true);
    expect(features.get('scoring')?.pendingPhase).toBeNull();
    expect(features.get('scoring')?.effective).toBe(false);
    // 19-LS.4 shipped the engine and its preview switch, so `previewModel` is no longer waiting on a phase —
    // this suite leaves its own switch off, which is a different refusal with a different answer.
    expect(features.get('scoringPreview')?.implemented).toBe(true);
    expect(features.get('scoringPreview')?.effective).toBe(false);
    expect(body.ready).toBe(true);

    const operations = new Map(body.operations.map((operation) => [operation.operation, operation]));
    for (const operation of ['validateModel', 'publishModel', 'createModelVersion']) {
      expect(operations.get(operation)?.admitted, operation).toBe(true);
    }
    for (const [operation, phase] of [['conversionExecute', '19-LS.13']] as const) {
      expect(operations.get(operation)?.admitted, operation).toBe(false);
      expect(operations.get(operation)?.pendingPhase, operation).toBe(phase);
    }
    // Operations 19-LS.4, 19-LS.5 and 19-LS.6 delivered refuse this suite for want of a switch, not for want
    // of code, so the answer carries no phase at all.
    for (const operation of ['previewModel', 'readScore', 'readScoreHistory', 'recalculateLead', 'eventRecalculate', 'batchRecalculate']) {
      const entry = operations.get(operation);
      expect(entry?.admitted, operation).toBe(false);
      expect(entry?.pendingPhase, operation).toBeNull();
    }
    for (const check of body.checks) expect(check.ok, `${check.name}`).toBe(true);
  });

  it('publishes the lifecycle routes in the generated OpenAPI document', async () => {
    const result = await call('GET', '/api/v1/OpenApi');
    const paths = (result.body as { paths: Record<string, Record<string, unknown>> }).paths;
    for (const route of ['validate', 'publish', 'archive', 'new-version']) {
      expect(Object.keys(paths[`/api/v1/LeadScore/action/model/${route}`] ?? {}), route).toContain('post');
    }
  });
});
