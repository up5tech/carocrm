import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signFakeWebhook, VoiceCommunicationsSettingsService } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.7 — identity resolution, ambiguity and staff linking
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.7`; feature contract §6; migration 078).
 *
 * Against the configured primary database (AGENTS.md §3.1); in-process simulator only. The account,
 * consent, settings and CRM records this suite creates are `AGENT_TEST_OM7_*` / `agent_test_om7_*`
 * and are removed by exact id/key; the Voice settings row is restored byte-for-byte.
 *
 * What is proved is the phase's acceptance: a unique readable phone match links predictably
 * (exact/verified, explainable via link_reason + provenance); a second readable record with the same
 * number is **not guessed** — the participant becomes disputed/heuristic with no entity, and appears
 * in the staff conflict list; a staff link is authorized (record read through ACL), stored as a
 * manual decision the resolver never overwrites, and carries its reason in `audit_log`; unlinking is
 * equally authorized and audited; a role without `identityLink` cannot mutate (but may review); and
 * the normalized-phone index the resolver needs exists.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om7_${RUN}`;
const WEBHOOK_SECRET = `whsec_agent_test_om7_${RUN}`;
const PHONE = '+14155550133';
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;
const ROLE_REVIEW = `r_AGENT_TEST_OM7_review_${RUN}`;

let ctx: ApiContext;
let contact1 = '';
let contact2 = '';
let conversationId = '';
let participantId = '';
let priorSettings: string | null = null;

type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string): Promise<{ status: number; body: Body }> {
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

async function postWithHeaders(url: string, payload: unknown, headers: Record<string, string>): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function publicPost(url: string, payload: Record<string, unknown>, headers: Record<string, string>): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({ method: 'POST', url, headers, payload });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function createContact(name: string, phoneNumber: string): Promise<string> {
  const [firstName, ...rest] = name.split(' ');
  const created = await call('POST', '/api/v1/Contact', { firstName, lastName: rest.join(' ') || 'AGENT_TEST', phoneNumber });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return String(created.body['id'] ?? '');
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();

  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om7 identity`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'messaging.deliveryStatus', 'webhook.signatureValidation', 'provider.healthCheck'],
    config: { sandboxRecipients: [PHONE] },
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorSettings = row === undefined ? null : JSON.stringify(row.data);
  const settings = await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { sms: true },
    provider: { defaultAccountKey: ACCOUNT_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
    channel: 'sms',
    address: PHONE,
    purpose: 'service',
    status: 'granted',
    basis: 'explicit_opt_in',
    source: 'manual_record',
  });
  expect(consent.status, JSON.stringify(consent.body)).toBe(201);

  contact1 = await createContact(`AGENT_TEST OM7 primary ${RUN}`, PHONE);
  const body = { eventId: `evt_${RUN}_1`, type: 'message.inbound', messageId: `SM_${RUN}_1`, channel: 'sms', from: PHONE, to: '+14155550199', body: 'AGENT_TEST_OM7 hello', occurredAt: new Date().toISOString() };
  const timestamp = new Date().toISOString();
  const accepted = await publicPost(`${OMNI}/message-events`, body, {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(WEBHOOK_SECRET, timestamp, body),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const processed = await postWithHeaders('/api/v1/VoiceCommunications/action/webhook-events/process', { eventId: accepted.body['eventId'] }, {
    ...authHeader(ctx.adminToken),
    'x-worker-secret': process.env.REPORT_WORKER_SECRET ?? '',
  });
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);

  const conversation = (await sql<{ id: string }>`
    select id from voice_conversations where account_key = ${ACCOUNT_KEY} limit 1
  `.execute(ctx.database.db)).rows[0];
  expect(conversation?.id).toBeTruthy();
  conversationId = String(conversation?.id);
  const participant = (await sql<{ id: string }>`
    select id from voice_conversation_participants where conversation_id = ${conversationId} and role = 'customer' limit 1
  `.execute(ctx.database.db)).rows[0];
  expect(participant?.id).toBeTruthy();
  participantId = String(participant?.id);

  await createTestRole(ctx, { id: ROLE_REVIEW, name: `AGENT_TEST OM7 review ${RUN}`, permissions: { OmnichannelConversation: { read: 'all' }, CommunicationConversation: { read: 'all' } } });
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`delete from audit_log where record_id = ${conversationId} and entity_type = 'CommunicationConversation'`.execute(db).catch(() => undefined);
  await sql`
    delete from jobs where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_consent_events where address = ${PHONE}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  const contacts = [contact1, contact2].filter((id) => id !== '');
  if (contacts.length > 0) await db.deleteFrom('entity_records').where('id', 'in', contacts).execute().catch(() => undefined);
  if (priorSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorSettings) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  }
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  await db.deleteFrom('roles').where('id', '=', ROLE_REVIEW).execute().catch(() => undefined);
  await shutdownApi();
});

