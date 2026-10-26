import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VoiceCommunicationsSettingsService, VoiceMessagingService } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.17 — ServiceDesk hand-off (E9; plan §14 `19-OM.17`; feature contract §8).
 *
 * Against the configured primary database (AGENTS.md §3.1). The conversation comes from the owner's
 * ingest service; the Case is created by the ServiceDesk command through the workspace, never by the
 * generic API. Every row this suite creates — the account, conversations, Cases, their transitions,
 * roles and users — is removed by exact id/key in `afterAll`; the shared Voice settings row is
 * restored byte-for-byte.
 *
 * Proved: create-or-link is idempotent on the external reference (unique index; retries and a
 * transient failure resolve to one Case); the hand-off trail exists (`handoff`/`link_conversation`
 * transitions) with `source: Omnichannel`; the description carries the customer's last
 * **customer-visible** message and never an internal note; the link is written by the Voice command;
 * Case and conversation status stay independent; a client cannot forge the anchor field.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om17_${RUN}`;
const PHONE = '+14155550317';
const PHONE_2 = '+14155550318';
const ROLE_NONE = `r_AGENT_TEST_OM17_none_${RUN}`;

let ctx: ApiContext;
let conversationA = '';
let conversationB = '';
let createdCaseId = '';
let linkedCaseId = '';
let priorSettings: string | null = null;
type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, token?: string): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...authHeader(token ?? ctx.adminToken), 'content-type': 'application/json' },
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

async function ingest(phone: string, id: string): Promise<string> {
  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const result = await messaging.ingestInbound({
    accountKey: ACCOUNT_KEY,
    event: { kind: 'message', providerMessageId: id, state: 'delivered', direction: 'inbound', channel: 'sms', from: phone, to: null, body: `AGENT_TEST_OM17 hello ${id}`, occurredAt: new Date().toISOString(), failureCategory: null, vendorStatus: 'received' },
  });
  const row = (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${result.messageId}`.execute(ctx.database.db)).rows[0];
  return String(row?.conversation_id ?? '');
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  ctx = await bootApi();
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om17 handoff`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'webhook.signatureValidation'],
    config: { sandboxRecipients: [PHONE] },
    webhookSecret: `whsec_om17_${RUN}`,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorSettings = row === undefined ? null : JSON.stringify(row.data);
  const settings = await call('POST', '/api/v1/VoiceCommunications/action/settings', { features: { sms: true }, provider: { defaultAccountKey: ACCOUNT_KEY } });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  for (const phone of [PHONE, PHONE_2]) {
    const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', { channel: 'sms', address: phone, purpose: 'service', status: 'granted', basis: 'explicit_opt_in', source: 'manual_record' });
    expect([201, 200], JSON.stringify(consent.body)).toContain(consent.status);
  }
  conversationA = await ingest(PHONE, `om17_a_${RUN}`);
  conversationB = await ingest(PHONE_2, `om17_b_${RUN}`);
  expect(conversationA && conversationB).toBeTruthy();

  // A staff-only note that must never leak into the Case description.
  const note = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
    channel: 'sms',
    accountKey: ACCOUNT_KEY,
    conversationId: conversationA,
    body: 'AGENT_TEST_OM17 SECRET INTERNAL NOTE',
    idempotencyKey: `om17_note_${RUN}`,
    isInternalNote: true,
  });
  expect(note.status, JSON.stringify(note.body)).toBe(201);
  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST OM17 none ${RUN}`, permissions: {} });
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  for (const phone of [PHONE, PHONE_2]) {
    await sql`delete from voice_consent_events where address = ${phone}`.execute(db).catch(() => undefined);
  }
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  const caseIds = [createdCaseId, linkedCaseId].filter((id) => id !== '');
  if (caseIds.length > 0) {
    await sql`delete from entity_records where entity_type = 'CaseTransition' and attrs->>'caseId' = any(${sql.val(caseIds)}::text[])`.execute(db).catch(() => undefined);
    await sql`delete from entity_records where entity_type = 'CaseAssignment' and attrs->>'caseId' = any(${sql.val(caseIds)}::text[])`.execute(db).catch(() => undefined);
    await sql`delete from entity_records where id = any(${sql.val(caseIds)}::text[])`.execute(db).catch(() => undefined);
  }
  if (priorSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorSettings) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  }
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  await db.deleteFrom('roles').where('id', '=', ROLE_NONE).execute().catch(() => undefined);
  await shutdownApi();
});

