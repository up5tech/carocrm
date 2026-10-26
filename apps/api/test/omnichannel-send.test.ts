import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  signFakeWebhook,
  VoiceCommunicationsSettingsService,
  type VoiceProviderAdapter,
  VoiceProviderError,
  VoiceProviderRegistry,
} from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.8 — outbound command, send state and reconciliation
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.8`; contract §9; extension E7).
 *
 * Against the configured primary database (AGENTS.md §3.1). The reply path uses the in-process
 * simulator; the timeout path uses a tiny scripted adapter registered through the documented DI seam
 * — no external host and no real message in either case. Rows belong to `agent_test_om8_*` accounts
 * and are removed by exact key; the shared Voice settings row and consent are restored/removed.
 *
 * Proved here: every send leaves an auditable command with an explicit state and its author; a
 * repeated idempotency key answers `duplicate` without a second dispatch; policy/consent and an
 * undeclared capability block server-side with named, UI-actionable refusal codes; and a provider
 * **timeout** records `unknown` (never `failed`) so the outcome is reconciled — or explicitly
 * unresolvable for operator review — instead of triggering a blind duplicate.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om8_${RUN}`;
const TIMEOUT_ACCOUNT_KEY = `agent_test_om8_timeout_${RUN}`;
const TIMEOUT_PROVIDER_KEY = `om8-timeout-${RUN}`;
const WEBHOOK_SECRET = `whsec_agent_test_om8_${RUN}`;
const PHONE = '+14155550144';
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;

let ctx: ApiContext;
let conversationId = '';
let priorSettings: string | null = null;
let timeoutAccountCreated = false;
let adapterCalls = 0;

