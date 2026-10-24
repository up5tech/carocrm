import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LEADSCORE_MODEL_PERMISSION_ENTITY, MAX_RULES_PER_MODEL, MAX_VERSIONS_PER_MODEL } from '../src/lead-score/index.js';
import { LeadScoreEditorService } from '../src/lead-score/lead-score-editor.js';
import { MAX_PREVIEW_SAMPLE } from '../src/lead-score/lead-score-preview.service.js';
import { MAX_BATCH_CHUNK, MAX_BATCH_TOTAL } from '../src/lead-score/lead-score-recalculation.service.js';
import type { MetadataStoreService } from '../src/metadata/metadata-store.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.8 — the model editor's contract
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §6.3, §12, §16 `19-LS.8`; audit §5.2, §11).
 *
 * The exit criterion is that an administrator can manage a deterministic model **without editing raw JSON or
 * running code**. That holds only if the form's choices and the validator's rules are the same set, so this
 * suite checks the catalog against the module's own tables rather than against a screenshot:
 *
 *  - every field's operators come from `OPERATORS_BY_TYPE`, and a refused field comes with the refusal the
 *    validator will answer with — the editor must not offer a comparison that cannot be published;
 *  - the condition's budgets and the module's limits are the constants the parser and the commands enforce,
 *    not a second copy;
 *  - a model's grant *annotates* the answer and never overrides the built-in denylists;
 *  - the catalog reads metadata only: no Lead, no score, no rule body, and it is served behind `modelRead`.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No test database, no reset. `afterAll`
 * restores the `leadScore` settings row and removes this run's model, role and user rows by exact id.
 */

