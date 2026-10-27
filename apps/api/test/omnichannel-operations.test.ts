import { readFileSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OmnichannelSettingsService } from '../src/omnichannel/index.js';
import {
  signFakeWebhook,
  VoiceCommunicationsSettingsService,
  VoiceMessagingService,
} from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.21 — administration, diagnostics and recovery
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.21`; runbook `docs/omnichannel/runbook.md`).
 *
 * Against the configured primary database (AGENTS.md §3.1). Fixtures live under
 * `agent_test_om21_*`, are created through the owner's ingress/send services, and are removed by
 * exact key in `afterAll`; the settings rows are restored byte-for-byte.
 *
 * Proved: the overview reads the owner's account/health/receipt/message records (no parallel store),
 * credential and webhook-secret presence are booleans only, inspection returns the redacted stored
 * payload and never a secret, replay reports its idempotent and refused effects and cannot duplicate
 * a receipt, a rejected signature cannot be replayed, the health probe is a documented adapter call,
 * the kill switch refuses new outbound with `account_disabled` while history survives, and the
 * capabilities split holds: `opsRead` can read but not replay, `connectionManage` gates the probe,
 * `settingsManage` gates the kill switch.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om21_${RUN}`;
const WEBHOOK_SECRET = `whsec_agent_test_om21_${RUN}`;
const PHONE = '+14155550621';
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;
const ROLE_NONE = `r_AGENT_TEST_OM21_none_${RUN}`;
const ROLE_OPS_READ = `r_AGENT_TEST_OM21_ops_${RUN}`;

let ctx: ApiContext;
let conversationId = '';
let failedReceiptId = '';
let forgedReceiptId = '';
let priorVoice: string | null = null;
let priorOmnichannel: string | null = null;
const createdUserIds: string[] = [];

type Body = Record<string, unknown>;

async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  token?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: headers ?? { ...authHeader(token ?? ctx.adminToken), 'content-type': 'application/json' },
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

function signedHeaders(body: Record<string, unknown>, secret = WEBHOOK_SECRET): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(secret, timestamp, body),
  };
}

function inboundBody(eventId: string): Record<string, unknown> {
  return {
    type: 'message.inbound',
    eventId,
    messageId: `SM${eventId}`,
    from: PHONE,
    to: '+14155550102',
    body: 'AGENT_TEST_OM21 diagnostic content',
    occurredAt: new Date().toISOString(),
  };
}

async function createReceipt(eventId: string, signed: boolean): Promise<string> {
  const body = inboundBody(eventId);
  await call('POST', `${OMNI}/message-events`, body, undefined, signedHeaders(body, signed ? WEBHOOK_SECRET : 'whsec_wrong_om21'));
  const row = (await sql<{ id: string }>`
    select id from voice_webhook_events
    where account_key = ${ACCOUNT_KEY} and vendor_event_id = ${eventId}
    order by received_at desc limit 1
  `.execute(ctx.database.db)).rows[0];
  return row?.id ?? '';
}

async function receiptCount(): Promise<number> {
  const row = (await sql<{ n: number }>`
    select count(*)::int as n from voice_webhook_events where account_key = ${ACCOUNT_KEY}
  `.execute(ctx.database.db)).rows[0];
  return Number(row?.n ?? 0);
}

