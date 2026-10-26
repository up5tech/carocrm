import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ServiceDeskSettingsService } from '../src/service-desk/index.js';
import { VoiceMessagingService } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.11 — conversation routing through the ServiceDesk engine (D2, E8).
 *
 * Against the configured primary database (AGENTS.md §3.1). Queues, rules, the membership and the
 * calendar are ordinary metadata records created through the generic API (`AGENT_TEST_OM11_*`); the
 * conversations come from the owner's ingest service. Everything this suite creates is removed by
 * exact id/key in `afterAll`, and the shared `serviceDesk` settings row is restored byte-for-byte.
 *
 * Proved: a conversation-targeted rule routes a conversation to an accepting queue and its agent
 * deterministically, with the decision explained; a Case-only queue is never chosen; outside the
 * queue's business hours no agent is picked (the conversation waits in the queue); two concurrent
 * claims with the same expected version resolve to one; and a caller without the assign capability
 * is refused.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om11_${RUN}`;
const PHONE = '+14155550181';
const PHONE_WHATSAPP = '+14155550182';
const WEB_VISITOR = `visitor:om11-${RUN}`;

let ctx: ApiContext;
let adminId = '';
let priorSettings: string | null = null;
let queueId = '';
let caseOnlyQueueId = '';
let hoursQueueId = '';
let ruleId = '';
let calendarId = '';
const createdIds: { entity: string; id: string }[] = [];
let conversationA = '';
let conversationB = '';
let conversationC = '';

type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token ?? ctx.adminToken), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function createEntity(entity: string, data: Record<string, unknown>): Promise<string> {
  const res = await call('POST', `/api/v1/${entity}`, data);
  expect(res.status, `${entity}: ${JSON.stringify(res.body)}`).toBe(201);
  const id = String(res.body['id'] ?? '');
  createdIds.push({ entity, id });
  return id;
}

async function ingest(channel: 'sms' | 'whatsapp' | 'web_chat', from: string, id: string, accountKey = ACCOUNT_KEY): Promise<string> {
  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const result = await messaging.ingestInbound({
    accountKey,
    event: { kind: 'message', providerMessageId: id, state: 'delivered', direction: 'inbound', channel, from, to: null, body: `AGENT_TEST_OM11 ${id}`, occurredAt: new Date().toISOString(), failureCategory: null, vendorStatus: 'received' },
  });
  const row = (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${result.messageId}`.execute(ctx.database.db)).rows[0];
  return String(row?.conversation_id ?? '');
}