type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({ method, url, headers: authHeader(ctx.adminToken), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
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

async function setSmsEnabled(enabled: boolean): Promise<void> {
  const res = await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { sms: enabled },
    provider: { defaultAccountKey: ACCOUNT_KEY },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function grantConsent(status: 'granted' | 'revoked'): Promise<void> {
  const res = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
    channel: 'sms',
    address: PHONE,
    purpose: 'service',
    status,
    basis: 'explicit_opt_in',
    source: 'manual_record',
  });
  expect([201, 200], JSON.stringify(res.body)).toContain(res.status);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();

  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om8 send`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'messaging.deliveryStatus', 'webhook.signatureValidation', 'provider.healthCheck'],
    config: { sandboxRecipients: [PHONE] },
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorSettings = row === undefined ? null : JSON.stringify(row.data);
  await setSmsEnabled(true);
  await grantConsent('granted');

  const body = { eventId: `evt_${RUN}_1`, type: 'message.inbound', messageId: `SM_${RUN}_in`, channel: 'sms', from: PHONE, to: '+14155550199', body: 'AGENT_TEST_OM8 hello', occurredAt: new Date().toISOString() };
  const timestamp = new Date().toISOString();
  const accepted = await postWithHeaders(`${OMNI}/message-events`, body, {
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
  conversationId = String((await sql<{ id: string }>`select id from voice_conversations where account_key = ${ACCOUNT_KEY} limit 1`.execute(ctx.database.db)).rows[0]?.id ?? '');
  expect(conversationId).not.toBe('');

  // A scripted adapter whose send times out. Registered through the documented test seam and given
  // an account of its own — no other suite resolves this key.
  const adapter: VoiceProviderAdapter = {
    info: {
      key: TIMEOUT_PROVIDER_KEY,
      label: 'AGENT_TEST OM8 timeout provider',
      mode: 'live',
      capabilities: ['messaging.sms.send'],
      channels: ['sms'],
      ratePerMinute: 0,
      maxConcurrency: 1,
      webhookSignature: 'none',
    },
    hasCapability: (capability) => capability === 'messaging.sms.send',
    validateWebhook: async () => {
      throw new VoiceProviderError('auth', 'not used');
    },
    normalizeEvent: () => ({ kind: 'unknown', reason: 'not used', occurredAt: null }),
    healthCheck: async () => ({ ok: true, checkedAt: new Date().toISOString(), detail: 'scripted' }),
    sendMessage: async () => {
      adapterCalls += 1;
      throw new VoiceProviderError('timeout', 'The scripted provider timed out after 15000 ms; the outcome is uncertain.');
    },
  };
  ctx.app.get(VoiceProviderRegistry, { strict: false }).register(adapter);
  const timeoutAccount = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: TIMEOUT_ACCOUNT_KEY,
    providerKey: TIMEOUT_PROVIDER_KEY,
    label: `AGENT_TEST ${RUN} om8 timeout`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send'],
    config: {},
    credential: 'agent-test-credential',
  });
  expect(timeoutAccount.status, JSON.stringify(timeoutAccount.body)).toBe(201);
  timeoutAccountCreated = true;
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`delete from voice_consent_events where address = ${PHONE}`.execute(db).catch(() => undefined);
  await sql`delete from voice_suppressions where address = ${PHONE}`.execute(db).catch(() => undefined);
  for (const key of [ACCOUNT_KEY, ...(timeoutAccountCreated ? [TIMEOUT_ACCOUNT_KEY] : [])]) {
    await sql`
      delete from jobs where job = 'voiceCommunications.processWebhookEvent'
        and target->>'eventId' in (select id from voice_webhook_events where account_key = ${key})
    `.execute(db).catch(() => undefined);
    await sql`delete from voice_conversations where account_key = ${key}`.execute(db).catch(() => undefined);
    await sql`delete from voice_webhook_events where account_key = ${key}`.execute(db).catch(() => undefined);
    await sql`delete from outbox_events where payload->>'accountKey' = ${key}`.execute(db).catch(() => undefined);
    await sql`delete from voice_provider_accounts where key = ${key}`.execute(db).catch(() => undefined);
  }
  if (priorSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorSettings) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  }
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  await shutdownApi();
});

describe('Omnichannel outbound command (19-OM.8)', () => {
  it('sends a reply through the facade with an explicit state, the actor and a thread', async () => {
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM8 reply',
      idempotencyKey: `om8_reply_${RUN}`,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body['duplicate']).toBe(false);
    const message = sent.body['message'] as Record<string, unknown>;
    expect(message['state']).toBe('sent');
    const row = (await sql<{ author_user_id: string | null; thread_id: string | null; state: string }>`
      select author_user_id, thread_id, state from voice_messages where id = ${String(message['id'])}
    `.execute(ctx.database.db)).rows[0];
    expect(row?.state).toBe('sent');
    expect(row?.author_user_id).not.toBeNull();
    expect(row?.thread_id).not.toBeNull();
  });

  it('answers a repeated idempotency key with duplicate and does not dispatch again', async () => {
    const again = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM8 reply',
      idempotencyKey: `om8_reply_${RUN}`,
    });
    expect(again.status).toBe(201);
    expect(again.body['duplicate']).toBe(true);
    const rows = (await sql<{ n: string }>`
      select count(*)::text as n from voice_messages where account_key = ${ACCOUNT_KEY} and idempotency_key = ${`om8_reply_${RUN}`}
    `.execute(ctx.database.db)).rows[0];
    expect(rows?.n).toBe('1');
  });

  it('refuses an undeclared capability with an explicit code instead of a silent drop', async () => {
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM8 media',
      idempotencyKey: `om8_media_${RUN}`,
      mediaAttachmentIds: ['att_not_real'],
    });
    expect(sent.status).toBe(422);
    const details = (sent.body['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    expect(details['refusals']).toContain('unsupported');
  });

  it('blocks a revoked-consent send server-side with an actionable refusal', async () => {
    await grantConsent('revoked');
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM8 after revoke',
      idempotencyKey: `om8_revoked_${RUN}`,
    });
    expect(sent.status).toBe(422);
    const details = (sent.body['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    expect(details['refusals']).toContain('consent_required');
    await grantConsent('granted');
  });

  it('blocks a send while the channel is unavailable, naming the channel', async () => {
    await setSmsEnabled(false);
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM8 channel off',
      idempotencyKey: `om8_off_${RUN}`,
    });
    expect(sent.status).toBe(422);
    const details = (sent.body['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    expect(details['refusals']).toContain('channel_unavailable');
    await setSmsEnabled(true);
  });

  it('records a provider timeout as `unknown` and requires reconciliation instead of a blind retry', async () => {
    const sent = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
      channel: 'sms',
      accountKey: TIMEOUT_ACCOUNT_KEY,
      to: PHONE,
      body: 'AGENT_TEST_OM8 timeout',
      idempotencyKey: `om8_timeout_${RUN}`,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const message = sent.body['message'] as Record<string, unknown>;
    expect(message['state']).toBe('unknown');
    expect(message['failureCategory']).toBe('timeout');
    const row = (await sql<{ failed_at: Date | null; provider_message_id: string | null }>`
      select failed_at, provider_message_id from voice_messages where id = ${String(message['id'])}
    `.execute(ctx.database.db)).rows[0];
    expect(row?.failed_at).toBeNull();

    // A timeout left no provider id, so there is nothing to query: reconciliation refuses explicitly
    // (never a silent "sent" or a second dispatch) and the attempt is left for operator review.
    const reconciled = await call('POST', `/api/v1/Omnichannel/action/messages/${String(message['id'])}/reconcile`);
    expect(reconciled.status).toBe(422);
    expect(JSON.stringify(reconciled.body)).toContain('provider');

    // Repeating the command with the same key returns the recorded attempt and calls the adapter once.
    const retried = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
      channel: 'sms',
      accountKey: TIMEOUT_ACCOUNT_KEY,
      to: PHONE,
      body: 'AGENT_TEST_OM8 timeout',
      idempotencyKey: `om8_timeout_${RUN}`,
    });
    expect(retried.body['duplicate']).toBe(true);
    expect(adapterCalls).toBe(1);
    const rows = (await sql<{ n: string }>`
      select count(*)::text as n from voice_messages where account_key = ${TIMEOUT_ACCOUNT_KEY} and idempotency_key = ${`om8_timeout_${RUN}`}
    `.execute(ctx.database.db)).rows[0];
    expect(rows?.n).toBe('1');
  });
});
