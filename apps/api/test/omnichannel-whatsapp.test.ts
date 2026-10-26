import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signFakeWebhook, VoiceCommunicationsSettingsService } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.14 — WhatsApp/SMS replies through the owning adapter, with honest policy refusals
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.14`; feasibility CF-2/CF-5).
 *
 * Against the configured primary database (AGENTS.md §3.1); simulator only. The WhatsApp window is
 * derived by the owner from **inbound communication events**, so this suite produces one through the
 * real webhook ingress (signed, processed) rather than inserting a message directly — exactly the
 * state a provider callback creates. Everything belongs to the `agent_test_om14_*` account and is
 * removed by exact key/id; the shared Voice settings row is restored byte-for-byte.
 *
 * Proved: an in-window reply is accepted through the workspace; outside the window a free-form reply
 * is refused with an actionable `template_required`; a revoked consent blocks with
 * `consent_required`; **MMS is reported unsupported and answers `unsupported`** — never a silent
 * success; and the catalog marks WhatsApp supported while MMS is not.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om14_${RUN}`;
const WEBHOOK_SECRET = `whsec_om14_${RUN}`;
const PHONE = '+14155550314';
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;
const MMS_CONVERSATION = `AGENT_TEST_OM14_mms_${RUN}`;

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

function refusals(body: Body): string[] {
  const details = (body['error'] as Record<string, unknown> | undefined)?.['details'] as { refusals?: string[] } | undefined;
  return details?.refusals ?? [];
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om14 whatsapp`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.whatsapp.send', 'messaging.whatsapp.receive', 'messaging.deliveryStatus', 'messaging.templates', 'webhook.signatureValidation', 'provider.healthCheck'],
    config: { sandboxRecipients: [PHONE] },
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorSettings = row === undefined ? null : JSON.stringify(row.data);
  const settings = await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { whatsapp: true },
    provider: { defaultAccountKey: ACCOUNT_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
    channel: 'whatsapp',
    address: PHONE,
    purpose: 'service',
    status: 'granted',
    basis: 'explicit_opt_in',
    source: 'manual_record',
  });
  expect([201, 200], JSON.stringify(consent.body)).toContain(consent.status);

  // A real inbound callback establishes the customer-service window (an inbound communication event).
  const body = { eventId: `evt_${RUN}_wa`, type: 'message.inbound', messageId: `SM_${RUN}_wa`, channel: 'whatsapp', from: PHONE, to: '+14155550399', body: 'AGENT_TEST_OM14 hello', occurredAt: new Date().toISOString() };
  const timestamp = new Date().toISOString();
  const accepted = await call('POST', `${OMNI}/message-events`, body, {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(WEBHOOK_SECRET, timestamp, body),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const processed = await call('POST', '/api/v1/VoiceCommunications/action/webhook-events/process', { eventId: accepted.body['eventId'] }, {
    ...authHeader(ctx.adminToken),
    'x-worker-secret': process.env.REPORT_WORKER_SECRET ?? '',
  });
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);
  conversationId = String(
    (await sql<{ id: string }>`select id from voice_conversations where account_key = ${ACCOUNT_KEY} and channel = 'whatsapp' limit 1`.execute(ctx.database.db)).rows[0]?.id ?? '',
  );
  expect(conversationId).not.toBe('');

  // A legacy MMS conversation: the channel exists in the vocabulary but no adapter implements it.
  const now = new Date();
  await sql`
    insert into voice_conversations (id, account_key, channel, external_thread_id, status, unread_count, created_at, modified_at)
    values (${MMS_CONVERSATION}, ${ACCOUNT_KEY}, 'mms', ${'+14155550315'}, 'open', 0, ${now}, ${now})
  `.execute(ctx.database.db);
  await sql`
    insert into voice_conversation_participants (id, conversation_id, address, role, created_at)
    values (${`${MMS_CONVERSATION}_p`}, ${MMS_CONVERSATION}, ${'+14155550315'}, 'customer', ${now})
  `.execute(ctx.database.db);
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`delete from voice_consent_events where address = ${PHONE}`.execute(db).catch(() => undefined);
  await sql`
    delete from jobs where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  if (priorSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorSettings) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  }
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  await shutdownApi();
});

describe('WhatsApp/SMS replies and policy refusals (19-OM.14)', () => {
  it('replies inside the customer-service window through the owning adapter', async () => {
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM14 in-window reply',
      idempotencyKey: `om14_in_${RUN}`,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((sent.body['message'] as Record<string, unknown>)['state']).toBe('sent');
  });

  it('refuses a free-form reply outside the window with template_required', async () => {
    await sql`
      update voice_communication_events set occurred_at = now() - interval '3 days'
      where account_key = ${ACCOUNT_KEY} and kind = 'message' and direction = 'inbound'
    `.execute(ctx.database.db);
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM14 outside window',
      idempotencyKey: `om14_out_${RUN}`,
    });
    expect(sent.status).toBe(422);
    expect(refusals(sent.body)).toContain('template_required');
  });

  it('blocks a revoked-consent reply with consent_required', async () => {
    const revoked = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
      channel: 'whatsapp',
      address: PHONE,
      purpose: 'service',
      status: 'revoked',
      basis: 'explicit_opt_in',
      source: 'manual_record',
    });
    expect([200, 201], JSON.stringify(revoked.body)).toContain(revoked.status);
    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM14 after revoke',
      idempotencyKey: `om14_revoked_${RUN}`,
      templateKey: 'om14_template',
      templateVariables: {},
    });
    expect(sent.status).toBe(422);
    expect(refusals(sent.body)).toContain('consent_required');
  });

  it('reports MMS as unsupported everywhere and refuses an MMS send explicitly', async () => {
    const catalog = await call('GET', '/api/v1/Omnichannel/action/channels');
    const channels = catalog.body['channels'] as Record<string, unknown>[];
    const mms = channels.find((row) => row['channel'] === 'mms');
    const whatsapp = channels.find((row) => row['channel'] === 'whatsapp');
    expect(mms?.['supported']).toBe(false);
    expect(mms?.['notes']).toEqual(expect.arrayContaining([expect.stringContaining('unsupported')]));
    expect(whatsapp?.['supported']).toBe(true);

    const sent = await call('POST', `/api/v1/Omnichannel/action/conversations/${MMS_CONVERSATION}/messages`, {
      body: 'AGENT_TEST_OM14 mms',
      idempotencyKey: `om14_mms_${RUN}`,
    });
    expect(sent.status).toBe(422);
    expect(refusals(sent.body)).toContain('unsupported');
  });
});