beforeAll(async () => {
  ctx = await bootApi();
  adminId = String((await sql<{ id: string }>`select id from users where user_name = 'admin' limit 1`.execute(ctx.database.db)).rows[0]?.id ?? '');

  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om11 routing`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'messaging.whatsapp.receive', 'webhook.signatureValidation'],
    config: {},
    webhookSecret: `whsec_om11_${RUN}`,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'serviceDesk').executeTakeFirst();
  priorSettings = row === undefined ? null : JSON.stringify(row.data);
  const settings = await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { queues: true, caseManagement: true } });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  queueId = await createEntity('CaseQueue', { name: 'AGENT_TEST OM11 queue', code: `om11_${RUN}`, strategy: 'roundRobin', acceptsConversations: true });
  await createEntity('QueueMember', { name: `AGENT_TEST OM11 membership ${RUN}`, queueId, userId: adminId });
  caseOnlyQueueId = await createEntity('CaseQueue', { name: 'AGENT_TEST OM11 case-only', code: `om11_case_${RUN}`, strategy: 'roundRobin' });
  calendarId = await createEntity('BusinessCalendar', { name: 'AGENT_TEST OM11 closed calendar', code: `om11_cal_${RUN}`, timezone: 'UTC', intervals: '{}' });
  hoursQueueId = await createEntity('CaseQueue', { name: 'AGENT_TEST OM11 hours queue', code: `om11_hours_${RUN}`, strategy: 'roundRobin', acceptsConversations: true, businessCalendarId: calendarId });
  await createEntity('QueueMember', { name: `AGENT_TEST OM11 hours membership ${RUN}`, queueId: hoursQueueId, userId: adminId });

  ruleId = await createEntity('RoutingRule', {
    name: `AGENT_TEST OM11 sms rule ${RUN}`,
    conditions: JSON.stringify([{ field: 'channel', operator: 'equals', value: 'sms' }]),
    routedObjectType: 'conversation',
    queueId,
    strategy: 'roundRobin',
    isActive: true,
    sortOrder: 1,
  });
  await createEntity('RoutingRule', {
    name: `AGENT_TEST OM11 whatsapp case-only ${RUN}`,
    conditions: JSON.stringify([{ field: 'channel', operator: 'equals', value: 'whatsapp' }]),
    routedObjectType: 'conversation',
    queueId: caseOnlyQueueId,
    strategy: 'roundRobin',
    isActive: true,
    sortOrder: 2,
  });
  await createEntity('RoutingRule', {
    name: `AGENT_TEST OM11 web rule ${RUN}`,
    conditions: JSON.stringify([{ field: 'channel', operator: 'in', value: ['web_chat'] }]),
    routedObjectType: 'conversation',
    queueId: hoursQueueId,
    strategy: 'roundRobin',
    isActive: true,
    sortOrder: 3,
  });

  conversationA = await ingest('sms', PHONE, `a_${RUN}`);
  conversationB = await ingest('whatsapp', PHONE_WHATSAPP, `b_${RUN}`);
  conversationC = await ingest('web_chat', WEB_VISITOR, `c_${RUN}`, 'omnichannel-web-chat');
  expect(conversationA && conversationB && conversationC).toBeTruthy();
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  for (const id of [conversationA, conversationB, conversationC].filter((value) => value !== '')) {
    await db.deleteFrom('voice_conversations').where('id', '=', id).execute().catch(() => undefined);
  }
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  for (const row of createdIds.reverse()) {
    await db.deleteFrom('entity_records').where('id', '=', row.id).execute().catch(() => undefined);
  }
  if (priorSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'serviceDesk').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorSettings) as Body, modified_at: new Date() }).where('name', '=', 'serviceDesk').execute().catch(() => undefined);
  }
  ctx.app.get(ServiceDeskSettingsService, { strict: false }).invalidate();
  await shutdownApi();
});

describe('Conversation routing (19-OM.11)', () => {
  it('routes through the matching conversation rule to its queue and agent, with the decision explained', async () => {
    const routed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/route`, {});
    expect(routed.status, JSON.stringify(routed.body)).toBe(200);
    const decision = routed.body['decision'] as Record<string, unknown>;
    expect(decision['routingRuleId']).toBe(ruleId);
    expect(decision['queueId']).toBe(queueId);
    expect(decision['assignedUserId']).toBe(adminId);
    expect(decision['strategy']).toBe('roundRobin');
    const conversation = routed.body['conversation'] as Record<string, unknown>;
    expect(conversation['assignedUserId']).toBe(adminId);

    const row = (await sql<{ current_queue_id: string | null; version: number; assigned_user_id: string | null }>`
      select current_queue_id, version, assigned_user_id from voice_conversations where id = ${conversationA}
    `.execute(ctx.database.db)).rows[0];
    expect(row?.current_queue_id).toBe(queueId);
    expect(row?.assigned_user_id).toBe(adminId);
    expect(Number(row?.version)).toBeGreaterThan(1);

    const event = (await sql<{ detail: string | null }>`
      select detail from voice_conversation_events where conversation_id = ${conversationA} and kind = 'assigned' order by created_at desc limit 1
    `.execute(ctx.database.db)).rows[0];
    expect(event?.detail).toContain(ruleId);
  });

  it('never sends a conversation to a queue that has not opted in, and falls back deterministically', async () => {
    const routed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationB}/route`, {});
    expect(routed.status, JSON.stringify(routed.body)).toBe(200);
    const decision = routed.body['decision'] as Record<string, unknown>;
    expect(decision['fallbackReason']).toBe('no-rule-matched');
    expect(decision['routingRuleId']).toBeNull();
    expect(decision['assignedUserId']).toBeNull();
    expect(decision['queueId']).not.toBe(caseOnlyQueueId);
  });

  it('applies business hours: outside the queue calendar no agent is assigned automatically', async () => {
    const routed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationC}/route`, {});
    expect(routed.status, JSON.stringify(routed.body)).toBe(200);
    const decision = routed.body['decision'] as Record<string, unknown>;
    expect(decision['queueId']).toBe(hoursQueueId);
    expect(decision['assignedUserId']).toBeNull();
    expect(decision['fallbackReason']).toBe('outside-working-hours');
    const row = (await sql<{ current_queue_id: string | null; assigned_user_id: string | null }>`
      select current_queue_id, assigned_user_id from voice_conversations where id = ${conversationC}
    `.execute(ctx.database.db)).rows[0];
    expect(row?.current_queue_id).toBe(hoursQueueId);
    expect(row?.assigned_user_id).toBeNull();
  });

  it('resolves two concurrent claims on the same version to one authoritative assignment', async () => {
    const current = (await sql<{ version: number }>`select version from voice_conversations where id = ${conversationB}`.execute(ctx.database.db)).rows[0];
    const version = Number(current?.version ?? 0);
    const first = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationB}/assign`, { userId: adminId, expectedVersion: version, reason: 'AGENT_TEST_OM11 claim one' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationB}/assign`, { userId: null, expectedVersion: version, reason: 'AGENT_TEST_OM11 claim two' });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toContain('CONCURRENCY_CONFLICT');
  });

  it('refuses routing to a caller without the assign capability', async () => {
    const user = await createTestUser(ctx, { userName: `AGENT_TEST OM11 plain ${RUN}` });
    const routed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationA}/route`, {}, user.token);
    expect(routed.status).toBe(403);
    await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
  });
});
