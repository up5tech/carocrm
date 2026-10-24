import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthenticatedPrincipal, REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import { HookRegistry } from '../src/hooks/hook.registry.js';
import { DEFAULT_LEADSCORE_SETTINGS, runAsLeadScoreInternal, SERVER_OWNED_LEAD_FIELDS } from '../src/lead-score/index.js';
import { METADATA_STORE, type MetadataStoreService } from '../src/metadata/metadata-store.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.2 — the Lead Score schema and metadata foundation
 * (`PLAN_Phase_19_LeadScore.md` §5; audit §4–§6; report `docs/implementation/lead-score-ls2-completion-report.md`).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No test database is created; nothing is
 * reset, truncated or dropped; `afterAll` removes the `AGENT_TEST_LS2_` records by exact id and restores
 * the `leadScore` settings row byte-for-byte.
 *
 * The phase's exit criterion is that the schema and metadata validate against the repository's existing
 * conventions — and that an additive foundation preserved what was already there. So the suite checks the
 * DDL it was supposed to add, the records it was supposed to register, the fields it was supposed to
 * leave alone, and the data that was here before it.
 */

const RUN = `AGENT_TEST_LS2_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const MODULE_MIGRATION = '073_phase19_lead_score.sql';
const OWNED_ENTITIES = ['LeadScoreModel', 'LeadScoreRule', 'LeadScoreEvaluation', 'LeadConversionOperation'] as const;

let ctx: ApiContext;
let previousSettings: string | null = null;
let adminPrincipal: AuthenticatedPrincipal | undefined;
const createdRecordIds: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
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

function errorText(result: CallResult): string {
  return JSON.stringify(result.body['error'] ?? result.body);
}

function definition(name: string): EntityDefinition | undefined {
  return (ctx.app.get(METADATA_STORE, { strict: false }) as MetadataStoreService).registry.getEntity(name);
}

/** A record created through the generic API is registered for exact-id cleanup by `afterAll`. */
async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, errorText(result)).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  expect(id).not.toBe('');
  createdRecordIds.push(id);
  return id;
}

/**
 * A write as a Lead Score domain service would perform it: the request scope carries the principal, and
 * the async-local marker says the caller is the module rather than a client of the record API.
 *
 * `RequestScope.runAs` is the platform's own seam for "outside an HTTP request — a job, a scheduled run",
 * which is exactly how the scoring engine and the conversion command will call it in 19-LS.4 and 19-LS.13.
 */
function writeAsModule<T>(work: () => Promise<T>): Promise<T> {
  const scope = ctx.app.get(REQUEST_SCOPE_TOKEN, { strict: false }) as RequestScope;
  if (adminPrincipal === undefined) throw new Error('the admin principal was not resolved before this write');
  return scope.runAs(adminPrincipal, () => runAsLeadScoreInternal(work));
}

function crud(): EntityCrudService {
  return ctx.app.get(EntityCrudService, { strict: false });
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);

  const admin = await ctx.database.db.selectFrom('users').select(['id', 'user_name']).where('is_admin', '=', true).limit(1).executeTakeFirst();
  if (admin !== undefined) {
    adminPrincipal = { userId: admin.id, userName: admin.user_name, userType: 'admin', roles: [], teams: [] };
  }
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

  // A refused write can still have created a row — the duplicate-key tests POST on purpose and one of
  // them leaked when an assertion failed before `afterAll` reached the id list. Everything carrying this
  // run's own marker is removed by that exact predicate, which is the only cleanup this suite may do
  // (AGENTS.md §3.3): nothing is deleted because its name merely looks similar.
  const mine = await db.selectFrom('entity_records').select('id').where('name', 'like', `${RUN}%`).execute().catch(() => [] as { id: string }[]);
  if (mine.length > 0) {
    const ids = mine.map((row) => row.id);
    const links = await db
      .selectFrom('entity_links')
      .select('id')
      .where((eb) => eb.or([eb('record_id_a', 'in', ids), eb('record_id_b', 'in', ids)]))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (links.length > 0) await db.deleteFrom('entity_links').where('id', 'in', links.map((row) => row.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
    const still = await db.selectFrom('entity_records').select('id').where('name', 'like', `${RUN}%`).execute().catch(() => [] as { id: string }[]);
    if (still.length > 0) console.warn({ still: still.length, run: RUN }, 'lead-score schema suite left records behind');
  }

  await shutdownApi();
}, 240_000);

describe('migration 073 is additive and present (19-LS.2)', () => {
  it('is recorded once, and created no table and no column on the shared record store', async () => {
    const db = ctx.database.db;
    const applied = await db.selectFrom('schema_migrations').select(['name', 'applied_at']).where('name', '=', MODULE_MIGRATION).execute();
    expect(applied).toHaveLength(1);

    const relations = await db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .where((eb) => eb.or([eb('table_name', 'like', '%lead_score%'), eb('table_name', 'like', '%lead_conversion%')]))
      .execute();
    expect(relations).toEqual([]);

    const columns = await db.selectFrom('information_schema.columns').select('column_name').where('table_name', '=', 'entity_records').execute();
    const names = columns.map((row) => row.column_name);
    // Every Lead Score attribute lives in `attrs`: no physical column was added to the shared store.
    for (const forbidden of ['scoreValue', 'score_value', 'converted_account_id', 'conversion_operation_id']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain('attrs');
  });

  it('created the projection, history, idempotency and operation indexes it claims', async () => {
    const rows = await ctx.database.db
      .selectFrom('pg_indexes')
      .select(['indexname', 'indexdef'])
      .where((eb) => eb.or([eb('indexname', 'like', '%lead_score%'), eb('indexname', 'like', '%lead_conversion%')]))
      .where('tablename', '=', 'entity_records')
      .execute();
    const names = new Set(rows.map((row) => row.indexname));
    const definitions = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    for (const expected of [
      'idx_entity_records_lead_score_value',
      'idx_entity_records_lead_score_band',
      'idx_entity_records_lead_score_status',
      'idx_entity_records_lead_score_calculated',
      'idx_entity_records_lead_score_model',
      'idx_entity_records_lead_score_model_status',
      'uq_entity_records_lead_score_model_version',
      'idx_entity_records_lead_score_rule_model',
      'uq_entity_records_lead_score_rule_reason',
      'idx_entity_records_lead_score_evaluation_lead',
      'idx_entity_records_lead_score_evaluation_model',
      'uq_entity_records_lead_score_evaluation_key',
      'uq_entity_records_lead_conversion_operation_key',
      'idx_entity_records_lead_conversion_operation_lead',
      'idx_entity_records_lead_conversion_operation_status',
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }

    // Scoped to their entity type and to live rows: an index over the shared store that was not partial
    // would index the whole CRM for one module.
    for (const row of rows) {
      expect(row.indexdef).toContain('entity_type');
      expect(row.indexdef).toContain('deleted_at');
    }
    expect(rows).toHaveLength(15);

    // 19-LS.9's own index is on another module's table, so it is asserted separately: it is the bounded
    // recipient-scoped engagement read, and it is partial for the same reason the ones above are — a row
    // with no recipient is not a signal, and indexing those would index work Lead Score can never use.
    const signalIndex = await ctx.database.db
      .selectFrom('pg_indexes')
      .select(['indexname', 'indexdef', 'tablename'])
      .where('indexname', '=', 'idx_marketing_events_lead_score_recipient')
      .execute();
    expect(signalIndex).toHaveLength(1);
    expect(signalIndex[0]?.tablename).toBe('marketing_events');
    expect(signalIndex[0]?.indexdef).toContain('recipient_entity_id');
    expect(signalIndex[0]?.indexdef).toContain('occurred_at');
    expect(signalIndex[0]?.indexdef).toContain('DESC');
    expect(signalIndex[0]?.indexdef).toContain('recipient_entity_id IS NOT NULL');

    // 0–100 is not text-orderable, so the score index is numeric while the rest are text.
    expect(definitions.get('idx_entity_records_lead_score_value')).toContain('::numeric');
    // The three invariants that make a replay harmless rather than merely unlikely (plan §5.2, §5.5, §7.8).
    expect(definitions.get('uq_entity_records_lead_conversion_operation_key')).toContain('UNIQUE');
    expect(definitions.get('uq_entity_records_lead_score_evaluation_key')).toContain('UNIQUE');
    expect(definitions.get('uq_entity_records_lead_score_rule_reason')).toContain('UNIQUE');
  });
});

describe('existing data is preserved (19-LS.2 acceptance)', () => {
  it('wrote no score into any pre-existing Lead and touched no other entity type', async () => {
    const owned = [...SERVER_OWNED_LEAD_FIELDS];
    const scored = await ctx.database.db
      .selectFrom('entity_records')
      .select(['id', 'entity_type'])
      .where(sql<boolean>`(attrs ?& ${owned}::text[])`)
      .execute();
    // Nothing about this phase can produce a score: no row may claim one. `not_scored` is the *absence* of
    // the attributes, not a fabricated zero (plan §1.2, §15.1).
    expect(scored).toEqual([]);

    const leads = await ctx.database.db.selectFrom('entity_records').select('id').where('entity_type', '=', 'Lead').execute();
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads.slice(0, 8)) {
      const row = await ctx.database.db
        .selectFrom('entity_records')
        .select(['attrs', 'deleted_at', 'version'])
        .where('id', '=', lead.id)
        .executeTakeFirstOrThrow();
      expect(row.deleted_at).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(row.attrs as Body, 'status')).toBe(true);
    }
  });

  it('kept the Lead status vocabulary exactly as the core lifecycle defined it', () => {
    const status = definition('Lead')?.fields['status'];
    expect(status?.type).toBe('enum');
    // Reused, not redefined: no `Disqualified` status was invented for a band (decisions D1, D6).
    expect(status?.values ?? status?.enum).toEqual(['New', 'Assigned', 'In Process', 'Converted', 'Dead']);
  });

  it('left the ordinary Lead write surface alone', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} ordinary`, lastName: `${RUN} ordinary`, status: 'New', company: `${RUN} Industries` });
    const patched = await call('PATCH', `/api/v1/Lead/${leadId}`, { title: 'Buyer', status: 'In Process', phoneNumber: '+84900000000' });
    expect(patched.status, errorText(patched)).toBe(200);
    expect(patched.body['status']).toBe('In Process');
    expect(patched.body['title']).toBe('Buyer');

    // Turning the module on changes nothing about Lead CRUD either.
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true })).status).toBe(200);
    const afterEnable = await call('PATCH', `/api/v1/Lead/${leadId}`, { source: 'Webinar' });
    expect(afterEnable.status).toBe(200);
    expect(afterEnable.body['source']).toBe('Webinar');
  });
});