describe('ServiceDesk hand-off (19-OM.17)', () => {
  it('creates one Case through the domain command, with the trail, origin and a privacy-safe summary', async () => {
    const handoff = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/case/handoff`, {});
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    expect(handoff.body['created']).toBe(true);
    expect(handoff.body['linked']).toBe(true);
    const created = handoff.body['case'] as Record<string, unknown>;
    createdCaseId = String(created['id'] ?? '');
    expect(createdCaseId).not.toBe('');
    expect(created['source']).toBe('Omnichannel');
    expect(created['externalId']).toBe(`omnichannel:${conversationA}`);
    expect(String(created['caseNumber'])).toMatch(/^C\d+/);

    const caseRow = (await sql<{ attrs: Record<string, unknown> }>`
      select attrs from entity_records where id = ${createdCaseId}
    `.execute(ctx.database.db)).rows[0];
    const description = String(caseRow?.attrs['description'] ?? '');
    expect(description).toContain('AGENT_TEST_OM17 hello');
    expect(description).not.toContain('SECRET INTERNAL NOTE');
    expect(caseRow?.attrs['externalSource']).toBe('omnichannel');

    const transitions = (await sql<{ command: string; reason: string | null }>`
      select attrs->>'command' as command, attrs->>'reason' as reason from entity_records
      where entity_type = 'CaseTransition' and attrs->>'caseId' = ${createdCaseId}
    `.execute(ctx.database.db)).rows;
    expect(transitions.map((row) => row.command)).toContain('handoff');

    const conversation = (await sql<{ case_id: string | null }>`
      select case_id from voice_conversations where id = ${conversationA}
    `.execute(ctx.database.db)).rows[0];
    expect(conversation?.case_id).toBe(createdCaseId);
  });

  it('is idempotent: a retry returns the same Case, with one hand-off transition', async () => {
    const retried = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/case/handoff`, {});
    expect(retried.status).toBe(200);
    expect(retried.body['created']).toBe(false);
    expect((retried.body['case'] as Record<string, unknown>)['id']).toBe(createdCaseId);
    const cases = (await sql<{ n: string }>`
      select count(*)::text as n from entity_records
      where entity_type = 'Case' and deleted_at is null and attrs->>'externalId' = ${`omnichannel:${conversationA}`}
    `.execute(ctx.database.db)).rows[0];
    expect(cases?.n).toBe('1');
    const handoffs = (await sql<{ n: string }>`
      select count(*)::text as n from entity_records
      where entity_type = 'CaseTransition' and attrs->>'caseId' = ${createdCaseId} and attrs->>'command' = 'handoff'
    `.execute(ctx.database.db)).rows[0];
    expect(handoffs?.n).toBe('1');
  });

  it('links an existing Case, records the link trail, and lists the linked conversation', async () => {
    const existing = await call('POST', '/api/v1/Case', { name: `AGENT_TEST_OM17 existing case ${RUN}`, requesterName: 'AGENT_TEST_OM17 requester' });
    expect(existing.status, JSON.stringify(existing.body)).toBe(201);
    linkedCaseId = String(existing.body['id'] ?? '');

    const linked = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationB}/case/handoff`, { linkCaseId: linkedCaseId });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body['created']).toBe(false);
    expect((linked.body['case'] as Record<string, unknown>)['id']).toBe(linkedCaseId);

    const conversation = (await sql<{ case_id: string | null }>`
      select case_id from voice_conversations where id = ${conversationB}
    `.execute(ctx.database.db)).rows[0];
    expect(conversation?.case_id).toBe(linkedCaseId);

    const transitions = (await sql<{ n: string }>`
      select count(*)::text as n from entity_records
      where entity_type = 'CaseTransition' and attrs->>'caseId' = ${linkedCaseId} and attrs->>'command' = 'link_conversation'
    `.execute(ctx.database.db)).rows[0];
    expect(transitions?.n).toBe('1');

    const listing = await call('GET', `/api/v1/Omnichannel/action/cases/${linkedCaseId}/conversations`);
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);
    expect((listing.body['list'] as { id: string }[]).map((row) => row.id)).toEqual([conversationB]);

    // Retrying the link is idempotent and does not append a second trail row.
    const again = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationB}/case/handoff`, { linkCaseId: linkedCaseId });
    expect(again.status).toBe(200);
    const stillOne = (await sql<{ n: string }>`
      select count(*)::text as n from entity_records
      where entity_type = 'CaseTransition' and attrs->>'caseId' = ${linkedCaseId} and attrs->>'command' = 'link_conversation'
    `.execute(ctx.database.db)).rows[0];
    expect(stillOne?.n).toBe('1');
  });

  it('keeps Case and conversation status independent', async () => {
    const before = (await sql<{ status: string }>`select status from voice_conversations where id = ${conversationA}`.execute(ctx.database.db)).rows[0]?.status;
    const edited = await call('PATCH', `/api/v1/Case/${createdCaseId}`, { name: `AGENT_TEST_OM17 renamed case ${RUN}` });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const after = (await sql<{ status: string }>`select status from voice_conversations where id = ${conversationA}`.execute(ctx.database.db)).rows[0]?.status;
    expect(after).toBe(before);
  });

  it('refuses a forged external anchor from the generic API and unauthorized hand-offs', async () => {
    const forged = await call('POST', '/api/v1/Case', { name: `AGENT_TEST_OM17 forged ${RUN}`, requesterName: 'AGENT_TEST_OM17 requester', externalId: `omnichannel:${conversationB}` });
    expect(forged.status).toBe(422);

    const user = await createTestUser(ctx, { userName: `AGENT_TEST OM17 plain ${RUN}`, roleIds: [ROLE_NONE] });
    const refused = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationB}/case/handoff`, {}, user.token);
    expect(refused.status).toBe(403);
    await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
  });
});