async function messageCount(): Promise<number> {
  const row = (await sql<{ n: number }>`
    select count(*)::int as n from voice_messages where account_key = ${ACCOUNT_KEY}
  `.execute(ctx.database.db)).rows[0];
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om21 operations`,
    environment: 'test',
    enabled: true,
    capabilities: [
      'messaging.sms.send',
      'messaging.sms.receive',
      'messaging.deliveryStatus',
      'webhook.signatureValidation',
      'provider.healthCheck',
    ],
    config: {},
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const voiceRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorVoice = voiceRow === undefined ? null : JSON.stringify(voiceRow.data);
  const voiceSettings = await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { sms: true },
    provider: { defaultAccountKey: ACCOUNT_KEY },
  });
  expect(voiceSettings.status, JSON.stringify(voiceSettings.body)).toBe(200);
  const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
    channel: 'sms',
    address: PHONE,
    purpose: 'service',
    status: 'granted',
    basis: 'explicit_opt_in',
    source: 'manual_record',
  });
  expect([200, 201], JSON.stringify(consent.body)).toContain(consent.status);
  const omniRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'omnichannel').executeTakeFirst();
  priorOmnichannel = omniRow === undefined ? null : JSON.stringify(omniRow.data);

  // One canonical conversation with an outbound message whose outcome is unknown: this is the
  // kill-switch "awaiting confirmation" figure, recorded by the owner's send pipeline.
  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const inbound = await messaging.ingestInbound({
    accountKey: ACCOUNT_KEY,
    event: {
      kind: 'message',
      providerMessageId: `om21_in_${RUN}`,
      state: 'delivered',
      direction: 'inbound',
      channel: 'sms',
      from: PHONE,
      to: null,
      body: 'AGENT_TEST_OM21 inbound',
      occurredAt: new Date().toISOString(),
      failureCategory: null,
      vendorStatus: 'received',
    },
  });
  const row = (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${inbound.messageId}`.execute(ctx.database.db)).rows[0];
  conversationId = String(row?.conversation_id ?? '');
  const reply = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
    channel: 'sms',
    accountKey: ACCOUNT_KEY,
    conversationId,
    body: `AGENT_TEST_OM21 reply ${RUN}`,
    idempotencyKey: `om21_reply_${RUN}`,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  const replyId = String((reply.body['message'] as Record<string, unknown>)['id'] ?? '');
  await sql`
    update voice_messages set state = 'unknown', failure_category = 'timeout' where id = ${replyId}
  `.execute(ctx.database.db);

  failedReceiptId = await createReceipt(`evt_${RUN}_failed`, true);
  expect(failedReceiptId).not.toBe('');
  await sql`
    update voice_webhook_events
    set processing_status = 'failed', failure_code = 'PROCESSING_FAILED', failure_detail = 'AGENT_TEST_OM21 simulated processing failure'
    where id = ${failedReceiptId}
  `.execute(ctx.database.db);
  forgedReceiptId = await createReceipt(`evt_${RUN}_forged`, false);
  expect(forgedReceiptId).not.toBe('');

  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST OM21 none ${RUN}`, permissions: {} });
  await createTestRole(ctx, {
    id: ROLE_OPS_READ,
    name: `AGENT_TEST OM21 ops ${RUN}`,
    permissions: { OmnichannelOps: { read: 'all' } },
  });
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`
    delete from jobs
    where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from voice_consent_events where address = ${PHONE}`.execute(db).catch(() => undefined);
  await sql`delete from voice_suppressions where address = ${PHONE}`.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  for (const id of createdUserIds) await db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  await db.deleteFrom('roles').where('id', 'in', [ROLE_NONE, ROLE_OPS_READ]).execute().catch(() => undefined);
  if (priorVoice === null) await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorVoice) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  if (priorOmnichannel === null) await db.deleteFrom('app_settings').where('name', '=', 'omnichannel').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorOmnichannel) as Body, modified_at: new Date() }).where('name', '=', 'omnichannel').execute().catch(() => undefined);
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  ctx.app.get(OmnichannelSettingsService, { strict: false }).invalidate();
  await shutdownApi();
});

describe('Operations, diagnostics and recovery (19-OM.21)', () => {
  it('reads account health, presence flags, last event time and the outbound awaiting figure from the owner records', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/operations?days=7');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const accounts = result.body['accounts'] as {
      key: string;
      enabled: boolean;
      hasCredential: boolean;
      hasWebhookSecret: boolean;
      lastEventAt: string | null;
      awaitingConfirmation: number;
      capabilities: number;
      health: { status: string | null };
    }[];
    const account = accounts.find((entry) => entry.key === ACCOUNT_KEY);
    expect(account).toBeDefined();
    expect(account?.enabled).toBe(true);
    expect(account?.hasCredential).toBe(false);
    expect(account?.hasWebhookSecret).toBe(true);
    expect(account?.capabilities).toBeGreaterThan(0);
    expect(account?.lastEventAt).not.toBeNull();
    expect(account?.awaitingConfirmation).toBeGreaterThanOrEqual(1);

    const receipts = result.body['receipts'] as { status: string; count: number }[];
    expect(receipts.find((entry) => entry.status === 'failed')?.count ?? 0).toBeGreaterThanOrEqual(1);
    const failures = result.body['failures'] as { code: string; count: number }[];
    expect(failures.find((entry) => entry.code === 'PROCESSING_FAILED')?.count ?? 0).toBeGreaterThanOrEqual(1);

    // Presence, never a value: the webhook secret cannot appear in any diagnostic answer.
    expect(JSON.stringify(result.body)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(result.body)).not.toContain(PHONE);
  });

  it('never selects the ciphertext itself — only a presence flag', () => {
    // `security-hardening.md` T8: the operations projection never selects ciphertext. The presence
    // booleans are computed in SQL, so the encrypted columns never leave the database.
    const source = readFileSync(new URL('../src/omnichannel/omnichannel-operations.service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/select[^;]*credential_encrypted\s*,/i);
    expect(source).not.toMatch(/select[^;]*webhook_secret_encrypted\s*,/i);
    expect(source).toMatch(/\(credential_encrypted is not null\) as has_credential/i);
    expect(source).toMatch(/\(webhook_secret_encrypted is not null\) as has_webhook_secret/i);
  });

  it('lists failed receipts and inspects the redacted stored payload without a secret', async () => {
    const list = await call('GET', '/api/v1/Omnichannel/action/operations/events?status=failed');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const rows = list.body['list'] as { id: string; signatureValid: boolean; processingStatus: string }[];
    const failed = rows.find((entry) => entry.id === failedReceiptId);
    expect(failed?.processingStatus).toBe('failed');
    expect(failed?.signatureValid).toBe(true);

    const detail = await call('GET', `/api/v1/Omnichannel/action/operations/events/${failedReceiptId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const payload = detail.body['payload'] as Record<string, unknown>;
    expect(payload['type']).toBe('message.inbound');
    expect(JSON.stringify(detail.body)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(detail.body)).not.toContain('x-webhook-signature');
  });

  it('replays an authorized receipt with its effect statement and cannot duplicate the record', async () => {
    const before = { receipts: await receiptCount(), messages: await messageCount() };
    const first = await call('POST', `/api/v1/Omnichannel/action/operations/events/${failedReceiptId}/replay`, {});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['queued']).toBe(true);
    const effects = first.body['effects'] as { idempotent: string[]; refused: string[] };
    expect(effects.idempotent.length).toBe(2);
    expect(effects.refused.join(' ')).toContain('signature');

    const second = await call('POST', `/api/v1/Omnichannel/action/operations/events/${failedReceiptId}/replay`, {});
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await receiptCount()).toBe(before.receipts);
    expect(await messageCount()).toBe(before.messages);

    const refused = await call('POST', `/api/v1/Omnichannel/action/operations/events/${forgedReceiptId}/replay`, {});
    expect(refused.status).toBe(422);
    const row = (await sql<{ signature_valid: boolean; processing_status: string }>`
      select signature_valid, processing_status from voice_webhook_events where id = ${forgedReceiptId}
    `.execute(ctx.database.db)).rows[0];
    expect(row?.signature_valid).toBe(false);
    expect(row?.processing_status).toBe('rejected');
  });

  it('probes the connection through the adapter and splits the capabilities', async () => {
    const probe = await call('POST', `/api/v1/Omnichannel/action/operations/accounts/${ACCOUNT_KEY}/test`, {});
    expect(probe.status, JSON.stringify(probe.body)).toBe(200);
    expect(probe.body['ok']).toBe(true);
    expect(JSON.stringify(probe.body)).not.toContain(WEBHOOK_SECRET);

    const reader = await createTestUser(ctx, { userName: `AGENT_TEST OM21 reader ${RUN}`, roleIds: [ROLE_OPS_READ] });
    createdUserIds.push(reader.id);
    const readOverview = await call('GET', '/api/v1/Omnichannel/action/operations', undefined, reader.token);
    expect(readOverview.status, JSON.stringify(readOverview.body)).toBe(200);
    const replayDenied = await call('POST', `/api/v1/Omnichannel/action/operations/events/${failedReceiptId}/replay`, {}, reader.token);
    expect(replayDenied.status).toBe(403);
    const probeDenied = await call('POST', `/api/v1/Omnichannel/action/operations/accounts/${ACCOUNT_KEY}/test`, {}, reader.token);
    expect(probeDenied.status).toBe(403);

    const plain = await createTestUser(ctx, { userName: `AGENT_TEST OM21 plain ${RUN}`, roleIds: [ROLE_NONE] });
    createdUserIds.push(plain.id);
    const denied = await call('GET', '/api/v1/Omnichannel/action/operations', undefined, plain.token);
    expect(denied.status).toBe(403);
  });

  it('the kill switch stops new outbound while history and inbound receipt survive', async () => {
    const disable = await call('POST', `/api/v1/Omnichannel/action/operations/accounts/${ACCOUNT_KEY}/enabled`, { enabled: false });
    expect(disable.status, JSON.stringify(disable.body)).toBe(200);
    const impact = disable.body['impact'] as { outbound: string; history: string; awaitingConfirmation: number };
    expect(impact.outbound).toContain('account_disabled');
    expect(impact.history).toContain('unchanged');
    expect(impact.awaitingConfirmation).toBeGreaterThanOrEqual(1);

    const messagesBefore = await messageCount();
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM21 blocked outbound',
      idempotencyKey: `om21_blocked_${RUN}`,
    });
    expect(sent.status).toBe(422);
    const details = (sent.body['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    expect(details['refusals']).toContain('account_disabled');
    expect(await messageCount()).toBe(messagesBefore);

    // A disabled account still records inbound callbacks; they are not applied while disabled.
    const whileDisabled = inboundBody(`evt_${RUN}_disabled`);
    const callback = await call('POST', `${OMNI}/message-events`, whileDisabled, undefined, signedHeaders(whileDisabled));
    expect(callback.status).toBe(202);
    const stored = (await sql<{ n: number }>`
      select count(*)::int as n from voice_webhook_events
      where account_key = ${ACCOUNT_KEY} and dedup_key like ${`%evt_${RUN}_disabled%`}
    `.execute(ctx.database.db)).rows[0];
    expect(Number(stored?.n)).toBe(1);

    // History is untouched, and re-enabling restores outbound through the same policy pipeline.
    expect((await call('GET', '/api/v1/Omnichannel/action/conversations', undefined)).status).toBe(200);
    const enable = await call('POST', `/api/v1/Omnichannel/action/operations/accounts/${ACCOUNT_KEY}/enabled`, { enabled: true });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    const resumed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM21 resumed outbound',
      idempotencyKey: `om21_resumed_${RUN}`,
    });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(201);
  });
});
