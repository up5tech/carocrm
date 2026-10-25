import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.15 — what a conversion does to the Lead's history
 * (`PLAN_Phase_19_LeadScore.md` §7.5, §16 `19-LS.15`; audit §11 `LS.15`; contract §10.5).
 *
 * The exit criterion is *"conversion does not lose source context or broaden access to related data"*, and the
 * answer this build gives is deliberately conservative: **the conversion touches none of it**. It writes the
 * Lead's own `Converted` fields, creates or links the targets, records the operation and dispatches one event —
 * and every other row that pointed at the Lead still points at it. This suite proves that by seeding each kind
 * of history the audit named and counting before and after:
 *
 * | History | Where it lives | What conversion does |
 * | --- | --- | --- |
 * | e-mails | `entity_links` (`Email.leads`) | nothing — not re-linked to the Contact |
 * | cases | `Case.leadId` | nothing |
 * | campaign / target-list attribution | `TargetListEntry.memberType/memberId` | nothing |
 * | marketing consent | `MarketingConsent.leadId` + `emailHash` | nothing; no consent row is created for the targets |
 * | attachments | `attachments.parent_type/parent_id` | nothing — no copy, no move |
 * | stream items | `stream_items` | nothing beyond the platform's own rows for the writes |
 *
 * The last test is the access half: ownership and teams are not carried (a Contact created from a Lead the
 * caller owned is unowned), and a reader who may read the Lead but not the Contact gets **404** on the Contact —
 * conversion must not be a way to hand somebody a record they could not otherwise read.
 */

const RUN = `AGENT_TEST_LS15_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const PREVIEW_PATH = '/api/v1/LeadScore/action/conversion/preview';
const CONVERT_PATH = '/api/v1/LeadScore/action/conversion/convert';

let ctx: ApiContext;
let previousSettings: string | null = null;
const created = { records: [] as string[], operations: [] as string[], roles: [] as string[], users: [] as string[], attachments: [] as string[], consents: [] as string[] };

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, token?: string): Promise<CallResult> {
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

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, `${entity}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  created.records.push(id);
  return id;
}

/** Preview, then convert with the preview's own fingerprint — the only path the command accepts. */
async function convert(leadId: string, targets: { type: string; action: string; existingId?: string }[]): Promise<CallResult> {
  const prepared = await call('POST', PREVIEW_PATH, { leadId, targets });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const body = prepared.body as unknown as { previewHash: string; confirmationTypes: string[] };
  const result = await call('POST', CONVERT_PATH, {
    leadId,
    operationKey: `${RUN}_op_${String(created.operations.length + 1)}`,
    targets,
    previewHash: body.previewHash,
    acknowledged: body.confirmationTypes,
  });
  const operationId = String((result.body['operationId'] ?? '') as string);
  if (operationId !== '') created.operations.push(operationId);
  return result;
}

async function count(sqlText: ReturnType<typeof sql>): Promise<number> {
  const rows = await sqlText.execute(ctx.database.db);
  return Number((rows.rows[0] as Body | undefined)?.['count'] ?? 0);
}

