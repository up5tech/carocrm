import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LeadScoreSettingsService } from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { type SalesFixture, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 22.8 — the journey: lead acquisition, scoring, qualification, and conversion
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §13.1, steps 1–10).
 *
 * One story, in order, through the public contracts only: a Lead arrives, the active model scores
 * it, a campaign engagement moves its band, the band says "Sales Ready" and **nothing happens** —
 * no conversion, no Sales record, no access — until a person explicitly asks for it. Then the
 * conversion creates the identities, the Sales module can use them, a retry changes nothing, and a
 * caller without the right is refused.
 *
 * The steps are deliberately **one ordered `describe`**: this is a journey, and a journey that
 * asserted its halves separately would not prove that the halves fit together. The order is the
 * test's contract, so each `it` states what the previous one left behind.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No database is created, reset or
 * truncated; every record is created with an `AGENT_TEST_LS22_` marker and deleted by exact id.
 * No provider is contacted: the campaign signal is a row the test seeds in Marketing Automation's
 * own `marketing_events` table, exactly as the module writes it.
 */

const RUN = `AGENT_TEST_LS22_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const RECALCULATE_PATH = '/api/v1/LeadScore/action/score/recalculate';
const SCORE_PATH = '/api/v1/LeadScore/action/score';
const PREVIEW_PATH = '/api/v1/LeadScore/action/conversion/preview';
const CONVERT_PATH = '/api/v1/LeadScore/action/conversion/convert';
const CAMPAIGN_ID = `${RUN}_campaign`;

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

let ctx: ApiContext;
let sales: SalesFixture;
let previousSettings: string | null = null;
let modelId = '';
let leadId = '';
let contactId = '';
let accountId = '';
let opportunityId = '';
let operationId = '';
let operationKey = '';
let previewHash = '';
let acknowledged: string[] = [];
let restrictedToken = '';
const created = { records: [] as string[], events: [] as string[], outbox: [] as string[], users: [] as string[], roles: [] as string[] };

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  token?: string,
): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Body }),
  });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function createRecord(entity: string, data: Body): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, `${entity}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  created.records.push(id);
  return id;
}