describe('Omnichannel identity resolution (19-OM.7)', () => {
  it('links a unique readable phone match with explainable evidence', async () => {
    const review = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity`);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const participants = review.body['participants'] as Record<string, unknown>[];
    expect(participants).toHaveLength(1);
    const participant = participants[0] ?? {};
    expect(participant['resolution']).toBe('matched');
    expect(participant['entityId']).toBe(contact1);
    expect(participant['linkConfidence']).toBe('exact');
    expect(participant['verificationState']).toBe('verified');
    expect(participant['linkReason']).toBe('unique_address_match');
    expect(participant['sourceProvenance']).toBe('contact_resolver');
    expect((participant['candidates'] as unknown[]).length).toBe(1);
  });

  it('never guesses when two readable records share the number: disputed, unlinked, reviewable', async () => {
    // The same human stored twice (international and national formatting) — the resolver's match keys
    // intentionally treat both forms as the same number.
    contact2 = await createContact(`AGENT_TEST OM7 duplicate ${RUN}`, '415-555-0133');
    const review = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity`);
    expect(review.status).toBe(200);
    const participant = (review.body['participants'] as Record<string, unknown>[])[0] ?? {};
    expect(participant['resolution']).toBe('ambiguous');
    expect(participant['entityId']).toBeNull();
    expect(participant['linkConfidence']).toBe('heuristic');
    expect(participant['verificationState']).toBe('disputed');
    expect(String(participant['linkReason'])).toMatch(/^ambiguous_match:2$/);
    expect((participant['candidates'] as unknown[]).length).toBe(2);

    const conflicts = await call('GET', '/api/v1/Omnichannel/action/identities/conflicts');
    expect(conflicts.status, JSON.stringify(conflicts.body)).toBe(200);
    const listed = (conflicts.body['list'] as Record<string, unknown>[]).find((row) => row['participantId'] === participantId);
    expect(listed).toBeDefined();
    expect(listed?.['conversationId']).toBe(conversationId);
  });

  it('records a staff link as a manual decision with its reason in the audit log, and never re-overwrites it', async () => {
    const linked = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity/link`, {
      participantId,
      entityType: 'Contact',
      entityId: contact2,
      reason: 'AGENT_TEST_OM7 confirmed by phone call',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    const participant = (linked.body['participants'] as Record<string, unknown>[])[0] ?? {};
    expect(participant['entityId']).toBe(contact2);
    expect(participant['linkConfidence']).toBe('manual');
    expect(participant['verificationState']).toBe('verified');
    expect(participant['sourceProvenance']).toBe('staff_link');

    const audit = (await sql<{ action: string; data: { reason?: string } }>`
      select action, data from audit_log where record_id = ${conversationId} and action = 'CommunicationIdentityLink'
    `.execute(ctx.database.db)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data.reason).toBe('AGENT_TEST_OM7 confirmed by phone call');

    // Re-resolving (still ambiguous) must not overwrite the staff decision.
    const review = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity`);
    const after = (review.body['participants'] as Record<string, unknown>[])[0] ?? {};
    expect(after['entityId']).toBe(contact2);
    expect(after['linkConfidence']).toBe('manual');
  });

  it('authorizes and audits an unlink, and keeps a reason requirement', async () => {
    const refused = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity/unlink`, { participantId });
    expect(refused.status).toBe(422);
    const unlinked = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity/unlink`, {
      participantId,
      reason: 'AGENT_TEST_OM7 duplicate record, wrong identity',
    });
    expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
    const participant = (unlinked.body['participants'] as Record<string, unknown>[])[0] ?? {};
    expect(participant['entityId']).toBeNull();
    expect(participant['linkConfidence']).not.toBe('manual');
    const audit = (await sql<{ action: string }>`
      select action from audit_log where record_id = ${conversationId} and action = 'CommunicationIdentityUnlink'
    `.execute(ctx.database.db)).rows;
    expect(audit).toHaveLength(1);
  });

  it('separates review from mutation: a role without identityLink may read, never link', async () => {
    const user = await createTestUser(ctx, { userName: `AGENT_TEST_OM7 reviewer ${RUN}`, roleIds: [ROLE_REVIEW] });
    const review = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity`, undefined, user.token);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const link = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity/link`, {
      participantId,
      entityType: 'Contact',
      entityId: contact1,
      reason: 'AGENT_TEST_OM7 should be refused',
    }, user.token);
    expect(link.status).toBe(403);
    const conflicts = await call('GET', '/api/v1/Omnichannel/action/identities/conflicts', undefined, user.token);
    expect(conflicts.status).toBe(403);
    await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
  });

  it('requires the normalized phone index the resolver reads (migration 078)', async () => {
    const rows = (await sql<{ n: string }>`
      select count(*)::text as n from pg_indexes where indexname = 'idx_entity_records_phone_digits'
    `.execute(ctx.database.db)).rows;
    expect(rows[0]?.n).toBe('1');
  });
});
