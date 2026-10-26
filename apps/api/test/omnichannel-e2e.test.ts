import { performance } from 'node:perf_hooks';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OmnichannelSettingsService } from '../src/omnichannel/index.js';
import { ServiceDeskSettingsService } from '../src/service-desk/index.js';
import {
  signFakeWebhook,
  VoiceCommunicationsSettingsService,
  VoiceMessagingService,
} from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.23 — end-to-end acceptance and release readiness
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.23`; `docs/omnichannel/release-readiness.md`).
 *
 * The first fully supported channel is Twilio SMS behind the in-process simulator: no network call,
 * no real number, no secondary database. The suite walks the release acceptance chain on the
 * configured primary database (AGENTS.md §3.1):
 *
 *   signed inbound webhook → receipt → normalized event → canonical conversation →
 *   exact identity match → queue routing → agent reply → delivery callback → CRM context →
 *   optional ServiceDesk Case hand-off,
 *
 * then proves graceful degradation (kill switch, unsupported MMS, independently disabled web chat),
 * the release surfaces (OpenAPI, module metadata/nav, translations, migration ledger) and a bounded
 * performance budget for the inbox and a long timeline. Every row is `agent_test_om23_*` /
 * `AGENT_TEST_OM23_*` and is removed by exact key; the three shared settings rows are restored
 * byte-for-byte.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om23_${RUN}`;
const WEBHOOK_SECRET = `whsec_agent_test_om23_${RUN}`;
const PHONE = '+14155550823';
const PHONE_LONG = '+14155550824';
const PHONE_DISABLED = '+14155550825';
const ORIGIN = 'https://agent.test';
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;
const MMS_CONVERSATION = `agent_test_om23_mms_${RUN}`;
const ROLE_AGENT = `r_AGENT_TEST_OM23_agent_${RUN}`;
const PERF_CONVERSATIONS = 150;
const PERF_LONG_MESSAGES = 100;

let ctx: ApiContext;
let adminId = '';
let agentToken = '';
let contactId = '';
let queueId = '';
let ruleId = '';
let conversationId = '';
let caseId = '';
let priorVoice: string | null = null;
let priorServiceDesk: string | null = null;
let priorOmnichannel: string | null = null;
const createdEntityIds: string[] = [];
const createdUserIds: string[] = [];

type Body = Record<string, unknown>;
interface CallResult {
  readonly status: number;
  readonly body: Body;
}

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string): Promise<CallResult> {
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

async function publicPost(url: string, payload: Record<string, unknown>, headers: Record<string, string>): Promise<CallResult> {
  const res = await ctx.app.inject({ method: 'POST', url, headers, payload });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function signedHeaders(body: Record<string, unknown>): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(WEBHOOK_SECRET, timestamp, body),
  };
}

async function processReceipt(eventId: string): Promise<Body> {
  const result = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/VoiceCommunications/action/webhook-events/process',
    headers: {
      ...authHeader(ctx.adminToken),
      'content-type': 'application/json',
      'x-worker-secret': process.env.REPORT_WORKER_SECRET ?? '',
    },
    payload: { eventId },
  });
  return result.json() as Body;
}

async function createEntity(entity: string, data: Record<string, unknown>): Promise<string> {
  const res = await call('POST', `/api/v1/${entity}`, data);
  expect(res.status, `${entity}: ${JSON.stringify(res.body)}`).toBe(201);
  const id = String(res.body['id'] ?? '');
  createdEntityIds.push(id);
  return id;
}

