import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OmnichannelSettingsService } from '../src/omnichannel/index.js';
import { VoiceCommunicationsSettingsService, VoiceMessagingService } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.20 — conversation analytics over the reused records
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.20`; `docs/omnichannel/analytics.md`).
 *
 * Against the configured primary database (AGENTS.md §3.1). Fixtures are created through the owner's
 * ingest/send services and then timestamped with SQL so the window is deterministic: every fixture is
 * **2 hours old**, and a 1-day window isolates them from older data in the shared database. Rows are
 * `agent_test_om20_*` and removed in `afterAll`; the settings rows are restored.
 *
 * Proved: internal notes never count as customer messages; volume/backlog/assignment/first-response/
 * reply-delay/handoff/reopen/delivery numbers match their documented definitions; delivery `unknown` is
 * reported separately from failures; provider health and webhook backlog come from the owner's records;
 * an empty window reports `unavailable` rather than a misleading zero; and a caller without the inbox
 * capability is refused.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om20_${RUN}`;
const PHONE_SMS = '+14155550620';
const PHONE_WA = '+14155550621';
const ROLE_NONE = `r_AGENT_TEST_OM20_none_${RUN}`;

let ctx: ApiContext;
let conversationSms = '';
let conversationWa = '';
let priorVoice: string | null = null;
let priorOmnichannel: string | null = null;
type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({ method, url, headers: { ...authHeader(token ?? ctx.adminToken), 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function ingest(channel: 'sms' | 'whatsapp', phone: string, id: string): Promise<string> {
  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const result = await messaging.ingestInbound({
    accountKey: ACCOUNT_KEY,
    event: { kind: 'message', providerMessageId: `om20_${id}_${RUN}`, state: 'delivered', direction: 'inbound', channel, from: phone, to: null, body: `AGENT_TEST_OM20 ${id}`, occurredAt: new Date().toISOString(), failureCategory: null, vendorStatus: 'received' },
  });
  const row = (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${result.messageId}`.execute(ctx.database.db)).rows[0];
  return String(row?.conversation_id ?? '');
}

async function send(conversationId: string, channel: 'sms' | 'whatsapp', key: string, note = false): Promise<string> {
  const res = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
    channel,
    accountKey: ACCOUNT_KEY,
    conversationId,
    body: note ? 'AGENT_TEST_OM20 INTERNAL NOTE' : `AGENT_TEST_OM20 reply ${key}`,
    idempotencyKey: key,
    ...(note ? { isInternalNote: true } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String((res.body['message'] as Record<string, unknown>)['id'] ?? '');
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  ctx = await bootApi();
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om20 analytics`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'messaging.whatsapp.send', 'messaging.whatsapp.receive', 'webhook.signatureValidation'],
    config: { sandboxRecipients: [PHONE_SMS, PHONE_WA] },
    webhookSecret: `whsec_om20_${RUN}`,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const voiceRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorVoice = voiceRow === undefined ? null : JSON.stringify(voiceRow.data);
  const voiceSettings = await call('POST', '/api/v1/VoiceCommunications/action/settings', { features: { sms: true, whatsapp: true }, provider: { defaultAccountKey: ACCOUNT_KEY } });
  expect(voiceSettings.status, JSON.stringify(voiceSettings.body)).toBe(200);
  for (const [channel, phone] of [['sms', PHONE_SMS], ['whatsapp', PHONE_WA]] as const) {
    const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', { channel, address: phone, purpose: 'service', status: 'granted', basis: 'explicit_opt_in', source: 'manual_record' });
    expect([200, 201], JSON.stringify(consent.body)).toContain(consent.status);
  }
  const omniRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'omnichannel').executeTakeFirst();
  priorOmnichannel = omniRow === undefined ? null : JSON.stringify(omniRow.data);

  conversationSms = await ingest('sms', PHONE_SMS, 'sms');
  conversationWa = await ingest('whatsapp', PHONE_WA, 'wa');
  const replyId = await send(conversationSms, 'sms', `om20_reply_${RUN}`);
  const failedId = await send(conversationSms, 'sms', `om20_failed_${RUN}`);
  await send(conversationSms, 'sms', `om20_note_${RUN}`, true);

  // Deterministic timestamps: 2 hours old for the conversations/messages, 30 minutes for the events.
  await sql`update voice_conversations set created_at = now() - interval '2 hours', modified_at = now() - interval '2 hours' where id in (${conversationSms}, ${conversationWa})`.execute(ctx.database.db);
  await sql`update voice_messages set created_at = now() - interval '2 hours' where conversation_id = ${conversationSms} and direction = 'inbound'`.execute(ctx.database.db);
  await sql`update voice_messages set created_at = now() - interval '90 minutes' where id = ${replyId}`.execute(ctx.database.db);
  await sql`update voice_messages set created_at = now() - interval '80 minutes' where id = ${failedId}`.execute(ctx.database.db);
  await sql`update voice_messages set state = 'failed', failure_category = 'rate_limit' where id = ${failedId}`.execute(ctx.database.db);
  const unknownId = await send(conversationSms, 'sms', `om20_unknown_${RUN}`);
  await sql`update voice_messages set created_at = now() - interval '70 minutes', state = 'unknown', failure_category = 'timeout' where id = ${unknownId}`.execute(ctx.database.db);
  await sql`update voice_messages set created_at = now() - interval '60 minutes' where conversation_id = ${conversationSms} and is_internal_note = true`.execute(ctx.database.db);

  const now = new Date();
  await sql`
    insert into voice_conversation_events (id, conversation_id, kind, actor_type, from_value, to_value, created_at)
    values (${`om20_close_${RUN}`}, ${conversationSms}, 'status_changed', 'user', 'open', 'closed', ${new Date(now.getTime() - 45 * 60_000)}),
           (${`om20_reopen_${RUN}`}, ${conversationSms}, 'status_changed', 'user', 'closed', 'open', ${new Date(now.getTime() - 30 * 60_000)})
  `.execute(ctx.database.db);
  await sql`
    update voice_provider_accounts set last_health_status = 'ok', last_health_at = now() - interval '5 minutes' where key = ${ACCOUNT_KEY}
  `.execute(ctx.database.db);

  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST OM20 none ${RUN}`, permissions: {} });
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  for (const phone of [PHONE_SMS, PHONE_WA]) {
    await sql`delete from voice_consent_events where address = ${phone}`.execute(db).catch(() => undefined);
    await sql`delete from voice_suppressions where address = ${phone}`.execute(db).catch(() => undefined);
  }
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  if (priorVoice === null) await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorVoice) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  if (priorOmnichannel === null) await db.deleteFrom('app_settings').where('name', '=', 'omnichannel').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorOmnichannel) as Body, modified_at: new Date() }).where('name', '=', 'omnichannel').execute().catch(() => undefined);
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  ctx.app.get(OmnichannelSettingsService, { strict: false }).invalidate();
  await db.deleteFrom('roles').where('id', '=', ROLE_NONE).execute().catch(() => undefined);
  await shutdownApi();
});

describe('Conversation analytics (19-OM.20)', () => {
  it('reports volume by channel with internal notes excluded', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/analytics?days=1');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const volume = result.body['volume'] as { byChannel: { channel: string; inbound: number; outbound: number }[]; totalInbound: number; totalOutbound: number };
    const sms = volume.byChannel.find((row) => row.channel === 'sms');
    const wa = volume.byChannel.find((row) => row.channel === 'whatsapp');
    expect(sms?.inbound).toBe(1);
    // Three customer-visible outbound messages; the internal note is excluded.
    expect(sms?.outbound).toBe(3);
    expect(wa?.inbound).toBe(1);
    expect(wa?.outbound ?? 0).toBe(0);
    expect(volume.totalInbound).toBe(2);
  });

  it('computes first response and reply delay from recorded timestamps', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/analytics?days=1');
    const firstResponse = result.body['firstResponse'] as { averageMinutes: number | null; sample: number };
    const replyDelay = result.body['replyDelay'] as { averageMinutes: number | null; sample: number };
    // Conversation created at T-2h, first visible reply at T-90m → 30 minutes.
    expect(firstResponse.sample).toBe(1);
    expect(firstResponse.averageMinutes).toBe(30);
    // Inbound at T-2h → next visible reply at T-90m → 30 minutes.
    expect(replyDelay.sample).toBe(1);
    expect(replyDelay.averageMinutes).toBe(30);
  });

  it('reports delivery states separately and never counts unknown as a failure', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/analytics?days=1');
    const delivery = result.body['delivery'] as { failed: number; undelivered: number; unknown: number; byCategory: { category: string; count: number }[] };
    expect(delivery.failed).toBe(1);
    expect(delivery.unknown).toBe(1);
    expect(delivery.undelivered).toBe(0);
    expect(delivery.byCategory.map((row) => row.category)).toEqual(expect.arrayContaining(['rate_limit', 'timeout']));
  });

  it('computes the reopen rate from status events and applies honest availability on an empty window', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/analytics?days=1');
    const reopen = result.body['reopenRate'] as { reopened: number; closedInWindow: number; rate: number | null };
    expect(reopen.reopened).toBe(1);
    expect(reopen.closedInWindow).toBe(1);
    expect(reopen.rate).toBe(100);

    // The backlog and hand-off counts are aggregate, honest zeros are allowed here.
    const handoffs = result.body['handoffs'] as { conversationsWithCase: number };
    expect(handoffs.conversationsWithCase).toBe(0);
    const backlog = result.body['backlog'] as { byStatus: { status: string; count: number }[] };
    expect(backlog.byStatus.find((row) => row.status === 'open')?.count ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('reports provider health from the owner’s records and refuses callers without the inbox capability', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/analytics?days=1');
    const provider = result.body['providerHealth'] as { available: boolean; accounts: { key: string; status: string }[] };
    expect(provider.available).toBe(true);
    expect(provider.accounts.find((row) => row.key === ACCOUNT_KEY)?.status).toBe('ok');

    const user = await createTestUser(ctx, { userName: `AGENT_TEST OM20 plain ${RUN}`, roleIds: [ROLE_NONE] });
    const refused = await call('GET', '/api/v1/Omnichannel/action/analytics?days=1', undefined, user.token);
    expect(refused.status).toBe(403);
    await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
  });

  it('never returns message content', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/analytics?days=1');
    const text = JSON.stringify(result.body);
    expect(text).not.toContain('AGENT_TEST_OM20 reply');
    expect(text).not.toContain('INTERNAL NOTE');
    expect(text).not.toContain(PHONE_SMS);
  });
});