const RUN = `AGENT_TEST_LS8_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODEL = 'LeadScoreModel';

let ctx: ApiContext;
let previousSettings: string | null = null;
const createdRecordIds: string[] = [];
const createdRoleIds: string[] = [];
const createdUserNames: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string): Promise<CallResult> {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token ?? ctx.adminToken), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
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

interface EditorFieldBody {
  name: string;
  label: string;
  type: string;
  operators: string[];
  valueKind: string;
  options?: string[];
  maxLength?: number;
  scorable: boolean;
  refusal?: string;
  refusalCode?: string;
  inModelAllowlist?: boolean;
}

interface CatalogBody {
  entity: string;
  entityLabel: string;
  fields: EditorFieldBody[];
  condition: Record<string, unknown>;
  vocabularies: Record<string, string[]>;
  limits: Record<string, number>;
  model?: { id: string; name: string; modelVersion: number; status: string; allowedFieldPaths: string[]; blockedFieldPaths: string[] };
}

function fieldOf(catalog: CatalogBody, name: string): EditorFieldBody {
  const found = catalog.fields.find((entry) => entry.name === name);
  expect(found, `the catalog names ${name}`).toBeDefined();
  return found as EditorFieldBody;
}

async function editorCatalog(modelId?: string, token?: string): Promise<CallResult> {
  return call('GET', `/api/v1/LeadScore/action/editor${modelId === undefined ? '' : `?modelId=${encodeURIComponent(modelId)}`}`, undefined, token);
}

async function createModel(name: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await call('POST', `/api/v1/${MODEL}`, {
    name: `${RUN} ${name}`,
    modelVersion: 1,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 0,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: JSON.stringify([{ band: 'Cold', min: 0, max: 39 }, { band: 'Hot', min: 40, max: 100 }]),
    ...overrides,
  });
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  createdRecordIds.push(id);
  return id;
}

describe('the editor catalog answers from the metadata the model reads', () => {
  beforeAll(async () => {
    ctx = await bootApi();
    const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
    previousSettings = row === undefined ? null : JSON.stringify(row.data);
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { modelAdministration: true } })).status).toBe(200);
  }, 240_000);

  afterAll(async () => {
    const db = ctx.database.db;
    if (previousSettings === null) {
      await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
    } else {
      await db.updateTable('app_settings').set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() }).where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
    }
    if (createdRecordIds.length > 0) {
      await db.deleteFrom('entity_records').where('id', 'in', createdRecordIds).execute().catch(() => undefined);
    }
    // A rule's `name` is a physical column, but a Lead's is recomposed from parts, so the sweep checks both
    // (the LS.7 suite learned that the hard way).
    const mine = await db
      .selectFrom('entity_records')
      .select('id')
      .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`)]))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (mine.length > 0) await db.deleteFrom('entity_records').where('id', 'in', mine.map((row) => row.id)).execute().catch(() => undefined);
    if (createdRoleIds.length > 0) await db.deleteFrom('roles').where('id', 'in', createdRoleIds).execute().catch(() => undefined);
    if (createdUserNames.length > 0) {
      const users = await db.selectFrom('users').select('id').where('user_name', 'in', createdUserNames).execute().catch(() => [] as { id: string }[]);
      const ids = users.map((row) => row.id);
      if (ids.length > 0) {
        await db.deleteFrom('users_roles').where('user_id', 'in', ids).execute().catch(() => undefined);
        await db.deleteFrom('users_teams').where('user_id', 'in', ids).execute().catch(() => undefined);
        await db.deleteFrom('users').where('id', 'in', ids).execute().catch(() => undefined);
      }
    }
    await shutdownApi();
  }, 240_000);

  it('offers the Lead fields with the operators their types can answer', async () => {
    const result = await editorCatalog();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const catalog = result.body as unknown as CatalogBody;
    expect(catalog.entity).toBe('Lead');
    expect(catalog.fields.length).toBeGreaterThan(0);

    // `varchar` answers string comparisons; a number comparison on it is not offered, because the
    // validator would refuse it (plan §6.3) and a form that offered it would be a publish error waiting.
    const company = fieldOf(catalog, 'company');
    expect(company.scorable).toBe(true);
    expect(company.operators).toContain('contains');
    expect(company.operators).toContain('isEmpty');
    expect(company.operators).not.toContain('gt');
    expect(company.valueKind).toBe('text');

    const status = fieldOf(catalog, 'status');
    expect(status.operators).toEqual(expect.arrayContaining(['equals', 'in', 'notIn']));
    expect(status.valueKind).toBe('options');
    expect(status.options).toEqual(expect.arrayContaining(['New', 'Converted', 'Dead']));

    // An existence-only field needs no value at all, and saying so is what stops the form asking for one.
    const assigned = fieldOf(catalog, 'assignedUserId');
    expect(assigned.operators).toEqual(['isEmpty', 'isNotEmpty']);
    expect(assigned.valueKind).toBe('none');

    const email = fieldOf(catalog, 'emailAddress');
    expect(email.type).toBe('email');
    expect(email.operators).toContain('endsWith');

    const first = fieldOf(catalog, 'firstName');
    expect(first.maxLength).toBe(128);
  });

  it('returns a refused field with the reason the validator will give', async () => {
    const catalog = (await editorCatalog()).body as unknown as CatalogBody;

    // A scoring output refused by name, with the code an explanation would carry: reading it back is the
    // self-feeding loop plan §10.4 names, so the editor must not offer it quietly.
    const scoreValue = fieldOf(catalog, 'scoreValue');
    expect(scoreValue.scorable).toBe(false);
    expect(scoreValue.refusal).toBe('scoring_output');
    expect(scoreValue.refusalCode).toBe('LS_CONDITION_FIELD_IS_SCORING_OUTPUT');
    expect(scoreValue.operators).toEqual([]);
    expect(scoreValue.valueKind).toBe('none');

    const scoreBand = fieldOf(catalog, 'scoreBand');
    expect(scoreBand.refusal).toBe('scoring_output');

    // Every refused field carries a code: a refusal the screen cannot explain is an omission with extra steps.
    for (const entry of catalog.fields.filter((field) => !field.scorable)) {
      expect(typeof entry.refusal, entry.name).toBe('string');
      expect(typeof entry.refusalCode, entry.name).toBe('string');
    }
    // Scorable fields sort first so the picker opens on what can be used.
    const firstRefused = catalog.fields.findIndex((entry) => !entry.scorable);
    const lastScorable = catalog.fields.map((entry) => entry.scorable).lastIndexOf(true);
    expect(firstRefused).toBeGreaterThan(lastScorable);
  });

  it('carries the parser and command budgets, not a copy of them', async () => {
    const catalog = (await editorCatalog()).body as unknown as CatalogBody;
    expect(catalog.condition).toMatchObject({ maxDepth: 2, maxPredicates: 20, maxNodes: 60, maxListValues: 25, maxValueChars: 512 });
    // The sets arrive sorted, so two installations answer with the same list in the same order.
    expect(catalog.condition['valuelessOperators']).toEqual(['isEmpty', 'isFalse', 'isNotEmpty', 'isTrue']);
    expect(catalog.condition['listOperators']).toEqual(['in', 'notIn']);
    expect(catalog.condition['arrayOperators']).toEqual(expect.arrayContaining(['in', 'notIn', 'between']));

    expect(catalog.limits).toMatchObject({
      maxRulesPerModel: MAX_RULES_PER_MODEL,
      maxVersionsPerModel: MAX_VERSIONS_PER_MODEL,
      maxPreviewSample: MAX_PREVIEW_SAMPLE,
      maxBatchChunk: MAX_BATCH_CHUNK,
      maxBatchTotal: MAX_BATCH_TOTAL,
    });
  });

  it('offers the vocabularies a model and its rules are written from', async () => {
    const catalog = (await editorCatalog()).body as unknown as CatalogBody;
    expect(catalog.vocabularies.dimensions).toEqual(['fit', 'intent', 'engagement', 'completeness', 'recency', 'negative']);
    expect(catalog.vocabularies.effects).toEqual(['add', 'subtract', 'setBand']);
    expect(catalog.vocabularies.bands).toEqual(expect.arrayContaining(['Cold', 'Warm', 'Hot', 'Sales Ready', 'Disqualified']));
    expect(catalog.vocabularies.modelStatuses).toEqual(['draft', 'published', 'archived']);
    expect(catalog.vocabularies.missingDataPolicies).toEqual(['ignore', 'neutral']);
    expect(catalog.vocabularies.signalSources).toEqual(['lead', 'marketingEvents', 'emailLinks']);
    expect(catalog.vocabularies.outcomes).toContain('matched');
    expect(catalog.vocabularies.decayPolicies).toContain('halfLife');
  });

  it('annotates a field grant without overriding the built-in refusals', async () => {
    const modelId = await createModel('grant', {
      allowedFieldPaths: JSON.stringify(['company', 'industry', 'scoreValue']),
      blockedFieldPaths: JSON.stringify(['status']),
    });
    const result = await editorCatalog(modelId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const catalog = result.body as unknown as CatalogBody;

    expect(catalog.model?.id).toBe(modelId);
    expect(catalog.model?.allowedFieldPaths).toEqual(['company', 'industry', 'scoreValue']);
    expect(catalog.model?.blockedFieldPaths).toEqual(['status']);

    expect(fieldOf(catalog, 'company').inModelAllowlist).toBe(true);
    // A granted path that is also a scoring output stays refused: the allowlist is not a way to switch the
    // denylists off (plan §0.1-6, §10.4).
    expect(fieldOf(catalog, 'scoreValue').inModelAllowlist).toBe(false);
    expect(fieldOf(catalog, 'scoreValue').refusal).toBe('scoring_output');
    // A blocked path is not selectable even though the model named it in `allowedFieldPaths`.
    expect(fieldOf(catalog, 'status').inModelAllowlist).toBe(false);
    // A field neither granted nor blocked is outside the grant.
    expect(fieldOf(catalog, 'title').inModelAllowlist).toBe(false);
  });

  it('leaves the annotation off when no model was named or its grant cannot be read', async () => {
    const plain = (await editorCatalog()).body as unknown as CatalogBody;
    expect(plain.model).toBeUndefined();
    for (const entry of plain.fields) expect(entry.inModelAllowlist).toBeUndefined();

    // A malformed grant is a configuration problem for `validate` to name, not a reason this endpoint fails.
    const broken = await createModel('broken-grant', { allowedFieldPaths: 'not json' });
    const catalog = (await editorCatalog(broken)).body as unknown as CatalogBody;
    expect(catalog.model).toBeUndefined();
    expect(fieldOf(catalog, 'company').scorable).toBe(true);
  });

  it('names the model it was asked for and refuses what the caller may not read', async () => {
    const missing = await editorCatalog('00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);

    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/LeadScore/action/editor' });
    expect(anon.statusCode).toBe(401);

    const role = `${RUN}role`;
    await createTestRole(ctx, { id: role, name: role, permissions: {} });
    createdRoleIds.push(role);
    createdUserNames.push(`${RUN}viewer`);
    const user = await createTestUser(ctx, { userName: `${RUN}viewer`, roleIds: [role] });
    const denied = await editorCatalog(undefined, user.token);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details['capability']).toBe('modelRead');
    expect(errorOf(denied).details['resource']).toBe(LEADSCORE_MODEL_PERMISSION_ENTITY);
  });

  it('serves a granted non-administrator the same catalog an administrator sees', async () => {
    const role = `${RUN}modelrole`;
    await createTestRole(ctx, {
      id: role,
      name: role,
      permissions: { [LEADSCORE_MODEL_PERMISSION_ENTITY]: { read: 'yes' }, LeadScore: { read: 'yes' } },
    });
    createdRoleIds.push(role);
    createdUserNames.push(`${RUN}editor`);
    const user = await createTestUser(ctx, { userName: `${RUN}editor`, roleIds: [role] });
    const granted = await editorCatalog(undefined, user.token);
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    const asAdmin = (await editorCatalog()).body as unknown as CatalogBody;
    const asUser = granted.body as unknown as CatalogBody;
    expect(asUser.fields.map((entry) => entry.name)).toEqual(asAdmin.fields.map((entry) => entry.name));
  });

  it('reads no record: a Lead value never appears in the catalog', async () => {
    const marker = `${RUN} canary-value`;
    const created = await call('POST', '/api/v1/Lead', { lastName: marker, firstName: 'Probe', company: marker, status: 'New' });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    createdRecordIds.push(String(created.body['id'] ?? ''));

    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/LeadScore/action/editor', headers: authHeader(ctx.adminToken) });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(marker);
  });

  it('refuses a query key the catalog does not take', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/LeadScore/action/editor?entity=Contact', headers: authHeader(ctx.adminToken) });
    expect(res.statusCode).toBe(400);
  });
});

