import { readFileSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  signFakeWebhook,
  VoiceCommunicationsSettingsService,
  VoiceMessagingService,
} from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.13 — VoiceCommunications integration: call context, honest catalog, reconciliation
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.13`).
 *
 * Against the configured primary database (AGENTS.md §3.1); simulator only. Call sessions are inserted
 * as `AGENT_TEST_OM13_*` rows (they would normally come from the voice webhook pipeline), the
 * conversation from the owner's ingest service, and the reconciliation path uses a signed webhook
 * receipt exactly as a provider would. Everything is removed by exact id/key in `afterAll`; the shared
 * `voiceCommunications` settings row is restored byte-for-byte.
 *
 * Proved: a call is shown as context and never becomes a message; the explicit action opens the
 * customer's existing conversation by digit-equal address (or honestly says none exists); the channel
 * catalog reports the voice connector independently of messaging and excludes disabled accounts; a
 * replayed provider event cannot duplicate the authoritative message.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om13_${RUN}`;
const DISABLED_ACCOUNT_KEY = `agent_test_om13_off_${RUN}`;
const WEBHOOK_SECRET = `whsec_om13_${RUN}`;
const PHONE = '+14155550213';
const UNKNOWN_PHONE = '+14155550299';
const CALL_A = `AGENT_TEST_OM13_call_${RUN}`;
const CALL_B = `AGENT_TEST_OM13_call_unknown_${RUN}`;
const ROLE_NONE = `r_AGENT_TEST_OM13_none_${RUN}`;
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;

let ctx: ApiContext;
let conversationId = '';
let priorSettings: string | null = null;
type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(headers ?? authHeader(ctx.adminToken)), 'content-type': 'application/json' },
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

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om13 calls`,
    environment: 'test',
    enabled: true,
    capabilities: ['voice.inboundEvents', 'voice.outboundCall', 'voice.callStatusCallbacks', 'messaging.sms.send', 'messaging.sms.receive', 'webhook.signatureValidation'],
    config: {},
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const disabled = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: DISABLED_ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om13 disabled voice`,
    environment: 'test',
    enabled: false,
    capabilities: ['voice.inboundEvents'],
    config: {},
  });
  expect(disabled.status, JSON.stringify(disabled.body)).toBe(201);

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorSettings = row === undefined ? null : JSON.stringify(row.data);
  const settings = await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { voice: true, sms: true },
    provider: { defaultAccountKey: ACCOUNT_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const ingested = await messaging.ingestInbound({
    accountKey: ACCOUNT_KEY,
    event: { kind: 'message', providerMessageId: `om13_${RUN}`, state: 'delivered', direction: 'inbound', channel: 'sms', from: PHONE, to: null, body: 'AGENT_TEST_OM13 hello', occurredAt: new Date().toISOString(), failureCategory: null, vendorStatus: 'received' },
  });
  conversationId = String(
    (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${ingested.messageId}`.execute(ctx.database.db)).rows[0]?.conversation_id ?? '',
  );
  expect(conversationId).not.toBe('');

  const now = new Date();
  for (const [id, from, sid] of [[CALL_A, PHONE, `CA_om13_${RUN}_1`], [CALL_B, UNKNOWN_PHONE, `CA_om13_${RUN}_2`]] as const) {
    await sql`
      insert into voice_call_sessions
        (id, account_key, direction, state, provider_call_id, from_number, started_at, answered_at, ended_at,
         duration_seconds, result, created_at, modified_at)
      values (${id}, ${ACCOUNT_KEY}, 'inbound', 'completed', ${sid}, ${from}, ${now}, ${now}, ${now}, 42, 'answered', ${now}, ${now})
    `.execute(ctx.database.db);
  }

  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST OM13 none ${RUN}`, permissions: {} });
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`delete from voice_call_sessions where id in (${CALL_A}, ${CALL_B})`.execute(db).catch(() => undefined);
  await sql`delete from voice_call_sessions where account_key in (${ACCOUNT_KEY}, ${DISABLED_ACCOUNT_KEY})`.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`
    delete from jobs where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key in (${ACCOUNT_KEY}, ${DISABLED_ACCOUNT_KEY})`.execute(db).catch(() => undefined);
  if (priorSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorSettings) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  }
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  await db.deleteFrom('roles').where('id', '=', ROLE_NONE).execute().catch(() => undefined);
  await shutdownApi();
});

