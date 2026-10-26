import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OmnichannelSettingsService } from '../src/omnichannel/index.js';
import {
  VoiceCommunicationsSettingsService,
  VoiceConsentService,
  VoiceMessagingService,
} from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.18 — consent enforcement, retention and data rights
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.18`; `docs/omnichannel/consent-and-retention.md`).
 *
 * Against the configured primary database (AGENTS.md §3.1). Conversations are created through the
 * owner's ingest service; consent/suppression through the owner's service. Rows are `agent_test_om18_*`
 * / explicit ids and are removed in `afterAll`; the shared Voice and Omnichannel settings rows are
 * restored byte-for-byte.
 *
 * Proved: no Omnichannel route bypasses the owner (missing evidence blocks; an address change does not
 * carry consent; a suppression refuses regardless); the voice and marketing vocabularies stay
 * separate (no cross-read is possible structurally); there is no Omnichannel consent table; the export
 * is administrator-only, excludes internal notes and is audited; stale drafts and expired sessions are
 * purged by the module's own retention settings.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om18_${RUN}`;
const PHONE_A = '+14155550418';
const PHONE_B = '+14155550419';
const ROLE_NONE = `r_AGENT_TEST_OM18_none_${RUN}`;

let ctx: ApiContext;
let conversationA = '';
let conversationB = '';
let priorVoice: string | null = null;
let priorOmnichannel: string | null = null;
type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string): Promise<{ status: number; body: Body }> {
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

function refusals(body: Body): string[] {
  const details = (body['error'] as Record<string, unknown> | undefined)?.['details'] as { refusals?: string[] } | undefined;
  return details?.refusals ?? [];
}

async function ingest(phone: string, id: string): Promise<string> {
  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const result = await messaging.ingestInbound({
    accountKey: ACCOUNT_KEY,
    event: { kind: 'message', providerMessageId: `om18_${id}_${RUN}`, state: 'delivered', direction: 'inbound', channel: 'sms', from: phone, to: null, body: `AGENT_TEST_OM18 ${id}`, occurredAt: new Date().toISOString(), failureCategory: null, vendorStatus: 'received' },
  });
  const row = (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${result.messageId}`.execute(ctx.database.db)).rows[0];
  return String(row?.conversation_id ?? '');
}

async function grant(phone: string, status: 'granted' | 'revoked'): Promise<void> {
  const res = await call('POST', '/api/v1/VoiceCommunications/action/consent', { channel: 'sms', address: phone, purpose: 'service', status, basis: 'explicit_opt_in', source: 'manual_record' });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  ctx = await bootApi();
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om18 consent`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'webhook.signatureValidation'],
    config: { sandboxRecipients: [PHONE_A, PHONE_B] },
    webhookSecret: `whsec_om18_${RUN}`,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const voiceRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorVoice = voiceRow === undefined ? null : JSON.stringify(voiceRow.data);
  const voiceSettings = await call('POST', '/api/v1/VoiceCommunications/action/settings', { features: { sms: true }, provider: { defaultAccountKey: ACCOUNT_KEY } });
  expect(voiceSettings.status, JSON.stringify(voiceSettings.body)).toBe(200);
  const omniRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'omnichannel').executeTakeFirst();
  priorOmnichannel = omniRow === undefined ? null : JSON.stringify(omniRow.data);
  const retention = await call('POST', '/api/v1/Omnichannel/action/settings', { retention: { staleDraftDays: 1, expiredSessionDays: 1 } });
  expect(retention.status, JSON.stringify(retention.body)).toBe(200);

  conversationA = await ingest(PHONE_A, 'a');
  conversationB = await ingest(PHONE_B, 'b');
  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST OM18 none ${RUN}`, permissions: {} });
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  for (const phone of [PHONE_A, PHONE_B]) {
    await sql`delete from voice_consent_events where address = ${phone}`.execute(db).catch(() => undefined);
    await sql`delete from voice_suppressions where address = ${phone}`.execute(db).catch(() => undefined);
  }
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from omnichannel_drafts where conversation_id in (${conversationA}, ${conversationB})`.execute(db).catch(() => undefined);
  await sql`delete from audit_log where record_id in (${conversationA}, ${conversationB}) and entity_type = 'CommunicationConversation'`.execute(db).catch(() => undefined);
  if (priorVoice === null) await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorVoice) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  if (priorOmnichannel === null) await db.deleteFrom('app_settings').where('name', '=', 'omnichannel').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorOmnichannel) as Body, modified_at: new Date() }).where('name', '=', 'omnichannel').execute().catch(() => undefined);
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  ctx.app.get(OmnichannelSettingsService, { strict: false }).invalidate();
  await db.deleteFrom('roles').where('id', '=', ROLE_NONE).execute().catch(() => undefined);
  await shutdownApi();
});

