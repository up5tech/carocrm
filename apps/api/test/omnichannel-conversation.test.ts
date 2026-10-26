import { readdirSync,readFileSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signFakeWebhook, VoiceCommunicationsSettingsService, VoiceProviderRegistry } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.6 — canonical conversation / thread / message services
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.6`; feature contract §4; decisions D1 + E6 + E7).
 *
 * Against the configured primary database (AGENTS.md §3.1); only the in-process simulator is used —
 * no external host, no real message. Every row this suite writes belongs to its
 * `agent_test_om6_*` account and is deleted by exact key in `afterAll`.
 *
 * The plan's acceptance lines are each exercised through the real pipeline: an inbound event is
 * received on the Omnichannel webhook prefix, processed by the Voice worker door, and lands as one
 * conversation + one message attached to one channel thread; a second channel for the same address
 * attaches a *thread* instead of opening a second conversation (contract §4 continuity); a replayed
 * receipt cannot duplicate the message; the workspace facade reads the projection and delegates every
 * command to the owner; an unknown delivery is reconciled by provider evidence (E7); and a source
 * scan proves no send/ingest/status implementation lives in this module.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om6_${RUN}`;
const WEBHOOK_SECRET = `whsec_agent_test_om6_${RUN}`;
const PHONE = '+14155550111';
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;

let ctx: ApiContext;
let adminUserId: string;
let smsReceiptId = '';
let priorVoiceSettings: string | null = null;

type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: headers ?? authHeader(ctx.adminToken),
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

function signedHeaders(body: Record<string, unknown>, timestamp = new Date().toISOString()): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(WEBHOOK_SECRET, timestamp, body),
  };
}

async function inbound(eventId: string, channel: 'sms' | 'whatsapp', messageId: string): Promise<string> {
  const body = { eventId, type: 'message.inbound', messageId, channel, from: PHONE, to: '+14155550199', body: 'AGENT_TEST_OM6 hello', occurredAt: new Date().toISOString() };
  const accepted = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body));
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const receiptId = String(accepted.body['eventId'] ?? '');
  const processed = await call('POST', '/api/v1/VoiceCommunications/action/webhook-events/process', { eventId: receiptId }, {
    ...authHeader(ctx.adminToken),
    'x-worker-secret': process.env.REPORT_WORKER_SECRET ?? '',
  });
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);
  return receiptId;
}

async function conversationRows(): Promise<{ id: string; channel: string; unread_count: number; priority: string; last_message_at: Date | null; status: string; case_id: string | null }[]> {
  return (await sql<{ id: string; channel: string; unread_count: number; priority: string; last_message_at: Date | null; status: string; case_id: string | null }>`
    select id, channel, unread_count, priority, last_message_at, status, case_id
    from voice_conversations where account_key = ${ACCOUNT_KEY} order by created_at asc
  `.execute(ctx.database.db)).rows;
}

async function threadRows(): Promise<{ conversation_id: string; channel: string; address: string | null }[]> {
  return (await sql<{ conversation_id: string; channel: string; address: string | null }>`
    select conversation_id, channel, address from voice_conversation_threads where account_key = ${ACCOUNT_KEY}
    order by channel asc
  `.execute(ctx.database.db)).rows;
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  const created = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om6 threads`,
    environment: 'test',
    enabled: true,
    capabilities: [
      'messaging.sms.send',
      'messaging.sms.receive',
      'messaging.whatsapp.send',
      'messaging.whatsapp.receive',
      'messaging.deliveryStatus',
      'webhook.signatureValidation',
      'provider.healthCheck',
    ],
    config: { sandboxRecipients: [PHONE] },
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  adminUserId = String((await sql<{ id: string }>`select id from users where user_name = 'admin' limit 1`.execute(ctx.database.db)).rows[0]?.id ?? '');
  expect(adminUserId).not.toBe('');

  // The shared Voice settings row gates sending (sms/whatsapp flags + default account). Snapshot it
  // and put it back exactly in afterAll; consent is recorded for this suite's phone only.
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorVoiceSettings = row === undefined ? null : JSON.stringify(row.data);
  const settings = await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { sms: true, whatsapp: true },
    provider: { defaultAccountKey: ACCOUNT_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  for (const channel of ['sms', 'whatsapp'] as const) {
    const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
      channel,
      address: PHONE,
      purpose: 'service',
      status: 'granted',
      basis: 'explicit_opt_in',
      source: 'manual_record',
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(201);
  }
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  ctx.app.get(VoiceProviderRegistry, { strict: false }).simulator().setScriptedStatus('delivered');
  await sql`delete from voice_consent_events where address = ${PHONE}`.execute(db).catch(() => undefined);
  await sql`delete from voice_suppressions where address = ${PHONE}`.execute(db).catch(() => undefined);
  if (priorVoiceSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorVoiceSettings) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  }
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  await sql`
    delete from jobs where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await shutdownApi();
});