describe('metadata foundation (19-LS.2)', () => {
  it('registers the four Lead Score entities as ordinary metadata records', () => {
    for (const name of OWNED_ENTITIES) {
      const entity = definition(name);
      expect(entity, name).toBeDefined();
      expect(entity?.isEntity, name).toBe(true);
      expect(entity?.fields['name']?.required, name).toBe(true);
      expect(entity?.record?.displayField, name).toBe('name');
      expect(entity?.acl?.permissions?.[name], name).toBeDefined();
      // A module field must not be named after a physical column the store consumes for its own
      // bookkeeping: `version` is the row's optimistic-concurrency value, so an entity that wants to
      // record a version number has to call it something else (the model uses `modelVersion`).
      expect(entity?.fields['version'], `${name}.version`).toBeUndefined();
    }
  });

  it('gives a model its version, scale, bands and field scope', () => {
    const model = definition('LeadScoreModel');
    const fields = model?.fields ?? {};
    expect(fields['status']?.values).toEqual(['draft', 'published', 'archived']);
    expect(fields['modelVersion']?.required).toBe(true);
    expect(fields['modelVersion']?.defaultValue).toBe(1);
    // A model version is *not* the record's optimistic-concurrency column: `version` is consumed by the
    // store and by `EntityCrudService.update`, so a field by that name could never hold a version number.
    expect(fields['version']).toBeUndefined();
    expect(fields['scaleMin']?.defaultValue).toBe(0);
    expect(fields['scaleMax']?.defaultValue).toBe(100);
    expect(fields['scoreCeiling']?.defaultValue).toBe(100);
    // A model states which Lead paths it may read, and which are refused even by accident
    // (plan §5.1, §9.2, §9.3 — the sensitive-attribute boundary is configuration an admin can review).
    for (const field of ['allowedFieldPaths', 'blockedFieldPaths', 'qualificationBands', 'dimensionWeights', 'settingsJson']) {
      expect(fields[field], field).toBeDefined();
      expect(fields[field]?.inEdit, field).toBe(true);
      expect(fields[field]?.type, field).toBe('text');
    }
    // Publication is a lifecycle act with an actor and a moment; neither is a client-editable field.
    for (const field of ['publishedById', 'publishedAt', 'archivedById', 'archivedAt']) {
      expect(fields[field], field).toBeDefined();
      expect(fields[field]?.inEdit, field).toBeUndefined();
    }
    expect(model?.relations?.['rules']?.target).toBe('LeadScoreRule');
    expect(model?.relations?.['rules']?.mappedBy).toBe('model');
    // Deleting a published model would orphan the evaluations that name its version (plan §5.1, §5.4).
    expect(model?.record?.removable).toBe(false);
  });

  it('gives a rule a bounded declarative shape and a stable reason code', () => {
    const fields = definition('LeadScoreRule')?.fields ?? {};
    expect(fields['modelId']?.required).toBe(true);
    expect(fields['modelVersion']?.required).toBe(true);
    expect(fields['reasonCode']?.required).toBe(true);
    expect(fields['effect']?.values).toEqual(['add', 'subtract', 'setBand']);
    expect(fields['dimension']?.values).toEqual(['fit', 'intent', 'engagement', 'completeness', 'recency', 'negative']);
    expect(fields['targetBand']?.values).toEqual(['Unknown', 'Cold', 'Warm', 'Hot', 'Sales Ready', 'Disqualified']);
    // Absent data is not negative unless a rule says so (plan §1.2, §6.3).
    expect(fields['missingDataPolicy']?.defaultValue).toBe('neutral');
    // Only the signal sources the audit found real. There is no `activities` source, because a Task, Call
    // or Meeting cannot reference a Lead in this build (audit gap G2) — inventing one here would be a
    // scoring input that can never be read.
    expect(fields['signalSource']?.values).toEqual(['lead', 'marketingEvents', 'emailLinks']);
    expect(fields['decayPolicy']?.values).toEqual(['none', 'linear', 'halfLife']);
    expect(fields['lookbackDays']?.type).toBe('int');
    // A condition is data, never code: text holding the declarative tree, and no field of this entity is
    // a formula type the engine could execute (plan §5.2, §6.2).
    expect(fields['condition']?.type).toBe('text');
    expect(fields['condition']?.required).toBe(true);
    expect(Object.values(fields).some((field) => field.type === 'formula' || field.type === 'generated')).toBe(false);
  });

  it('records an evaluation with version, freshness, coverage and per-rule results', () => {
    const evaluation = definition('LeadScoreEvaluation');
    const fields = evaluation?.fields ?? {};
    expect(fields['leadId']?.required).toBe(true);
    expect(fields['modelId']?.required).toBe(true);
    expect(fields['modelVersion']?.required).toBe(true);
    expect(fields['evaluationStatus']?.values).toEqual(['current', 'stale', 'pending', 'failed', 'not_scored']);
    expect(fields['trigger']?.values).toEqual(['lead_change', 'engagement_event', 'manual_recalculate', 'model_publish', 'batch_rebuild', 'decay_sweep']);
    expect(fields['resultState']?.values).toEqual(['success', 'partial', 'failed']);
    for (const field of ['calculatedAt', 'inputsAsOf', 'sourceRevision', 'coverage', 'ruleResults', 'positiveReasonCodes', 'negativeReasonCodes', 'skippedReasonCodes', 'errorSummary', 'signature', 'idempotencyKey', 'correlationId', 'jobId', 'durationMs']) {
      expect(fields[field], field).toBeDefined();
    }
    // Append-only and module-written, read through a record-scoped command rather than a general entity
    // read — the `CustomerSuccessHealthSnapshot` shape the audit identified (plan §5.4, §8.2).
    expect(evaluation?.client?.web).toBe(false);
    expect(evaluation?.acl?.permissions?.LeadScoreEvaluation).toMatchObject({ create: 'yes', read: 'no', edit: 'no', delete: 'no' });
    expect(evaluation?.record?.removable).toBe(false);
    expect(evaluation?.layouts?.edit ?? []).toEqual([]);
  });

  it('records a conversion operation with idempotency, confirmation and created-versus-linked results', () => {
    const fields = definition('LeadConversionOperation')?.fields ?? {};
    expect(fields['operationKey']?.required).toBe(true);
    expect(fields['sourceLeadId']?.required).toBe(true);
    expect(fields['status']?.values).toEqual(['previewed', 'processing', 'succeeded', 'failed_retryable', 'failed_final', 'needs_review']);
    expect(fields['requestedTargets']?.values).toEqual(['Contact', 'Account', 'Opportunity']);
    for (const field of ['sourceLeadRevision', 'previewHash', 'mappingVersion', 'selectedMatchIds', 'requestedById', 'requestedAt', 'confirmedAt', 'completedAt', 'resultSummary', 'failureCode', 'correlationId']) {
      expect(fields[field], field).toBeDefined();
    }
    // Created and linked stay separate facts: "the CRM already had this person" is not "the user just
    // created them" (plan §1.1, §11.4).
    for (const field of ['createdAccountId', 'linkedAccountId', 'createdContactId', 'linkedContactId', 'createdOpportunityId', 'linkedOpportunityId']) {
      expect(fields[field]?.type, field).toBe('link');
    }
    expect(definition('LeadConversionOperation')?.client?.web).toBe(false);
    expect(definition('LeadConversionOperation')?.record?.removable).toBe(false);
  });

  it('puts the projection and the conversion result on the core Lead record, out of the edit surface', () => {
    const fields = definition('Lead')?.fields ?? {};
    for (const field of SERVER_OWNED_LEAD_FIELDS) {
      expect(fields[field], field).toBeDefined();
      // Server-owned: not a form field anywhere, so no generated edit screen can offer to fake it.
      expect(fields[field]?.inEdit, field).toBeUndefined();
    }
    expect(fields['scoreValue']?.type).toBe('int');
    expect(fields['scoreBand']?.values).toEqual(['Unknown', 'Cold', 'Warm', 'Hot', 'Sales Ready', 'Disqualified']);
    expect(fields['scoreStatus']?.defaultValue).toBe('not_scored');
    expect(fields['scoreModelId']?.entityKey).toBe('LeadScoreModel');
    expect(fields['convertedAccountId']?.entityKey).toBe('Account');
    expect(fields['convertedContactId']?.entityKey).toBe('Contact');
    expect(fields['convertedOpportunityId']?.entityKey).toBe('Opportunity');
    expect(fields['conversionOperationId']?.entityKey).toBe('LeadConversionOperation');
    // A score churns on every recalculation; the evaluation rows are its history, not `audit_log`
    // flooding. The conversion references are a one-off business event, so they are audited.
    expect(fields['scoreValue']?.audited).toBeUndefined();
    expect(fields['convertedAt']?.audited).toBe(true);
    expect(fields['convertedContactId']?.audited).toBe(true);

    for (const field of ['name', 'firstName', 'lastName', 'title', 'status', 'company', 'industry', 'emailAddress', 'phoneNumber', 'source', 'description', 'assignedUserId']) {
      expect(fields[field]?.inEdit, field).toBe(true);
    }
  });

  it('adds the score and converted panels without dropping a field the Lead detail view showed', () => {
    const leadFields = definition('Lead')?.fields ?? {};
    const panels = definition('Lead')?.layouts?.detail?.[0]?.panels ?? [];
    // Every field a panel names must be a declared field: a typo in a layout renders nothing at all and
    // is invisible until someone looks at the screen.
    for (const panel of panels) {
      for (const field of panel.fields ?? []) {
        expect(leadFields[field], `Lead ${panel.name}.${field}`).toBeDefined();
      }
    }
    // And every field of the entity is placed somewhere, so the detail view shows the whole record.
    const placed = new Set(panels.flatMap((panel) => panel.fields ?? []));
    const shown = Object.keys(leadFields).filter((field) => leadFields[field]?.inDetail === true);
    for (const field of shown) {
      expect(placed.has(field), `Lead detail omits ${field}`).toBe(true);
    }
    const byName = new Map(panels.map((panel) => [panel.name, panel.fields ?? []]));
    // 19-LS.7 removed the generic `score` panel: its fields are `inDetail: false` now, and the Lead Score
    // card is their surface. `converted` stays, because nothing shows those references until 19-LS.13.
    expect([...byName.keys()]).toEqual(['main', 'converted']);
    expect(byName.get('score')).toBeUndefined();
    expect(byName.get('converted')).toEqual(['convertedAccountId', 'convertedContactId', 'convertedOpportunityId', 'convertedAt', 'convertedById', 'conversionOperationId']);
    for (const field of ['status', 'company', 'emailAddress', 'phoneNumber', 'assignedUserId', 'title', 'source', 'industry']) {
      expect(byName.get('main'), field).toContain(field);
    }
    // The list and edit views stay metadata-driven defaults: LS.7 opened the projection to the list through
    // `inList`/`inFilter` instead of freezing a column order, and 19-LS.14 owns the edit layout.
    expect(definition('Lead')?.layouts?.list ?? []).toEqual([]);
    expect(definition('Lead')?.layouts?.edit ?? []).toEqual([]);
  });

  it('places the projection where 19-LS.7 shows it: listed, filterable, and never a raw detail dump', () => {
    const fields = definition('Lead')?.fields ?? {};
    const flag = (name: string, key: 'inList' | 'inFilter' | 'inDetail'): unknown => fields[name]?.[key];

    // A rep triaging a queue sorts by the number and filters by the band, so those two are list columns.
    for (const name of ['scoreValue', 'scoreBand']) {
      expect(flag(name, 'inList'), `${name} in the list`).toBe(true);
      expect(flag(name, 'inFilter'), `${name} filterable`).toBe(true);
      expect(flag(name, 'sortable') ?? true, `${name} sortable`).toBeTruthy();
    }
    // The freshness state is worth filtering ("show me the stale ones") and is not worth a column.
    expect(flag('scoreStatus', 'inFilter')).toBe(true);
    expect(flag('scoreStatus', 'inList')).toBeFalsy();

    // None of them is a detail field: the Lead Score card renders the stored projection with its explanation,
    // and a second surface showing the same number on the same page is the duplication LS.7 removed.
    for (const name of ['scoreValue', 'scoreBand', 'scoreStatus', 'scoreModelId', 'scoreModelVersion', 'scoreCoverage', 'scoreCalculatedAt', 'scoreInputsAsOf', 'scorePreviousValue']) {
      expect(flag(name, 'inDetail'), `${name} is not a raw detail field`).toBe(false);
    }
    // The provenance fields are also out of the filter panel, by explicit metadata rather than by the
    // twelve-field cap the SPA applies to type-derived candidates.
    for (const name of ['scoreModelVersion', 'scoreCalculatedAt', 'scoreInputsAsOf', 'scorePreviousValue', 'scoreCoverage']) {
      expect(flag(name, 'inFilter'), name).toBe(false);
    }
    // Nothing about a score is editable from a form: the write guard already refuses it, and a field the
    // editor would reject must not be rendered (plan §5.3, §7.6).
    for (const name of SERVER_OWNED_LEAD_FIELDS) {
      expect(fields[name]?.inEdit, `${name} is not an editable field`).toBeFalsy();
    }
  });

  it('reports the whole foundation from the running system', async () => {
    const result = await call('GET', '/api/v1/LeadScore/action/health');
    expect(result.status).toBe(200);
    const body = result.body as unknown as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    const byName = new Map(body.checks.map((check) => [check.name, check]));
    for (const name of ['core-lead-lifecycle', 'lead-score-fields', 'lead-core-fields', 'entity-registration', 'schema-indexes', 'write-guard', 'scoring-engine', 'platform-foundation']) {
      expect(byName.get(name)?.ok, `${name}: ${byName.get(name)?.detail ?? 'absent'}`).toBe(true);
    }
    expect(body.ok).toBe(true);
    expect(byName.get('schema-indexes')?.detail).toContain('15 indexes');
    expect(byName.get('entity-registration')?.detail).toContain('LeadScoreEvaluation');
    expect(byName.get('write-guard')?.detail).toContain('guards registered');
  });
});