describe('VoiceCommunications integration (19-OM.13)', () => {
  it('shows calls as context, with the customer’s existing conversation resolved and no message created', async () => {
    const before = (await sql<{ n: string }>`select count(*)::text as n from voice_messages where conversation_id = ${conversationId}`.execute(ctx.database.db)).rows[0];
    const result = await call('GET', '/api/v1/Omnichannel/action/calls?limit=20');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const calls = result.body['list'] as Record<string, unknown>[];
    const callA = calls.find((row) => row['id'] === CALL_A);
    const callB = calls.find((row) => row['id'] === CALL_B);
    expect(callA?.['conversationId']).toBe(conversationId);
    expect(callB?.['conversationId']).toBeNull();
    const after = (await sql<{ n: string }>`select count(*)::text as n from voice_messages where conversation_id = ${conversationId}`.execute(ctx.database.db)).rows[0];
    expect(after?.n).toBe(before?.n);
  });

  it('opens the conversation through the explicit action and refuses an invisible call', async () => {
    const opened = await call('POST', `/api/v1/Omnichannel/action/calls/${CALL_A}/conversation`, {});
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body['conversationId']).toBe(conversationId);
    const none = await call('POST', `/api/v1/Omnichannel/action/calls/${CALL_B}/conversation`, {});
    expect(none.status).toBe(200);
    expect(none.body['conversationId']).toBeNull();
    const missing = await call('POST', '/api/v1/Omnichannel/action/calls/does-not-exist/conversation', {});
    expect(missing.status).toBe(404);
  });

  it('resolves a call by its own id, not by scanning a page of the call list', () => {
    // The owner's accessor answers for any call the caller may see. A list scan would answer 404 for
    // every call outside the newest page — the bug this scan keeps out.
    const source = readFileSync(new URL('../src/omnichannel/omnichannel-call.service.ts', import.meta.url), 'utf8');
    const open = source.slice(source.indexOf('async openConversation'));
    expect(open).not.toMatch(/calls\.list\(/);
    expect(open).toMatch(/calls\.get\(/);
  });

  it('reports the voice connector honestly and independently of the messaging rows', async () => {
    const catalog = await call('GET', '/api/v1/Omnichannel/action/channels');
    expect(catalog.status).toBe(200);
    const channels = catalog.body['channels'] as Record<string, unknown>[];
    const voice = channels.find((row) => row['channel'] === 'voice');
    expect(voice?.['transport']).toBe('voice');
    expect(voice?.['configured']).toBe(true);
    expect(voice?.['inbound']).toBe(true);
    // The disabled account is not listed as a usable voice connection.
    const accounts = (voice?.['accounts'] as { key: string }[]) ?? [];
    expect(accounts.map((entry) => entry.key)).toContain(ACCOUNT_KEY);
    expect(accounts.map((entry) => entry.key)).not.toContain(DISABLED_ACCOUNT_KEY);
    const sms = channels.find((row) => row['channel'] === 'sms');
    expect(sms?.['outbound']).toBe(true);
    expect(sms?.['configured']).toBe(true);
  });

  it('cannot duplicate the authoritative message when a provider event is processed twice', async () => {
    const body = { eventId: `evt_om13_${RUN}`, type: 'message.inbound', messageId: `SM_om13_${RUN}`, channel: 'sms', from: PHONE, to: '+14155550199', body: 'AGENT_TEST_OM13 second message', occurredAt: new Date().toISOString() };
    const timestamp = new Date().toISOString();
    const signed = { 'content-type': 'application/json', 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signFakeWebhook(WEBHOOK_SECRET, timestamp, body) };
    const accepted = await call('POST', `${OMNI}/message-events`, body, signed);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    const receiptId = String(accepted.body['eventId'] ?? '');
    const worker = { ...authHeader(ctx.adminToken), 'x-worker-secret': process.env.REPORT_WORKER_SECRET ?? '' };
    const first = await call('POST', '/api/v1/VoiceCommunications/action/webhook-events/process', { eventId: receiptId }, worker);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await call('POST', '/api/v1/VoiceCommunications/action/webhook-events/process', { eventId: receiptId }, worker);
    expect(second.status).toBe(200);
    expect(second.body['status']).toBe('duplicate');
    const messages = (await sql<{ n: string }>`
      select count(*)::text as n from voice_messages where account_key = ${ACCOUNT_KEY} and provider_message_id = ${`SM_om13_${RUN}`}
    `.execute(ctx.database.db)).rows[0];
    expect(messages?.n).toBe('1');
    const events = (await sql<{ n: string }>`
      select count(*)::text as n from voice_communication_events where webhook_event_id = ${receiptId}
    `.execute(ctx.database.db)).rows[0];
    expect(events?.n).toBe('1');
  });

  it('refuses call context to a caller without the inbox capability', async () => {
    const user = await createTestUser(ctx, { userName: `AGENT_TEST OM13 plain ${RUN}`, roleIds: [ROLE_NONE] });
    const result = await call('GET', '/api/v1/Omnichannel/action/calls', undefined, authHeader(user.token));
    expect(result.status).toBe(403);
    await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
  });
});