async function setSettings(patch: Body): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function readLead(id: string): Promise<Body> {
  const result = await call('GET', `/api/v1/Lead/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function countRows(entity: string): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count from entity_records where entity_type = ${entity} and deleted_at is null
  `.execute(ctx.database.db);
  return Number(rows.rows[0]?.count ?? 0);
}

/**
 * The events of **this journey's** Lead.
 *
 * Scoped to the Lead on purpose: the shared database holds the events of every other suite, and a
 * journey that counted them would be asserting about somebody else's work — and its cleanup would
 * delete rows it does not own.
 */
async function outboxRows(type: string): Promise<Body[]> {
  const rows = await ctx.database.db
    .selectFrom('outbox_events')
    .select(['id', 'payload'])
    .where('event_type', '=', type)
    .where(sql`payload ->> 'leadId'`, '=', leadId)
    .execute();
  rows.forEach((row) => created.outbox.push(row.id));
  return rows.map((row) => (row.payload ?? {}) as Body);
}

/**
 * The scoring model: a completeness rule on the Lead, an engagement rule on the campaign signal
 * and a fit rule on the industry. 10 + 20 = 30 (Cold), + 40 = 70 (Hot), + 20 = 90 (Sales Ready).
 */
async function createPublishedModel(): Promise<string> {
  const id = await createRecord('LeadScoreModel', {
    name: `${RUN} model`,
    description: 'The model the Phase 22.8 journey scores with.',
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
    // The grant names the Lead fields only: an engagement metric is not a Lead path.
    allowedFieldPaths: JSON.stringify(['company', 'industry']),
  });
  await createRecord('LeadScoreRule', {
    name: `${RUN} company`,
    modelId: id,
    modelVersion: 1,
    reasonCode: `ls22_company_${id.slice(-6)}`,
    dimension: 'completeness',
    enabled: true,
    condition: JSON.stringify({ field: 'company', operator: 'isNotEmpty' }),
    effect: 'add',
    points: 20,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  await createRecord('LeadScoreRule', {
    name: `${RUN} opened twice`,
    modelId: id,
    modelVersion: 1,
    reasonCode: `ls22_opened_${id.slice(-6)}`,
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
  });
  await createRecord('LeadScoreRule', {
    name: `${RUN} software fit`,
    modelId: id,
    modelVersion: 1,
    reasonCode: `ls22_fit_${id.slice(-6)}`,
    dimension: 'fit',
    enabled: true,
    condition: JSON.stringify({ field: 'industry', operator: 'equals', value: 'Software' }),
    effect: 'add',
    points: 20,
    priority: 30,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  const published = await call('POST', '/api/v1/LeadScore/action/model/publish', { modelId: id });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return id;
}

/** The campaign signal: a Marketing Automation event addressed to this Lead. */
async function insertCampaignEvent(lead: string): Promise<void> {
  const id = `${RUN}_evt_${String(created.events.length)}`;
  await sql`
    insert into marketing_events
      (id, provider, event_type, normalized_type, occurred_at, campaign_id,
       recipient_entity_type, recipient_entity_id, properties)
    values
      (${id}, 'agent_test', 'open', 'opened', ${new Date()}, ${CAMPAIGN_ID},
       'Lead', ${lead}, ${JSON.stringify({})}::jsonb)
  `.execute(ctx.database.db);
  created.events.push(id);
}

beforeAll(async () => {
  ctx = await bootApi();
  sales = await salesFixture(ctx);
  const row = await ctx.database.db
    .selectFrom('app_settings')
    .select('data')
    .where('name', '=', SETTINGS_ROW)
    .executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);

  modelId = await createPublishedModel();
  await setSettings({
    enabled: true,
    features: {
      modelAdministration: true,
      scoringPreview: true,
      scoring: true,
      manualRecalculation: true,
      scoreExplanation: true,
      eventRecalculation: true,
      batchRecalculation: true,
      thresholdNotifications: true,
      engagementSignals: true,
      fieldMapping: true,
      conversionPreview: true,
      leadConversion: true,
      conversionRecovery: true,
      opportunityConversion: true,
      duplicateDetection: true,
    },
    scoring: { activeModelId: modelId },
  });
  // A caller with no LeadScore right at all, and only "own" records: the negative path needs one.
  // The read level matters — a record the caller may not see is *missing* (404), not forbidden.
  await createTestRole(ctx, {
    id: `${RUN}_role`,
    name: `${RUN} role`,
    permissions: { Lead: { read: 'own' }, Contact: { read: 'own' }, Account: { read: 'own' } },
  });
  const outsider = await createTestUser(ctx, { userName: `${RUN}_user`, roleIds: [`${RUN}_role`] });
  restrictedToken = outsider.token;
  created.users.push(outsider.id);
  created.roles.push(`${RUN}_role`);
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
  ctx.app.get(LeadScoreSettingsService, { strict: false }).invalidate();

  if (created.events.length > 0) {
    await db.deleteFrom('marketing_events').where('id', 'in', created.events).execute().catch(() => undefined);
  }
  if (created.records.length > 0) {
    const linked = await db
      .selectFrom('entity_links')
      .select('id')
      .where((eb) => eb.or([eb('record_id_a', 'in', created.records), eb('record_id_b', 'in', created.records)]))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (linked.length > 0) {
      await db.deleteFrom('entity_links').where('id', 'in', linked.map((entry) => entry.id)).execute().catch(() => undefined);
    }
    await db.deleteFrom('entity_records').where('id', 'in', created.records).execute().catch(() => undefined);
  }
  if (created.outbox.length > 0) {
    await db.deleteFrom('outbox_events').where('id', 'in', created.outbox).execute().catch(() => undefined);
  }
  await sales.cleanup();
  if (created.users.length > 0) await db.deleteFrom('users').where('id', 'in', created.users).execute().catch(() => undefined);
  if (created.roles.length > 0) await db.deleteFrom('roles').where('id', 'in', created.roles).execute().catch(() => undefined);
  await shutdownApi();
}, 240_000);

describe('the journey: a Lead becomes a customer (22.8)', () => {
  it('step 1 — the journey starts with a Lead the CRM owns', async () => {
    leadId = await createRecord('Lead', {
      name: `${RUN} Acme`,
      firstName: 'Journey',
      lastName: 'Lead',
      company: `${RUN} Acme`,
      emailAddress: `${RUN.toLowerCase()}@example.test`,
      industry: 'Retail',
      source: 'Web Form',
      status: 'New',
    });

    const lead = await readLead(leadId);
    expect(lead['status']).toBe('New');
    expect(lead['source']).toBe('Web Form');
    // Nothing has been scored yet, and nothing has been converted.
    expect(lead['scoreStatus']).toBe('not_scored');
    expect(lead['scoreBand']).toBe('Unknown');
    expect(lead['convertedAccountId'] ?? null).toBeNull();
    expect(lead['convertedContactId'] ?? null).toBeNull();
    expect(lead['conversionOperationId'] ?? null).toBeNull();
  });

  it('step 3 — the active model scores the Lead, and the history explains it', async () => {
    const scored = await call('POST', RECALCULATE_PATH, { leadId });
    expect(scored.status, JSON.stringify(scored.body)).toBe(200);

    const lead = await readLead(leadId);
    expect(lead['scoreValue']).toBe(30);
    expect(lead['scoreBand']).toBe('Cold');
    expect(lead['scoreStatus']).toBe('current');
    expect(lead['scoreModelId']).toBe(modelId);

    // The score history is explainable: it names the rule, and it carries no Lead value.
    const history = await call('GET', `${SCORE_PATH}/${leadId}/history?limit=10&offset=0`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const body = history.body as unknown as { total: number; items: Body[] };
    expect(body.total).toBe(1);
    const breakdown = (body.items[0]?.['breakdown'] ?? []) as Body[];
    expect(breakdown.map((entry) => entry['reasonCode'])).toContain(`ls22_company_${modelId.slice(-6)}`);
    expect(JSON.stringify(body.items[0])).not.toContain(`${RUN.toLowerCase()}@example.test`);
  });

  it('step 4 — a campaign engagement moves the band, and a repeated signal does not overcount', async () => {
    await insertCampaignEvent(leadId);
    await insertCampaignEvent(leadId);

    const scored = await call('POST', RECALCULATE_PATH, { leadId });
    expect(scored.status, JSON.stringify(scored.body)).toBe(200);
    const lead = await readLead(leadId);
    expect(lead['scoreValue']).toBe(70);
    expect(lead['scoreBand']).toBe('Hot');

    const before = await call('GET', `${SCORE_PATH}/${leadId}/history?limit=50&offset=0`);
    const total = Number((before.body as unknown as { total: number }).total);

    // The same inputs again: the evaluation key makes it a no-op, so nothing is counted twice.
    await call('POST', RECALCULATE_PATH, { leadId });
    const after = await call('GET', `${SCORE_PATH}/${leadId}/history?limit=50&offset=0`);
    expect(Number((after.body as unknown as { total: number }).total)).toBe(total);
    expect((await readLead(leadId))['scoreValue']).toBe(70);
  });

  it('step 4b — a direct field change moves the band to Sales Ready', async () => {
    const patched = await call('PATCH', `/api/v1/Lead/${leadId}`, { industry: 'Software' });
    expect(patched.status, JSON.stringify(patched.body)).toBeLessThan(300);

    await call('POST', RECALCULATE_PATH, { leadId });
    const lead = await readLead(leadId);
    expect(lead['scoreValue']).toBe(90);
    expect(lead['scoreBand']).toBe('Sales Ready');
  });

  it('step 5 — a qualified band converts nothing and grants nothing', async () => {
    const contactsBefore = await countRows('Contact');
    const accountsBefore = await countRows('Account');
    const opportunitiesBefore = await countRows('Opportunity');

    const lead = await readLead(leadId);
    expect(lead['scoreBand']).toBe('Sales Ready');
    // The band is a prioritisation signal. It is not a lifecycle field and it is not a permission.
    expect(lead['status']).toBe('New');
    expect(lead['convertedAccountId'] ?? null).toBeNull();
    expect(lead['convertedContactId'] ?? null).toBeNull();
    expect(lead['convertedOpportunityId'] ?? null).toBeNull();
    expect(lead['conversionOperationId'] ?? null).toBeNull();

    expect(await countRows('Contact')).toBe(contactsBefore);
    expect(await countRows('Account')).toBe(accountsBefore);
    expect(await countRows('Opportunity')).toBe(opportunitiesBefore);

    // The only reaction the module is allowed to make is an event and a notification.
    const bandChanges = await outboxRows('leadScore.bandChanged.v1');
    expect(bandChanges.some((payload) => payload['leadId'] === leadId)).toBe(true);
    expect(await outboxRows('lead.conversionSucceeded.v1')).toHaveLength(0);
  });

  it('step 6 — the conversion is an explicit user choice, previewed first', async () => {
    const targets = [
      { type: 'Account', action: 'create' },
      { type: 'Contact', action: 'create' },
      { type: 'Opportunity', action: 'create' },
    ];
    const preview = await call('POST', PREVIEW_PATH, { leadId, targets });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const body = preview.body as unknown as { previewHash: string; confirmationTypes: string[] };
    expect(body.previewHash).not.toBe('');
    expect(body.confirmationTypes.length).toBeGreaterThan(0);
    // A preview writes nothing.
    expect((await readLead(leadId))['status']).toBe('New');
  });

  it('step 7 — the conversion creates the identities and links them correctly', async () => {
    const targets = [
      { type: 'Account', action: 'create' },
      { type: 'Contact', action: 'create' },
      { type: 'Opportunity', action: 'create' },
    ];
    const preview = await call('POST', PREVIEW_PATH, { leadId, targets });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const prepared = preview.body as unknown as { previewHash: string; confirmationTypes: string[] };
    previewHash = prepared.previewHash;
    acknowledged = prepared.confirmationTypes;

    operationKey = `${RUN}_op_1`;
    const converted = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey,
      targets,
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
    });
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    const result = converted.body as unknown as {
      operationId: string;
      status: string;
      createdAccountId: string | null;
      createdContactId: string | null;
      createdOpportunityId: string | null;
    };
    operationId = result.operationId;
    created.records.push(operationId);
    expect(result.status).toBe('succeeded');
    accountId = String(result.createdAccountId ?? '');
    contactId = String(result.createdContactId ?? '');
    opportunityId = String(result.createdOpportunityId ?? '');
    expect(accountId).not.toBe('');
    expect(contactId).not.toBe('');
    expect(opportunityId).not.toBe('');
    created.records.push(accountId, contactId, opportunityId);

    const lead = await readLead(leadId);
    expect(lead['status']).toBe('Converted');
    expect(lead['convertedAccountId']).toBe(accountId);
    expect(lead['convertedContactId']).toBe(contactId);
    expect(lead['convertedOpportunityId']).toBe(opportunityId);
    expect(lead['conversionOperationId']).toBe(operationId);
    expect(lead['convertedAt']).not.toBeNull();

    // The relationships are the ones the policy owns, not the ones a mapping could have invented.
    const contact = await call('GET', `/api/v1/Contact/${contactId}`);
    expect(contact.status).toBe(200);
    expect(contact.body['accountId']).toBe(accountId);
    // The source travels with the person, not just with the account.
    expect(contact.body['leadSource']).toBe('Web Form');
    expect(contact.body['firstName']).toBe('Journey');
    expect(contact.body['emailAddress']).toBe(`${RUN.toLowerCase()}@example.test`);

    const account = await call('GET', `/api/v1/Account/${accountId}`);
    expect(account.status).toBe(200);
    expect(account.body['name']).toBe(`${RUN} Acme`);
    expect(account.body['industry']).toBe('Software');

    const opportunity = await call('GET', `/api/v1/Opportunity/${opportunityId}`);
    expect(opportunity.status).toBe(200);
    expect(opportunity.body['accountId']).toBe(accountId);
    expect((opportunity.body['contactIds'] ?? []) as string[]).toContain(contactId);
    // The conversion writes no selling semantics: the stage and the amount stay Sales'.
    expect(opportunity.body['stage']).toBe('Qualification');
    expect(opportunity.body['amount'] ?? null).toBeNull();
    expect(opportunity.body['leadSource']).toBe('Web Form');
  });

  it('step 8 — the Sales module can use the Account the journey produced', async () => {
    const product = await sales.createProduct({ sku: `${RUN}-Q1`, unitPrice: '50.00' });
    const created8 = await sales.call('POST', '/api/v1/Sales/document', {
      kind: 'quote',
      data: {
        name: `${RUN} Quote`,
        accountId,
        currency: 'USD',
        quoteDate: '2026-10-28',
      },
      items: [{ productId: product, quantity: '1', unitPrice: '50.00', taxRatePercent: '0' }],
    });
    expect(created8.status, JSON.stringify(created8.body)).toBe(201);
    const quote = created8.body as unknown as { id: string; document: Body };
    expect(quote.document['accountId']).toBe(accountId);
    expect(quote.document['status']).toBe('draft');

    // The draft quote is the journey's own record: it is removed by its own id, like every other
    // record this journey creates.
    created.records.push(quote.id);
    const removed = await sales.call('DELETE', `/api/v1/Sales/document/quote/${quote.id}`);
    expect(removed.status).toBe(204);
  });

  it('step 9 — the same conversion key replays instead of duplicating', async () => {
    const contactsBefore = await countRows('Contact');
    const accountsBefore = await countRows('Account');
    const opportunitiesBefore = await countRows('Opportunity');
    const eventsBefore = (await outboxRows('lead.conversionSucceeded.v1')).length;

    const targets = [
      { type: 'Account', action: 'create' },
      { type: 'Contact', action: 'create' },
      { type: 'Opportunity', action: 'create' },
    ];
    const replay = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey,
      targets,
      previewHash,
      acknowledged,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(String((replay.body as unknown as { operationId: string }).operationId)).toBe(operationId);

    expect(await countRows('Contact')).toBe(contactsBefore);
    expect(await countRows('Account')).toBe(accountsBefore);
    expect(await countRows('Opportunity')).toBe(opportunitiesBefore);
    expect((await outboxRows('lead.conversionSucceeded.v1')).length).toBe(eventsBefore);
  });

  it('step 10 — a caller without the right cannot convert, and cannot read the result', async () => {
    const refused = await call(
      'POST',
      CONVERT_PATH,
      {
        leadId,
        operationKey: `${RUN}_op_denied`,
        targets: [{ type: 'Contact', action: 'create' }],
        previewHash,
        acknowledged,
      },
      restrictedToken,
    );
    expect(refused.status).toBe(403);
    expect((refused.body['error'] as { code?: string } | undefined)?.code).toBe('AUTHORIZATION_DENIED');

    // The disclosure policy: a record the caller may not see is missing, not forbidden.
    const hidden = await call('GET', `/api/v1/Contact/${contactId}`, undefined, restrictedToken);
    expect(hidden.status).toBe(404);
  });

  it('step 11 — a stale preview is refused, and nothing is written behind it', async () => {
    const otherLead = await createRecord('Lead', {
      name: `${RUN} Stale`,
      lastName: `${RUN} Stale`,
      company: `${RUN} Stale Co`,
      emailAddress: `${RUN.toLowerCase()}.stale@example.test`,
      status: 'New',
    });
    const targets = [{ type: 'Contact', action: 'create' }];
    const preview = await call('POST', PREVIEW_PATH, { leadId: otherLead, targets });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const prepared = preview.body as unknown as { previewHash: string; confirmationTypes: string[] };

    // The Lead changes after the preview: the fingerprint is stale and the command refuses.
    await call('PATCH', `/api/v1/Lead/${otherLead}`, { company: `${RUN} Changed Co` });
    const refused = await call('POST', CONVERT_PATH, {
      leadId: otherLead,
      operationKey: `${RUN}_op_stale`,
      targets,
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
    });
    expect(refused.status).toBe(409);
    expect((refused.body['error'] as { code?: string } | undefined)?.code).toBe('LEADSCORE_PREVIEW_STALE');

    const lead = await readLead(otherLead);
    expect(lead['status']).toBe('New');
    expect(lead['conversionOperationId'] ?? null).toBeNull();
  });

  it('step 12 — the events and the audit trail match what the journey did', async () => {
    const succeeded = await outboxRows('lead.conversionSucceeded.v1');
    const mine = succeeded.filter((payload) => payload['leadId'] === leadId);
    expect(mine).toHaveLength(1);
    expect((mine[0]?.['targets'] ?? {}) as Body).toMatchObject({
      created: {
        createdContactId: contactId,
        createdAccountId: accountId,
        createdOpportunityId: opportunityId,
      },
    });

    // The score events are there too, and they carry no Lead data.
    const updated = (await outboxRows('leadScore.updated.v1')).filter((payload) => payload['leadId'] === leadId);
    expect(updated.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(updated)).not.toContain(`${RUN.toLowerCase()}@example.test`);

    // The conversion is audited: the Lead's converted fields each produced one audit row.
    const audits = await ctx.database.db
      .selectFrom('audit_log')
      .select(['action', 'record_id', 'data'])
      .where('entity_type', '=', 'Lead')
      .where('record_id', '=', leadId)
      .execute();
    const fields = audits
      .map((row) => String((row.data as { field?: string } | null)?.field ?? ''))
      .filter((field) => field !== '');
    expect(fields).toContain('convertedAccountId');
    expect(fields).toContain('convertedContactId');
    expect(fields).toContain('conversionOperationId');
  });
});