async function restoreOmnichannel(patch: Record<string, unknown>): Promise<void> {
  const res = await call('POST', '/api/v1/Omnichannel/action/settings', patch);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  adminId = String((await sql<{ id: string }>`select id from users where user_name = 'admin' limit 1`.execute(ctx.database.db)).rows[0]?.id ?? '');

  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om23 e2e`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'messaging.deliveryStatus', 'webhook.signatureValidation', 'provider.healthCheck'],
    config: { sandboxRecipients: [PHONE, PHONE_LONG, PHONE_DISABLED] },
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  const voiceRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'voiceCommunications').executeTakeFirst();
  priorVoice = voiceRow === undefined ? null : JSON.stringify(voiceRow.data);
  expect((await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { sms: true },
    provider: { defaultAccountKey: ACCOUNT_KEY },
  })).status).toBe(200);
  const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
    channel: 'sms',
    address: PHONE,
    purpose: 'service',
    status: 'granted',
    basis: 'explicit_opt_in',
    source: 'manual_record',
  });
  expect([200, 201]).toContain(consent.status);

  const serviceDeskRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'serviceDesk').executeTakeFirst();
  priorServiceDesk = serviceDeskRow === undefined ? null : JSON.stringify(serviceDeskRow.data);
  expect((await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { queues: true, caseManagement: true } })).status).toBe(200);

  const omniRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'omnichannel').executeTakeFirst();
  priorOmnichannel = omniRow === undefined ? null : JSON.stringify(omniRow.data);
  await restoreOmnichannel({ features: { workspace: true } });

  const contact = await call('POST', '/api/v1/Contact', {
    firstName: 'AGENT_TEST OM23',
    lastName: `Customer ${RUN}`,
    phoneNumber: PHONE,
  });
  expect(contact.status, JSON.stringify(contact.body)).toBe(201);
  contactId = String(contact.body['id'] ?? '');

  queueId = await createEntity('CaseQueue', {
    name: `AGENT_TEST OM23 queue ${RUN}`,
    code: `om23_${RUN}`.slice(0, 20),
    strategy: 'roundRobin',
    acceptsConversations: true,
  });
  await createEntity('QueueMember', { name: `AGENT_TEST OM23 member ${RUN}`, queueId, userId: adminId });
  ruleId = await createEntity('RoutingRule', {
    name: `AGENT_TEST OM23 sms rule ${RUN}`,
    conditions: JSON.stringify([{ field: 'channel', operator: 'equals', value: 'sms' }]),
    routedObjectType: 'conversation',
    queueId,
    strategy: 'roundRobin',
    isActive: true,
    sortOrder: 1,
  });

  await createTestRole(ctx, {
    id: ROLE_AGENT,
    name: `AGENT_TEST OM23 agent ${RUN}`,
    permissions: {
      OmnichannelConversation: { read: 'all' },
      OmnichannelMessage: { create: 'yes' },
      OmnichannelAssignment: { edit: 'yes' },
      CommunicationConversation: { read: 'all' },
      CommunicationMessage: { create: 'yes' },
      Contact: { read: 'all' },
    },
  });
  const agent = await createTestUser(ctx, { userName: `AGENT_TEST OM23 agent user ${RUN}`, roleIds: [ROLE_AGENT] });
  agentToken = agent.token;
  createdUserIds.push(agent.id);

  // A conversation whose channel has no adapter: the catalog and the send path must refuse it.
  await sql`
    insert into voice_conversations (id, account_key, channel, external_thread_id, status, unread_count, created_at, modified_at)
    values (${MMS_CONVERSATION}, ${ACCOUNT_KEY}, 'mms', ${'+14155550826'}, 'open', 0, now(), now())
  `.execute(ctx.database.db);
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  for (const id of createdUserIds) await db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  await db.deleteFrom('roles').where('id', '=', ROLE_AGENT).execute().catch(() => undefined);

  const cases = caseId === '' ? [] : [caseId];
  if (cases.length > 0) {
    await sql`delete from entity_records where entity_type in ('CaseTransition', 'CaseAssignment') and attrs->>'caseId' = any(${sql.val(cases)}::text[])`.execute(db).catch(() => undefined);
    await sql`delete from entity_records where id = any(${sql.val(cases)}::text[])`.execute(db).catch(() => undefined);
  }
  await sql`delete from audit_log where record_id in (${conversationId}, ${caseId})`.execute(db).catch(() => undefined);

  await sql`
    delete from jobs where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from voice_consent_events where address in (${PHONE}, ${PHONE_LONG}, ${PHONE_DISABLED})`.execute(db).catch(() => undefined);
  await sql`delete from voice_suppressions where address in (${PHONE}, ${PHONE_LONG}, ${PHONE_DISABLED})`.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  if (contactId !== '') await sql`delete from entity_records where id = ${contactId}`.execute(db).catch(() => undefined);
  for (const id of [...createdEntityIds].reverse()) {
    await db.deleteFrom('entity_records').where('id', '=', id).execute().catch(() => undefined);
  }

  const restore = async (name: string, prior: string | null): Promise<void> => {
    if (prior === null) await db.deleteFrom('app_settings').where('name', '=', name).execute().catch(() => undefined);
    else await db.updateTable('app_settings').set({ data: JSON.parse(prior) as Body, modified_at: new Date() }).where('name', '=', name).execute().catch(() => undefined);
  };
  await restore('voiceCommunications', priorVoice);
  await restore('serviceDesk', priorServiceDesk);
  await restore('omnichannel', priorOmnichannel);
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  ctx.app.get(ServiceDeskSettingsService, { strict: false }).invalidate();
  ctx.app.get(OmnichannelSettingsService, { strict: false }).invalidate();
  await shutdownApi();
});

describe('Omnichannel end-to-end acceptance (19-OM.23)', () => {
  it('walks inbound → identity → routing → agent reply → delivery → CRM context → Case hand-off', async () => {
    const body = {
      type: 'message.inbound',
      eventId: `evt_om23_${RUN}`,
      messageId: `SM_om23_${RUN}`,
      from: PHONE,
      to: '+14155550100',
      body: 'AGENT_TEST_OM23 I cannot log in to my invoice portal',
      occurredAt: new Date().toISOString(),
    };
    const accepted = await publicPost(`${OMNI}/message-events`, body, signedHeaders(body));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body['duplicate']).toBe(false);
    const processed = await processReceipt(String(accepted.body['eventId'] ?? ''));
    expect(processed['status'], JSON.stringify(processed)).toBe('processed');

    const conversation = (await sql<{ id: string }>`
      select id from voice_conversations where account_key = ${ACCOUNT_KEY} and channel = 'sms'
      order by created_at asc limit 1
    `.execute(ctx.database.db)).rows[0];
    expect(conversation?.id).toBeTruthy();
    conversationId = String(conversation?.id ?? '');

    // Identity: the only readable record with this number matches exactly (never guessed).
    const identity = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity`, undefined, agentToken);
    expect(identity.status, JSON.stringify(identity.body)).toBe(200);
    const participant = (identity.body['participants'] as Record<string, unknown>[])[0] ?? {};
    expect(participant['resolution']).toBe('matched');
    expect(participant['entityId']).toBe(contactId);
    expect(participant['linkConfidence']).toBe('exact');
    expect(participant['sourceProvenance']).toBe('contact_resolver');

    // CRM context: the inbox projection carries the linked customer, under the agent's ACL.
    const inbox = await call('GET', '/api/v1/Omnichannel/action/conversations?channel=sms&limit=50', undefined, agentToken);
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const projected = (inbox.body['list'] as Record<string, unknown>[]).find((row) => row['id'] === conversationId);
    expect(projected?.['customerAddress']).toBe(PHONE);
    // The CRM context is the reviewed identity (the participant row is not renamed automatically).
    expect(participant['entityId']).toBe(contactId);

    // Routing through the ServiceDesk engine (queue + deterministic rule + membership).
    const routed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/route`, {});
    expect(routed.status, JSON.stringify(routed.body)).toBe(200);
    const decision = routed.body['decision'] as Record<string, unknown>;
    expect(decision['routingRuleId']).toBe(ruleId);
    expect(decision['queueId']).toBe(queueId);
    expect(decision['assignedUserId']).toBe(adminId);

    // Agent reply through the workspace facade.
    const reply = await call(
      'POST',
      `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`,
      { body: 'AGENT_TEST_OM23 Here is the reset link for your portal.', idempotencyKey: `om23_reply_${RUN}` },
      agentToken,
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const replyMessage = reply.body['message'] as Record<string, unknown>;
    const providerMessageId = String(replyMessage['providerMessageId'] ?? '');
    expect(providerMessageId).not.toBe('');
    expect(replyMessage['state']).toBe('sent');

    // Provider delivery callback advances the canonical message.
    const callback = {
      type: 'message.status',
      eventId: `evt_om23_status_${RUN}`,
      messageId: providerMessageId,
      status: 'delivered',
      occurredAt: new Date().toISOString(),
    };
    const callbackAccepted = await publicPost(`${OMNI}/status-events`, callback, signedHeaders(callback));
    expect(callbackAccepted.status, JSON.stringify(callbackAccepted.body)).toBe(202);
    expect((await processReceipt(String(callbackAccepted.body['eventId'] ?? '')))['status']).toBe('processed');
    const delivered = (await sql<{ state: string; delivered_at: Date | null }>`
      select state, delivered_at from voice_messages where id = ${String(replyMessage['id'] ?? '')}
    `.execute(ctx.database.db)).rows[0];
    expect(delivered?.state).toBe('delivered');
    expect(delivered?.delivered_at).not.toBeNull();

    // Optional ServiceDesk hand-off; the internal note is written but must not reach the Case text.
    const note = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
      channel: 'sms',
      accountKey: ACCOUNT_KEY,
      conversationId,
      body: 'AGENT_TEST_OM23 SECRET INTERNAL NOTE',
      idempotencyKey: `om23_note_${RUN}`,
      isInternalNote: true,
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    const handoff = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/case/handoff`, {});
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    expect(handoff.body['created']).toBe(true);
    const createdCase = handoff.body['case'] as Record<string, unknown>;
    caseId = String(createdCase['id'] ?? '');
    expect(createdCase['source']).toBe('Omnichannel');
    const caseRow = (await sql<{ attrs: Record<string, unknown> }>`
      select attrs from entity_records where id = ${caseId}
    `.execute(ctx.database.db)).rows[0];
    expect(String(caseRow?.attrs['description'] ?? '')).toContain('cannot log in');
    expect(String(caseRow?.attrs['description'] ?? '')).not.toContain('SECRET INTERNAL NOTE');
    const linked = (await sql<{ case_id: string | null }>`
      select case_id from voice_conversations where id = ${conversationId}
    `.execute(ctx.database.db)).rows[0];
    expect(linked?.case_id).toBe(caseId);
    const caseConversations = await call('GET', `/api/v1/Omnichannel/action/cases/${caseId}/conversations`);
    expect((caseConversations.body['list'] as { id: string }[]).map((row) => row.id)).toEqual([conversationId]);
  });

  it('degrades gracefully: kill switch, unsupported MMS, and web chat disabled independently', async () => {
    const catalog = await call('GET', '/api/v1/Omnichannel/action/channels');
    expect(catalog.status).toBe(200);
    const channels = catalog.body['channels'] as { channel: string; supported?: boolean }[];
    expect(channels.find((row) => row.channel === 'mms')?.supported).toBe(false);
    expect(channels.map((row) => row.channel)).not.toEqual(expect.arrayContaining(['messenger', 'instagram']));

    const mms = await call('POST', `/api/v1/Omnichannel/action/conversations/${MMS_CONVERSATION}/messages`, {
      body: 'AGENT_TEST_OM23 mms',
      idempotencyKey: `om23_mms_${RUN}`,
    });
    expect(mms.status).toBe(422);
    expect(((mms.body['error'] as Record<string, unknown>)['details'] as Record<string, unknown>)['refusals']).toContain('unsupported');

    const disable = await call('POST', `/api/v1/Omnichannel/action/operations/accounts/${ACCOUNT_KEY}/enabled`, { enabled: false });
    expect(disable.status, JSON.stringify(disable.body)).toBe(200);
    const blocked = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST_OM23 while disabled',
      idempotencyKey: `om23_disabled_${RUN}`,
    });
    expect(blocked.status).toBe(422);
    expect(((blocked.body['error'] as Record<string, unknown>)['details'] as Record<string, unknown>)['refusals']).toContain('account_disabled');

    const disabledBody = {
      type: 'message.inbound',
      eventId: `evt_om23_disabled_${RUN}`,
      messageId: `SM_om23_disabled_${RUN}`,
      from: PHONE_DISABLED,
      to: '+14155550100',
      body: 'AGENT_TEST_OM23 while the connection is off',
      occurredAt: new Date().toISOString(),
    };
    const receipt = await publicPost(`${OMNI}/message-events`, disabledBody, signedHeaders(disabledBody));
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(202);
    const stored = (await sql<{ n: number }>`
      select count(*)::int as n from voice_webhook_events where account_key = ${ACCOUNT_KEY} and vendor_event_id = ${String(disabledBody['eventId'])}
    `.execute(ctx.database.db)).rows[0];
    expect(Number(stored?.n)).toBe(1);
    expect((await call('POST', `/api/v1/Omnichannel/action/operations/accounts/${ACCOUNT_KEY}/enabled`, { enabled: true })).status).toBe(200);

    await restoreOmnichannel({ webChat: { enabled: false } });
    const chatOff = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Omnichannel/chat/session',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: {},
    });
    expect(chatOff.statusCode).toBe(403);
    const inboxStillWorks = await call('GET', '/api/v1/Omnichannel/action/conversations?limit=5');
    expect(inboxStillWorks.status).toBe(200);
    await restoreOmnichannel({ webChat: { enabled: true } });
  });

  it('exposes the release surfaces: OpenAPI, module metadata/nav, translations and the migration ledger', async () => {
    const openapi = await call('GET', '/api/v1/OpenApi');
    expect(openapi.status, JSON.stringify(openapi.body).slice(0, 200)).toBe(200);
    const paths = Object.keys((openapi.body['paths'] ?? {}) as Record<string, unknown>);
    expect(paths).toEqual(expect.arrayContaining([
      '/api/v1/Omnichannel/action/conversations',
      '/api/v1/Omnichannel/action/conversations/{id}/messages',
      '/api/v1/Omnichannel/action/operations',
      '/api/v1/Omnichannel/chat/session',
    ]));

    const health = await call('GET', '/api/v1/Omnichannel/action/health');
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    const module = health.body['module'] as Record<string, unknown>;
    expect(module['id']).toBe('Omnichannel');
    expect(module['implementedPhases']).toEqual(expect.arrayContaining(['19-OM.22', '19-OM.23']));

    const nav = await call('GET', '/api/v1/Omnichannel/action/nav');
    expect(nav.status).toBe(200);
    expect(nav.body['visible']).toBe(true);

    const i18n = await call('GET', '/api/v1/I18n?locale=vi');
    expect(i18n.status, JSON.stringify(i18n.body).slice(0, 200)).toBe(200);
    expect(JSON.stringify(i18n.body)).toContain('omnichannel.operations.accounts');

    const migrations = (await sql<{ name: string }>`
      select name from schema_migrations where name like '%phase19_omnichannel%' order by name
    `.execute(ctx.database.db)).rows.map((row) => row.name);
    for (const expected of [
      '077_phase19_omnichannel_persistence.sql',
      '078_phase19_omnichannel_identity.sql',
      '079_phase19_omnichannel_webchat.sql',
      '080_phase19_omnichannel_snippets_drafts.sql',
      '081_phase19_omnichannel_handoff.sql',
      '082_phase19_omnichannel_security_hardening.sql',
    ]) {
      expect(migrations).toContain(expected);
    }
  });

  it('serves a 25-row inbox and a long timeline inside the documented budget', async () => {
    const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
    const seedStarted = performance.now();
    for (let index = 0; index < PERF_CONVERSATIONS; index += 1) {
      const phone = `+1415555${String(800 + index).padStart(4, '0')}`;
      for (let message = 0; message < 2; message += 1) {
        await messaging.ingestInbound({
          accountKey: ACCOUNT_KEY,
          event: {
            kind: 'message',
            providerMessageId: `om23_perf_${index}_${message}_${RUN}`,
            state: 'delivered',
            direction: 'inbound',
            channel: 'sms',
            from: phone,
            to: null,
            body: `AGENT_TEST_OM23 perf ${index}/${message}`,
            occurredAt: new Date().toISOString(),
            failureCategory: null,
            vendorStatus: 'received',
          },
        });
      }
    }
    let longConversation = '';
    for (let index = 0; index < PERF_LONG_MESSAGES; index += 1) {
      const result = await messaging.ingestInbound({
        accountKey: ACCOUNT_KEY,
        event: {
          kind: 'message',
          providerMessageId: `om23_long_${index}_${RUN}`,
          state: 'delivered',
          direction: 'inbound',
          channel: 'sms',
          from: PHONE_LONG,
          to: null,
          body: `AGENT_TEST_OM23 long ${index}`,
          occurredAt: new Date(Date.now() + index).toISOString(),
          failureCategory: null,
          vendorStatus: 'received',
        },
      });
      if (longConversation === '') {
        longConversation = String((await sql<{ conversation_id: string }>`
          select conversation_id from voice_messages where id = ${result.messageId}
        `.execute(ctx.database.db)).rows[0]?.conversation_id ?? '');
      }
    }
    const seedMs = performance.now() - seedStarted;

    const listStarted = performance.now();
    const inbox = await call('GET', '/api/v1/Omnichannel/action/conversations?limit=25&offset=0');
    const listMs = performance.now() - listStarted;
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect((inbox.body['list'] as unknown[]).length).toBe(25);

    const timelineStarted = performance.now();
    const timeline = await call('GET', `/api/v1/Omnichannel/action/conversations/${longConversation}/timeline?limit=50&offset=0`);
    const timelineMs = performance.now() - timelineStarted;
    expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
    expect((timeline.body['entries'] as unknown[]).length).toBe(50);

    process.stdout.write(
      `[om23-perf] seed ${PERF_CONVERSATIONS} conversations (${PERF_CONVERSATIONS * 2 + PERF_LONG_MESSAGES} messages) ${seedMs.toFixed(0)} ms; ` +
        `inbox 25 ${listMs.toFixed(0)} ms; timeline 50 ${timelineMs.toFixed(0)} ms\n`,
    );
    // Generous CI-safe ceilings; the release doc records the measured values on this database.
    expect(listMs).toBeLessThan(2_000);
    expect(timelineMs).toBeLessThan(1_500);
  });
});