describe('Omnichannel canonical conversation services (19-OM.6)', () => {
  it('creates one canonical conversation and one message attached to a channel thread', async () => {
    smsReceiptId = await inbound(`evt_${RUN}_sms`, 'sms', `SM_${RUN}_1`);
    const conversations = await conversationRows();
    expect(conversations.length).toBe(1);
    expect(conversations[0]?.channel).toBe('sms');
    expect(conversations[0]?.unread_count).toBe(1);
    expect(conversations[0]?.last_message_at).not.toBeNull();
    const threads = await threadRows();
    expect(threads.length).toBe(1);
    expect(threads[0]?.channel).toBe('sms');
    expect(threads[0]?.address).toBe(PHONE);
    const messages = (await sql<{ thread_id: string | null }>`
      select thread_id from voice_messages where account_key = ${ACCOUNT_KEY} and provider_message_id = ${`SM_${RUN}_1`}
    `.execute(ctx.database.db)).rows;
    expect(messages.length).toBe(1);
    expect(messages[0]?.thread_id).not.toBeNull();
  });

  it('attaches a second channel thread to the same conversation for the same address (contract §4)', async () => {
    await inbound(`evt_${RUN}_wa`, 'whatsapp', `SM_${RUN}_2`);
    const conversations = await conversationRows();
    // The continuity rule: the same normalized address on another open channel joins the conversation.
    expect(conversations.length).toBe(1);
    const threads = await threadRows();
    expect(threads.map((thread) => thread.channel).sort()).toEqual(['sms', 'whatsapp']);
    expect(threads.every((thread) => thread.conversation_id === conversations[0]?.id)).toBe(true);
  });

  it('cannot duplicate the message when the same receipt is processed again', async () => {
    const reprocessed = await call('POST', '/api/v1/VoiceCommunications/action/webhook-events/process', { eventId: smsReceiptId }, {
      ...authHeader(ctx.adminToken),
      'x-worker-secret': process.env.REPORT_WORKER_SECRET ?? '',
    });
    expect(reprocessed.status).toBe(200);
    const rows = (await sql<{ n: string }>`
      select count(*)::text as n from voice_messages where account_key = ${ACCOUNT_KEY} and provider_message_id = ${`SM_${RUN}_1`}
    `.execute(ctx.database.db)).rows[0];
    expect(rows?.n).toBe('1');
  });

  it('serves the workspace projection and delegates mark-read/status/assign to the owner', async () => {
    const list = await call('GET', '/api/v1/Omnichannel/action/conversations');
    expect(list.status).toBe(200);
    const conversations = list.body['list'] as Record<string, unknown>[];
    const ours = await conversationRows();
    const view = conversations.find((entry) => entry['id'] === ours[0]?.id) ?? {};
    expect(view['id']).toBe(ours[0]?.id);
    expect(view['priority']).toBe('normal');
    expect(view['threads']).toHaveLength(2);
    const id = String(view['id'] ?? '');

    const threads = await call('GET', `/api/v1/Omnichannel/action/conversations/${id}/threads`);
    expect(threads.status).toBe(200);
    expect((threads.body['list'] as unknown[]).length).toBe(2);

    const timeline = await call('GET', `/api/v1/Omnichannel/action/conversations/${id}/timeline?limit=50`);
    expect(timeline.status).toBe(200);
    expect((timeline.body['entries'] as unknown[]).length).toBeGreaterThanOrEqual(2);

    const read = await call('POST', `/api/v1/Omnichannel/action/conversations/${id}/read`);
    expect(read.status).toBe(200);
    expect(read.body['unreadCount']).toBe(0);

    const status = await call('POST', `/api/v1/Omnichannel/action/conversations/${id}/status`, { status: 'pending_customer' });
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body['status']).toBe('pending_customer');
    // The conversation is independent of any Case (none exists, and none was touched).
    expect(status.body['caseId']).toBeNull();

    const assigned = await call('POST', `/api/v1/Omnichannel/action/conversations/${id}/assign`, { userId: adminUserId, reason: 'AGENT_TEST_OM6 assignment' });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body['assignedUserId']).toBe(adminUserId);
  });

  it('reconciles an unknown delivery from provider evidence, never from an assumption (E7)', async () => {
    const id = String((await conversationRows())[0]?.id ?? '');
    const sent = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
      channel: 'sms',
      accountKey: ACCOUNT_KEY,
      conversationId: id,
      body: 'AGENT_TEST_OM6 outbound',
      idempotencyKey: `om6_send_${RUN}`,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const message = sent.body['message'] as Record<string, unknown>;
    expect(message['state']).toBe('sent');
    const messageId = String(message['id'] ?? '');
    // Simulate an outcome the callback never reported.
    await sql`update voice_messages set state = 'unknown' where id = ${messageId}`.execute(ctx.database.db);

    const reconciled = await call('POST', `/api/v1/Omnichannel/action/messages/${messageId}/reconcile`);
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    const after = reconciled.body['message'] as Record<string, unknown>;
    expect(after['state']).toBe('delivered');
    expect(reconciled.body['changed']).toBe(true);
    expect(reconciled.body['providerStatus']).toBe('delivered');

    const notes = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
      channel: 'sms',
      accountKey: ACCOUNT_KEY,
      conversationId: id,
      body: 'AGENT_TEST_OM6 internal note',
      idempotencyKey: `om6_note_${RUN}`,
      isInternalNote: true,
    });
    expect(notes.status).toBe(201);
    const noteId = String((notes.body['message'] as Record<string, unknown>)['id'] ?? '');
    const reconcileNote = await call('POST', `/api/v1/Omnichannel/action/messages/${noteId}/reconcile`);
    expect(reconcileNote.status).toBe(422);
  });

  it('owns no send/ingest/status implementation — the facade only reads the projection', () => {
    const dir = new URL('../src/omnichannel/', import.meta.url);
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(new URL(file, dir), 'utf8');
      if (/insert\s+into\s+voice_messages/i.test(source) || /insert\s+into\s+voice_conversations/i.test(source) || /update\s+voice_conversations/i.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