describe('Consent enforcement and data rights (19-OM.18)', () => {
  it('treats missing evidence as refusal and never carries consent across an address change', async () => {
    // No consent for either number yet: both refused (missing evidence is never consent).
    const missing = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/messages`, { body: 'AGENT_TEST_OM18 no consent', idempotencyKey: `om18_none_${RUN}` });
    expect(missing.status).toBe(422);
    expect(refusals(missing.body)).toContain('consent_required');

    await grant(PHONE_A, 'granted');
    const allowed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/messages`, { body: 'AGENT_TEST_OM18 consented', idempotencyKey: `om18_ok_${RUN}` });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    // The second, different address still has no evidence: consent does not carry over.
    const other = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationB}/messages`, { body: 'AGENT_TEST_OM18 other address', idempotencyKey: `om18_other_${RUN}` });
    expect(other.status).toBe(422);
    expect(refusals(other.body)).toContain('consent_required');

    await grant(PHONE_A, 'revoked');
    const revoked = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/messages`, { body: 'AGENT_TEST_OM18 revoked', idempotencyKey: `om18_revoked_${RUN}` });
    expect(revoked.status).toBe(422);
    expect(refusals(revoked.body)).toContain('consent_required');
  });

  it('lets an opt-out refuse regardless of consent events', async () => {
    await grant(PHONE_A, 'granted');
    const consent = ctx.app.get(VoiceConsentService, { strict: false });
    await consent.suppress({ channel: 'sms', address: PHONE_A, reason: 'stop_keyword', source: 'manual_record' });
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/messages`, { body: 'AGENT_TEST_OM18 suppressed', idempotencyKey: `om18_suppressed_${RUN}` });
    expect(sent.status).toBe(422);
    expect(refusals(sent.body)).toContain('suppressed');
    await sql`delete from voice_suppressions where address = ${PHONE_A}`.execute(ctx.database.db);
  });

  it('keeps the voice and marketing vocabularies structurally separate, with no Omnichannel consent store', async () => {
    const checks = (await sql<{ name: string; def: string }>`
      select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'voice_suppressions'::regclass and contype = 'c'
    `.execute(ctx.database.db)).rows;
    const joined = checks.map((row) => row.def).join(' ');
    expect(joined).toContain("'sms'");
    expect(joined).not.toContain("'Email'");

    const tables = (await sql<{ n: string }>`
      select count(*)::text as n from information_schema.tables
      where table_schema = 'public'
        and (table_name like 'omnichannel\\_%consent%' or table_name like 'omnichannel\\_%suppression%')
    `.execute(ctx.database.db)).rows[0];
    expect(tables?.n).toBe('0');
  });

  it('exports a conversation for data rights without internal notes, audited, administrator-only', async () => {
    const note = await call('POST', `/api/v1/VoiceCommunications/action/messages/send`, {
      channel: 'sms',
      accountKey: ACCOUNT_KEY,
      conversationId: conversationA,
      body: 'AGENT_TEST_OM18 INTERNAL ONLY',
      idempotencyKey: `om18_note_${RUN}`,
      isInternalNote: true,
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);

    const exported = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationA}/export`);
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    expect(JSON.stringify(exported.body)).not.toContain('INTERNAL ONLY');
    expect((exported.body['excluded'] as Record<string, unknown>)['internalNotes']).toBe(1);
    expect((exported.body['messages'] as unknown[]).length).toBeGreaterThan(0);

    const audit = (await sql<{ n: string }>`
      select count(*)::text as n from audit_log where record_id = ${conversationA} and action = 'CommunicationConversationExport'
    `.execute(ctx.database.db)).rows[0];
    expect(audit?.n).toBe('1');

    const user = await createTestUser(ctx, { userName: `AGENT_TEST OM18 plain ${RUN}`, roleIds: [ROLE_NONE] });
    const refused = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationA}/export`, undefined, user.token);
    expect(refused.status).toBe(403);
    await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
  });

  it('purges module-owned artefacts by their configured retention windows', async () => {
    const saved = await call('PUT', `/api/v1/Omnichannel/action/conversations/${conversationB}/draft`, { body: 'AGENT_TEST_OM18 stale draft' });
    expect(saved.status).toBe(200);
    await sql`update omnichannel_drafts set modified_at = now() - interval '3 days' where conversation_id = ${conversationB}`.execute(ctx.database.db);
    // A fresh draft must survive the purge.
    await call('PUT', `/api/v1/Omnichannel/action/conversations/${conversationA}/draft`, { body: 'AGENT_TEST_OM18 fresh draft' });

    const sessionId = `AGENT_TEST_OM18_session_${RUN}`;
    const keyHash = `AGENT_TEST_OM18_hash_${RUN}`;
    await sql`
      insert into omnichannel_visitor_sessions (id, visitor_key_hash, status, consent_state, expires_at, first_seen_at, last_seen_at)
      values (${sessionId}, ${keyHash}, 'expired', 'pending', now() - interval '3 days', now() - interval '10 days', now() - interval '10 days')
    `.execute(ctx.database.db);

    const purged = await call('POST', '/api/v1/Omnichannel/action/retention/purge', {});
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    expect(Number(purged.body['drafts'])).toBeGreaterThanOrEqual(1);
    expect(Number(purged.body['sessions'])).toBeGreaterThanOrEqual(1);

    const stale = (await sql<{ n: string }>`select count(*)::text as n from omnichannel_drafts where conversation_id = ${conversationB}`.execute(ctx.database.db)).rows[0];
    const fresh = (await sql<{ n: string }>`select count(*)::text as n from omnichannel_drafts where conversation_id = ${conversationA}`.execute(ctx.database.db)).rows[0];
    const session = (await sql<{ n: string }>`select count(*)::text as n from omnichannel_visitor_sessions where id = ${sessionId}`.execute(ctx.database.db)).rows[0];
    expect(stale?.n).toBe('0');
    expect(fresh?.n).toBe('1');
    expect(session?.n).toBe('0');
  });
});