describe('the write guard owns the module’s fields and records (19-LS.2)', () => {
  it('refuses a client write of a score or a conversion reference', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} guarded`, lastName: `${RUN} guarded` });

    const forged = await call('PATCH', `/api/v1/Lead/${leadId}`, { scoreValue: 99, scoreBand: 'Hot' });
    expect(forged.status).toBe(422);
    expect(errorText(forged)).toContain('scoreValue');
    expect(errorText(forged)).toContain('scoreBand');

    // The dangerous one: naming a Contact id you can already see is not a conversion (plan §0.1-8).
    const fakeConversion = await call('PATCH', `/api/v1/Lead/${leadId}`, { convertedContactId: 'anexistingcontactid' });
    expect(fakeConversion.status).toBe(422);
    expect(errorText(fakeConversion)).toContain('convertedContactId');

    // A create cannot seed a score either.
    const created = await call('POST', '/api/v1/Lead', { name: `${RUN} forged create`, lastName: `${RUN} forged create`, scoreValue: 42 });
    expect(created.status).toBe(422);

    // …and the refused writes left nothing behind.
    const readBack = await call('GET', `/api/v1/Lead/${leadId}`);
    expect(readBack.status).toBe(200);
    expect(readBack.body['scoreValue'] ?? null).toBeNull();
    expect(readBack.body['convertedContactId'] ?? null).toBeNull();
  });

  it('refuses an administrative caller too, because ownership is not a permission', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} admin attempt`, lastName: `${RUN} admin attempt` });
    const result = await call('PATCH', `/api/v1/Lead/${leadId}`, { convertedAt: '2026-10-24T00:00:00.000Z' });
    // Field-level ACL would let a `sysAdmin` through (`acl-api.service.ts:172-185`), which is why this is a
    // guard and not a permission: nobody outside the module may assert that a conversion happened.
    expect(result.status).toBe(422);
    expect(errorText(result)).toContain('Lead Score');
  });

  it('stays in force while the module is switched off', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} disabled attempt`, lastName: `${RUN} disabled attempt` });
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: false })).status).toBe(200);
    const result = await call('PATCH', `/api/v1/Lead/${leadId}`, { scoreValue: 5 });
    // Disabling a module closes its screens and jobs; it must not open a way to forge its data.
    expect(result.status).toBe(422);
  });

  it('refuses a user write of a history row or an operation row', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} history target`, lastName: `${RUN} history target` });
    const modelId = await createRecord('LeadScoreModel', { name: `${RUN} guarded model`, status: 'draft', modelVersion: 1 });

    const evaluation = await call('POST', '/api/v1/LeadScoreEvaluation', {
      name: `${RUN} forged evaluation`,
      leadId,
      modelId,
      modelVersion: 1,
      calculatedAt: '2026-10-24T00:00:00.000Z',
      scoreValue: 50,
    });
    expect(evaluation.status).toBe(422);
    expect(errorText(evaluation)).toContain('LeadScoreEvaluation');

    const operation = await call('POST', '/api/v1/LeadConversionOperation', {
      name: `${RUN} forged operation`,
      operationKey: `${RUN}-forged-key`,
      sourceLeadId: leadId,
    });
    expect(operation.status).toBe(422);
    expect(errorText(operation)).toContain('LeadConversionOperation');

    // An edit and a delete are refused the same way: the row is not anyone's to hand-edit.
    const forgedId = await writeAsModule(() =>
      crud().create('LeadConversionOperation', { name: `${RUN} module operation`, operationKey: `${RUN}-guard-target`, sourceLeadId: leadId, status: 'previewed', requestedAt: new Date() }),
    );
    createdRecordIds.push(String(forgedId['id']));
    const edited = await call('PATCH', `/api/v1/LeadConversionOperation/${String(forgedId['id'])}`, { status: 'succeeded' });
    expect(edited.status).toBe(422);
    const deleted = await call('DELETE', `/api/v1/LeadConversionOperation/${String(forgedId['id'])}`);
    expect(deleted.status).toBe(422);
  });

  it('allows the module command to write exactly what a client may not', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} scored`, lastName: `${RUN} scored` });
    const modelId = await createRecord('LeadScoreModel', { name: `${RUN} scored model`, status: 'draft', modelVersion: 2 });

    const evaluation = await writeAsModule(() =>
      crud().create('LeadScoreEvaluation', {
        name: `${RUN} evaluation`,
        leadId,
        modelId,
        modelVersion: 2,
        scoreValue: 10,
        qualificationBand: 'Cold',
        evaluationStatus: 'current',
        calculatedAt: new Date(),
        sourceRevision: 1,
        trigger: 'manual_recalculate',
        resultState: 'success',
        coverage: 0.5,
        idempotencyKey: `${RUN}-eval-1`,
        ruleResults: JSON.stringify([{ reasonCode: 'company_known', outcome: 'matched', points: 10 }]),
        positiveReasonCodes: JSON.stringify(['company_known']),
      }),
    );
    const evaluationId = String(evaluation['id']);
    createdRecordIds.push(evaluationId);

    const projection = await writeAsModule(() =>
      crud().update('Lead', leadId, {
        scoreValue: 10,
        scoreBand: 'Cold',
        scoreStatus: 'current',
        scoreModelId: modelId,
        scoreModelVersion: 2,
        scoreCalculatedAt: new Date(),
        scoreCoverage: 0.5,
        scoreReasonCodes: JSON.stringify(['company_known']),
      }),
    );
    expect(projection['scoreValue']).toBe(10);
    expect(projection['scoreBand']).toBe('Cold');

    // The engine's write is readable by an ordinary API caller: `server-owned` is about who may *set* it.
    const readBack = await call('GET', `/api/v1/Lead/${leadId}`);
    expect(readBack.body['scoreValue']).toBe(10);
    expect(readBack.body['scoreStatus']).toBe('current');

    const stored = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', evaluationId).executeTakeFirstOrThrow();
    expect((stored.attrs as Body)['scoreValue']).toBe(10);
    expect((stored.attrs as Body)['trigger']).toBe('manual_recalculate');
  });
});

describe('the database invariants behind retry safety (19-LS.2)', () => {
  it('makes one operation key mean one conversion result', async () => {
    const leadId = await createRecord('Lead', { name: `${RUN} idempotent`, lastName: `${RUN} idempotent` });
    const operationKey = `${RUN}-op-1`;

    const first = await writeAsModule(() =>
      crud().create('LeadConversionOperation', { name: `${RUN} operation`, operationKey, sourceLeadId: leadId, status: 'previewed', requestedAt: new Date() }),
    );
    createdRecordIds.push(String(first['id']));

    // A replay of the same key is impossible at the storage layer, not merely discouraged by the API: this
    // is what lets 19-LS.13 return the original result instead of creating a second Contact and Account.
    await expect(
      writeAsModule(() =>
        crud().create('LeadConversionOperation', { name: `${RUN} replay`, operationKey, sourceLeadId: leadId, status: 'previewed', requestedAt: new Date() }),
      ),
    ).rejects.toThrow();

    // A different key on the same Lead is a different intent and stays legal — one Lead may be converted
    // through two separate retry attempts, but never through one key twice.
    const second = await writeAsModule(() =>
      crud().create('LeadConversionOperation', { name: `${RUN} second operation`, operationKey: `${RUN}-op-2`, sourceLeadId: leadId, status: 'previewed', requestedAt: new Date() }),
    );
    createdRecordIds.push(String(second['id']));

    // The key is required: an operation without one could not be replayed safely, and the plan makes the
    // key the thing a retry is looked up by (§5.5, §7.8, §11.4).
    const keyless = await call('POST', '/api/v1/LeadConversionOperation', { name: `${RUN} keyless`, sourceLeadId: leadId });
    expect(keyless.status).toBe(422);

    const count = await ctx.database.db
      .selectFrom('entity_records')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('entity_type', '=', 'LeadConversionOperation')
      .where(sql<boolean>`attrs ->> 'sourceLeadId' = ${leadId}`)
      .executeTakeFirst();
    expect(Number(count?.n ?? 0)).toBe(2);
  });

  it('enforces one stable reason code per model version', async () => {
    const modelId = await createRecord('LeadScoreModel', { name: `${RUN} rule model`, status: 'draft', modelVersion: 7 });
    const condition = JSON.stringify({ all: [{ field: 'company', operator: 'isNotEmpty' }] });
    const shared = { modelId, modelVersion: 7, condition, points: 5, reasonCode: 'same_code' };

    const first = await createRecord('LeadScoreRule', { name: `${RUN} rule one`, ...shared });
    expect(first).not.toBe('');

    const duplicate = await call('POST', '/api/v1/LeadScoreRule', { name: `${RUN} rule duplicate`, ...shared });
    // Two rules claiming one reason code would make a stored breakdown ambiguous about what produced a
    // score (plan §3.1, §6.5), so the database refuses it rather than an editor check remembering to.
    expect(duplicate.status, errorText(duplicate)).toBe(409);
    expect(errorText(duplicate)).toContain('DUPLICATE_RECORD');

    // The same code on a different version is a different rule set and stays legal (§5.1 immutability).
    const otherVersion = await createRecord('LeadScoreRule', { name: `${RUN} rule v8`, modelId, modelVersion: 8, condition, points: 5, reasonCode: 'same_code' });
    expect(otherVersion).not.toBe('');
  });

  it('refuses two rows claiming the same model name and version', async () => {
    const name = `${RUN} versioned model`;
    const first = await createRecord('LeadScoreModel', { name, status: 'draft', modelVersion: 3 });
    expect(first).not.toBe('');
    // Created as a draft, because 19-LS.3's guard refuses a client that claims `published` at all — so a
    // 409 here can only come from the database, which is the point: a published version is the provenance
    // of a stored score, and a second row with the same identity would make "which rules produced this 72"
    // unanswerable (plan §5.1).
    const duplicate = await call('POST', '/api/v1/LeadScoreModel', { name, modelVersion: 3 });
    expect(duplicate.status, errorText(duplicate)).toBe(409);
  });
});

describe('registered but inert (19-LS.2)', () => {
  it('still refuses an operation whose phase has not shipped, because schema is not behavior', async () => {
    // Every switch off, explicitly. The settings row is one document shared by every suite against the
    // configured database, so a patch of `{enabled:true}` alone would inherit whatever an earlier suite left
    // on and this assertion would depend on the order tests ran in — which is exactly what "inert" has to
    // survive. The suite's own teardown restores the row it found.
    const switchesOff = Object.fromEntries(Object.keys(DEFAULT_LEADSCORE_SETTINGS.features).map((key) => [key, false]));
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: switchesOff })).status).toBe(200);
    // What LS.2 registered is inert until its own phase arrives. Three phases on, the doors that still name a
    // pending phase are the conversion and insight ones — and each names the sub-phase that owes it.
    for (const [operation, phase] of [
      ['conversionPreview', '19-LS.12'],
      ['conversionExecute', '19-LS.13'],
      ['aiInsight', '19-LS.17'],
    ] as const) {
      const result = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation });
      expect((result.body as { code: string }).code, operation).toBe('LEADSCORE_PHASE_PENDING');
      expect((result.body as { pendingPhase: string }).pendingPhase, operation).toBe(phase);
    }
    // 19-LS.6 delivered the two background recalculation paths, so they no longer name a phase — and with the
    // module switched on and their switches off they still refuse, which is the same rule this suite has
    // always asserted: a registered capability answers for its switch, never for itself.
    for (const operation of ['eventRecalculate', 'batchRecalculate']) {
      const result = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation });
      expect((result.body as { pendingPhase: string | null }).pendingPhase, operation).toBeNull();
      expect((result.body as { code: string }).code, operation).toBe('LEADSCORE_MODULE_DISABLED');
    }
    const health = await call('GET', '/api/v1/LeadScore/action/health');
    expect((health.body as { ready: boolean }).ready).toBe(false);
  });

  it('serves the new entities through the generic API and keeps history off it', async () => {
    const listed = await call('GET', '/api/v1/LeadScoreModel?maxResults=5');
    expect(listed.status).toBe(200);
    const related = await call('GET', `/api/v1/LeadScoreModel/${await createRecord('LeadScoreModel', { name: `${RUN} relation model`, status: 'draft', version: 1 })}/rules`);
    // The declared `rules` oneToMany resolves through `modelId`, so 19-LS.3's editor can read a model's
    // rules without a bespoke endpoint (plan §5.2).
    expect(related.status).toBe(200);
    expect(Array.isArray((related.body as { list?: unknown[] }).list ?? related.body)).toBe(true);
  });

  it('registers its guards with the platform hook registry', () => {
    const names = new Set((ctx.app.get(HookRegistry, { strict: false }) as HookRegistry).list().map((hook) => `${hook.phase}:${hook.name}`));
    expect(names.has('beforeValidate:leadScore.leadFieldGuard')).toBe(true);
    expect(names.has('beforeValidate:leadScore.LeadScoreEvaluationGuard')).toBe(true);
    expect(names.has('beforeValidate:leadScore.LeadConversionOperationGuard')).toBe(true);
  });
});