describe('the editor classifies a field the metadata declares', () => {
  /**
   * A Lead field is something an administrator adds (plan §3.1), so the denylists have to bite the day such
   * a column appears. This is the same classification the validator applies, exercised against a definition
   * the running metadata does not carry: a secret, an artifact, a computed value, an unknown type and a
   * protected concept.
   */
  function editorFor(fields: Record<string, unknown>): LeadScoreEditorService {
    const definition = { label: 'Lead', fields } as never;
    const metadata = { registry: { getEntity: () => definition } } as never as MetadataStoreService;
    return new LeadScoreEditorService(metadata);
  }

  it('refuses the types that are never a signal and the names that are protected', () => {
    const catalog = editorFor({
      password: { type: 'password' },
      attachment: { type: 'file' },
      formulaField: { type: 'formula' },
      age: { type: 'int' },
      birthDate: { type: 'date' },
      website: { type: 'url' },
      someBrandNewType: { type: 'widget' },
    }).catalog();

    const byName = new Map(catalog.fields.map((entry) => [entry.name, entry]));
    expect(byName.get('password')?.refusal).toBe('never_scorable_type');
    expect(byName.get('attachment')?.refusal).toBe('never_scorable_type');
    expect(byName.get('formulaField')?.refusal).toBe('never_scorable_type');
    // The name wins over the type: an integer called `age` is still a proxy for a date of birth (plan §0.1-6).
    expect(byName.get('age')?.refusal).toBe('protected');
    expect(byName.get('birthDate')?.refusal).toBe('protected');
    // A type the operator matrix has never heard of is refused rather than offered with no operators.
    expect(byName.get('someBrandNewType')?.refusal).toBe('unknown_type');
    expect(byName.get('someBrandNewType')?.refusalCode).toBe('LS_CONDITION_NO_OPERATOR_FOR_WIDGET');
    expect(byName.get('website')?.scorable).toBe(true);
  });

  it('derives the value control from the operators on offer', () => {
    const catalog = editorFor({
      note: { type: 'text' },
      seats: { type: 'int' },
      budget: { type: 'currency' },
      agree: { type: 'bool' },
      day: { type: 'date' },
      moment: { type: 'datetime' },
      stage: { type: 'enum', values: ['One', 'Two'] },
      // A link field whose only legal question is existence needs no control at all.
      owner: { type: 'link', entityKey: 'User' },
      tags: { type: 'multiEnum', values: ['a', 'b'] },
    }).catalog();

    const byName = new Map(catalog.fields.map((entry) => [entry.name, entry]));
    expect(byName.get('note')?.valueKind).toBe('textarea');
    expect(byName.get('seats')?.valueKind).toBe('number');
    expect(byName.get('budget')?.valueKind).toBe('number');
    expect(byName.get('agree')?.valueKind).toBe('boolean');
    expect(byName.get('agree')?.operators).toEqual(['isTrue', 'isFalse', 'equals', 'notEquals']);
    expect(byName.get('day')?.valueKind).toBe('date');
    expect(byName.get('moment')?.valueKind).toBe('datetime');
    expect(byName.get('stage')?.valueKind).toBe('options');
    expect(byName.get('stage')?.options).toEqual(['One', 'Two']);
    expect(byName.get('owner')?.valueKind).toBe('none');
    // A multi-value field only answers existence, so it needs no value control either.
    expect(byName.get('tags')?.valueKind).toBe('none');
    expect(byName.get('tags')?.operators).toEqual(['isEmpty', 'isNotEmpty']);
  });

  it('labels a field without a declared label and keeps a model that names none unannotated', () => {
    const catalog = editorFor({ scoreValue: { type: 'int' }, firstName: { type: 'varchar' } }).catalog();
    const byName = new Map(catalog.fields.map((entry) => [entry.name, entry]));
    expect(byName.get('firstName')?.label).toBe('First Name');
    expect(catalog.model).toBeUndefined();
    expect(byName.get('scoreValue')?.refusal).toBe('scoring_output');
  });

  it('annotates only the paths the model granted, from the attributes as stored', () => {
    const catalog = editorFor({ company: { type: 'varchar' }, status: { type: 'enum', values: ['New'] } }).catalog({
      id: 'm1',
      name: 'Grant probe',
      modelVersion: 3,
      status: 'draft',
      scaleMin: 0,
      scaleMax: 100,
      baseScore: 0,
      scoreFloor: 0,
      scoreCeiling: 100,
      allowedFieldPaths: JSON.stringify(['company']),
      blockedFieldPaths: undefined,
      rules: [],
    } as never);
    expect(catalog.model?.modelVersion).toBe(3);
    const byName = new Map(catalog.fields.map((entry) => [entry.name, entry]));
    expect(byName.get('company')?.inModelAllowlist).toBe(true);
    expect(byName.get('status')?.inModelAllowlist).toBe(false);
  });
});