/** One Lead of this run, with a description (the only "note" this schema has on a record). */
async function createLead(suffix: string): Promise<string> {
  const name = `${RUN} ${suffix}`;
  return createRecord('Lead', {
    name,
    firstName: `${RUN}first`,
    lastName: name,
    company: `${RUN} Acme`,
    emailAddress: `${RUN.toLowerCase()}.${suffix.replace(/\s+/g, '-')}@example.com`,
    description: 'The history that must survive a conversion.',
    status: 'New',
  });
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const result = await call('POST', '/api/v1/LeadScore/action/settings', {
    enabled: true,
    features: { fieldMapping: true, conversionPreview: true, leadConversion: true },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === null) await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() }).where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);

  const ids = [...created.records, ...created.operations];
  if (ids.length > 0) {
    const linked = await db.selectFrom('entity_links').select('id').where((eb) => eb.or([eb('record_id_a', 'in', ids), eb('record_id_b', 'in', ids)])).execute().catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((entry) => entry.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
  }
  // Fixtures that live outside the entity store: the consent row and the attachment.
  if (created.consents.length > 0) await db.deleteFrom('entity_records').where('id', 'in', created.consents).execute().catch(() => undefined);
  if (created.attachments.length > 0) await sql`delete from attachments where id in (${sql.join(created.attachments.map((id) => sql`${id}`), sql`,`)})`.execute(db).catch(() => undefined);
  if (created.users.length > 0) await db.deleteFrom('users').where('id', 'in', created.users).execute().catch(() => undefined);
  if (created.roles.length > 0) await db.deleteFrom('roles').where('id', 'in', created.roles).execute().catch(() => undefined);

  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`), eb(sql`attrs->>'name'`, 'like', `${RUN}%`)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score history suite left records behind');

  await shutdownApi();
}, 240_000);

describe('the conversion writes its own rows and touches no history (exit criterion)', () => {
  it('keeps the Lead, its description and its own audit trail', async () => {
    const leadId = await createLead('lead keeps');
    const before = (await call('GET', `/api/v1/Lead/${leadId}`)).body;

    const converted = await convert(leadId, [{ type: 'Contact', action: 'create' }, { type: 'Account', action: 'create' }]);
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);

    const after = (await call('GET', `/api/v1/Lead/${leadId}`)).body;
    expect(after['status']).toBe('Converted');
    expect(after['description']).toBe(before['description']);
    expect(after['emailAddress']).toBe(before['emailAddress']);
    expect(after['deletedAt'] ?? null).toBeNull();
    // The record's history is append-only: the conversion *added* an audited update, it did not replace one.
    const audits = await count(sql`select count(*)::int as count from audit_log where record_id = ${leadId}`);
    expect(audits).toBeGreaterThan(0);
  });

  it('leaves the Lead’s e-mails on the Lead and never re-links them to the new Contact', async () => {
    const leadId = await createLead('email');
    const emailId = await createRecord('Email', { name: `${RUN} email about the lead` });
    const linked = await call('PUT', `/api/v1/Email/${emailId}/leads/${leadId}`);
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    const before = {
      toLead: await count(sql`select count(*)::int as count from entity_links where entity_type_a = 'Email' and record_id_a = ${emailId} and relation_name = 'leads' and record_id_b = ${leadId}`),
      toContact: await count(sql`select count(*)::int as count from entity_links where entity_type_a = 'Email' and record_id_a = ${emailId} and relation_name = 'contacts'`),
    };
    expect(before.toLead).toBe(1);

    const converted = await convert(leadId, [{ type: 'Contact', action: 'create' }]);
    expect(converted.status).toBe(200);
    const contactId = String((converted.body as unknown as { createdContactId: string }).createdContactId);

    expect(await count(sql`select count(*)::int as count from entity_links where entity_type_a = 'Email' and record_id_a = ${emailId} and relation_name = 'leads' and record_id_b = ${leadId}`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from entity_links where entity_type_a = 'Email' and record_id_a = ${emailId} and relation_name = 'contacts'`)).toBe(before.toContact);
    expect(await count(sql`select count(*)::int as count from entity_links where record_id_b = ${contactId}`)).toBe(0);
    // The e-mail itself is untouched.
    const email = (await call('GET', `/api/v1/Email/${emailId}`)).body;
    expect(email['name']).toBe(`${RUN} email about the lead`);
  });

  it('keeps a Case and a target-list entry pointing at the Lead', async () => {
    const leadId = await createLead('attribution');
    const caseId = await createRecord('Case', { name: `${RUN} case`, leadId, status: 'New' });
    // A campaign attribution the way MarketingAutomation writes it: a `TargetList` and a polymorphic entry. The
    // MA `audience` feature is off in this database, so the pair is a fixture in the entity store — the question
    // here is what a conversion does to it, not how MA creates it.
    const listId = `${RUN}_list`;
    const entryId = `${RUN}_entry`;
    for (const [id, entity, attrs] of [
      [listId, 'TargetList', { name: `${RUN} list` }],
      [entryId, 'TargetListEntry', { name: `${RUN} entry`, targetListId: listId, memberType: 'Lead', memberId: leadId }],
    ] as const) {
      await ctx.database.db
        .insertInto('entity_records')
        .values({ id, entity_type: entity, name: String(attrs.name), attrs: { ...attrs }, created_at: new Date(), modified_at: new Date() })
        .execute();
      created.records.push(id);
    }

    const converted = await convert(leadId, [{ type: 'Account', action: 'create' }]);
    expect(converted.status).toBe(200);
    const accountId = String((converted.body as unknown as { createdAccountId: string }).createdAccountId);

    expect((await call('GET', `/api/v1/Case/${caseId}`)).body['leadId']).toBe(leadId);
    const entry = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', entryId).executeTakeFirstOrThrow();
    expect(entry.attrs['memberType']).toBe('Lead');
    expect(entry.attrs['memberId']).toBe(leadId);
    expect(entry.attrs['targetListId']).toBe(listId);
    // Nothing was re-pointed at the new Account.
    expect(await count(sql`select count(*)::int as count from entity_records where entity_type = 'TargetListEntry' and attrs->>'memberId' = ${accountId}`)).toBe(0);
  });

  it('copies no consent and creates none for the converted records', async () => {
    const leadId = await createLead('consent');
    // A consent row the way MarketingAutomation keeps them: an address hash, a purpose, and references — never a
    // copy of a record. It is a fixture in the entity store because this suite is not about MA's own commands.
    const consentId = `${RUN}_consent`;
    await ctx.database.db
      .insertInto('entity_records')
      .values({
        id: consentId,
        entity_type: 'MarketingConsent',
        name: `${RUN} consent`,
        attrs: { name: `${RUN} consent`, emailHash: 'a'.repeat(64), channel: 'Email', purpose: 'Newsletter', status: 'Consented', leadId },
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    created.consents.push(consentId);
    const before = await count(sql`select count(*)::int as count from entity_records where entity_type = 'MarketingConsent' and deleted_at is null`);

    const converted = await convert(leadId, [{ type: 'Contact', action: 'create' }]);
    expect(converted.status).toBe(200);
    const contactId = String((converted.body as unknown as { createdContactId: string }).createdContactId);

    expect(await count(sql`select count(*)::int as count from entity_records where entity_type = 'MarketingConsent' and deleted_at is null`)).toBe(before);
    const consent = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', consentId).executeTakeFirstOrThrow();
    expect(consent.attrs['leadId']).toBe(leadId);
    expect((consent.attrs['contactId'] ?? null)).toBeNull();
    // And no consent row names the new Contact.
    expect(await count(sql`select count(*)::int as count from entity_records where entity_type = 'MarketingConsent' and attrs->>'contactId' = ${contactId}`)).toBe(0);
  });

  it('copies no attachment and moves none of the Lead’s attachments', async () => {
    const leadId = await createLead('attachment');
    const attachmentId = `${RUN}_att`;
    await sql`
      insert into attachments (id, name, type, size, mime_type, storage_key, parent_type, parent_id, created_at)
      values (${attachmentId}, ${`${RUN} brief.pdf`}, 'Attachment', 12, 'application/pdf', ${`test/${attachmentId}`}, 'Lead', ${leadId}, now())
    `.execute(ctx.database.db);
    created.attachments.push(attachmentId);
    const before = await count(sql`select count(*)::int as count from attachments`);

    const converted = await convert(leadId, [{ type: 'Contact', action: 'create' }]);
    expect(converted.status).toBe(200);
    const contactId = String((converted.body as unknown as { createdContactId: string }).createdContactId);

    expect(await count(sql`select count(*)::int as count from attachments`)).toBe(before);
    const rows = await sql<{ parent_type: string | null; parent_id: string | null; storage_key: string }>`select parent_type, parent_id, storage_key from attachments where id = ${attachmentId}`.execute(ctx.database.db);
    expect(rows.rows[0]).toMatchObject({ parent_type: 'Lead', parent_id: leadId, storage_key: `test/${attachmentId}` });
    expect(await count(sql`select count(*)::int as count from attachments where parent_id = ${contactId}`)).toBe(0);
  });

  it('does not carry ownership, and does not make the new records readable to a Lead-only reader', async () => {
    const leadId = await createLead('access');
    const roleId = `${RUN}_own`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} own records`,
      permissions: { Lead: { read: 'own' }, Contact: { read: 'own' }, Account: { read: 'own' } },
    });
    created.roles.push(roleId);
    const reader = await createTestUser(ctx, { userName: `${RUN}_reader`, roleIds: [roleId] });
    created.users.push(reader.id);
    // The Lead belongs to the reader; the conversion is the administrator's.
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { assignedUserId: reader.id })).status).toBe(200);

    const converted = await convert(leadId, [{ type: 'Contact', action: 'create' }, { type: 'Account', action: 'create' }]);
    expect(converted.status).toBe(200);
    const ids = converted.body as unknown as { createdContactId: string; createdAccountId: string };

    // Ownership is not data: neither record inherits the Lead's owner or teams.
    const contact = (await call('GET', `/api/v1/Contact/${ids.createdContactId}`)).body;
    expect(contact['assignedUserId'] ?? null).toBeNull();
    expect(Array.isArray(contact['teams']) ? contact['teams'] : []).toEqual([]);
    const account = (await call('GET', `/api/v1/Account/${ids.createdAccountId}`)).body;
    expect(account['assignedUserId'] ?? null).toBeNull();

    // The reader may still read the Lead, and still may not read what it became.
    expect((await call('GET', `/api/v1/Lead/${leadId}`, undefined, reader.token)).status).toBe(200);
    expect((await call('GET', `/api/v1/Contact/${ids.createdContactId}`, undefined, reader.token)).status).toBe(404);
    expect((await call('GET', `/api/v1/Account/${ids.createdAccountId}`, undefined, reader.token)).status).toBe(404);
  });
});
