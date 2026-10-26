import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AIToolContext,AIToolRegistry } from '../src/ai-agents/index.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { OmnichannelSettingsService } from '../src/omnichannel/index.js';
import {
  signFakeWebhook,
  VoiceCommunicationsSettingsService,
  VoiceInboxService,
  VoiceMessagingService,
} from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.22 — security, privacy and resilience hardening
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.22`; `docs/omnichannel/security-hardening.md`).
 *
 * Against the configured primary database (AGENTS.md §3.1): fixtures are `agent_test_om22_*`, every
 * write is a narrow insert/delete, and both settings rows are restored byte-for-byte.
 *
 * Proved here:
 *  - the owner timeline is customer-safe by default (internal notes need an explicit opt-in);
 *  - export excludes notes in SQL and no longer discloses how many exist;
 *  - web-chat mutations fail closed without an allowlisted Origin, the session budget resists cookie
 *    rotation, the message window is atomic, and client ids are session-scoped;
 *  - a forged callback cannot occupy the dedup key of the genuine one, and the diagnostic payload
 *    masks bodies/addresses while processing uses the internal copy;
 *  - an attachment must be readable and customer-visible before it can be sent;
 *  - an AI run only answers for its bound conversation, and the send tool only targets that
 *    conversation under the initiating actor.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om22_${RUN}`;
const WEBHOOK_SECRET = `whsec_agent_test_om22_${RUN}`;
const PHONE_A = '+14155550722';
const PHONE_B = '+14155550723';
const ORIGIN = 'https://agent.test';
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;
const ROLE_MESSAGE = `r_AGENT_TEST_OM22_msg_${RUN}`;
const ATTACHMENT_ID = `agent_test_om22_att_${RUN}`;
const AI_RUN_ID = `agent_test_om22_run_${RUN}`;
const SESSION_MARKER = `AGENT_TEST OM22 ${RUN}`;

let ctx: ApiContext;
let adminId = '';
let conversationA = '';
let conversationB = '';
let priorVoice: string | null = null;
let priorOmnichannel: string | null = null;
const createdUserIds: string[] = [];

type Body = Record<string, unknown>;
interface CallResult {
  readonly status: number;
  readonly body: Body;
  readonly setCookie: string | undefined;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
  remoteAddress?: string,
): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(headers ?? authHeader(ctx.adminToken)), 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  const raw = res.headers['set-cookie'];
  return { status: res.statusCode, body, setCookie: Array.isArray(raw) ? raw[0] : (raw as string | undefined) };
}

function cookieKeyOf(setCookie: string | undefined): string {
  return /omni_visitor=([^;]+)/.exec(setCookie ?? '')?.[1] ?? '';
}

function signedHeaders(body: Record<string, unknown>, secret = WEBHOOK_SECRET): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(secret, timestamp, body),
  };
}

function inboundBody(eventId: string, phone: string): Record<string, unknown> {
  return {
    type: 'message.inbound',
    eventId,
    messageId: `SM${eventId}`,
    from: phone,
    to: '+14155550100',
    body: `AGENT_TEST_OM22 secret message body ${RUN}`,
    occurredAt: new Date().toISOString(),
  };
}

async function restoreChatSettings(patch: Record<string, unknown>): Promise<void> {
  const res = await call('POST', '/api/v1/Omnichannel/action/settings', patch);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  const admin = (await sql<{ id: string }>`select id from users where user_name = 'admin' limit 1`.execute(ctx.database.db)).rows[0];
  adminId = admin?.id ?? '';

  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om22 security`,
    environment: 'test',
    enabled: true,
    capabilities: [
      'messaging.sms.send',
      'messaging.sms.receive',
      'messaging.deliveryStatus',
      'webhook.signatureValidation',
    ],
    config: { sandboxRecipients: [PHONE_A, PHONE_B] },
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
    address: PHONE_A,
    purpose: 'service',
    status: 'granted',
    basis: 'explicit_opt_in',
    source: 'manual_record',
  });
  expect([200, 201]).toContain(consent.status);

  const omniRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'omnichannel').executeTakeFirst();
  priorOmnichannel = omniRow === undefined ? null : JSON.stringify(omniRow.data);
  await restoreChatSettings({
    features: { workspace: true },
    webChat: {
      enabled: true,
      requireConsent: false,
      allowedOrigins: [ORIGIN],
      maxSessionsPerHour: 2,
      maxMessagesPerMinute: 3,
      maxBodyChars: 500,
    },
  });

  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const ingest = async (phone: string, key: string): Promise<string> => {
    const result = await messaging.ingestInbound({
      accountKey: ACCOUNT_KEY,
      event: {
        kind: 'message',
        providerMessageId: `om22_${key}_${RUN}`,
        state: 'delivered',
        direction: 'inbound',
        channel: 'sms',
        from: phone,
        to: null,
        body: `AGENT_TEST_OM22 inbound ${key}`,
        occurredAt: new Date().toISOString(),
        failureCategory: null,
        vendorStatus: 'received',
      },
    });
    return String((await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${result.messageId}`.execute(ctx.database.db)).rows[0]?.conversation_id ?? '');
  };
  conversationA = await ingest(PHONE_A, 'a');
  conversationB = await ingest(PHONE_B, 'b');
  expect(conversationA).not.toBe('');
  expect(conversationB).not.toBe('');
  const note = await call('POST', '/api/v1/VoiceCommunications/action/messages/send', {
    channel: 'sms',
    accountKey: ACCOUNT_KEY,
    conversationId: conversationA,
    body: `AGENT_TEST_OM22 INTERNAL ONLY ${RUN}`,
    idempotencyKey: `om22_note_${RUN}`,
    isInternalNote: true,
  });
  expect(note.status, JSON.stringify(note.body)).toBe(201);

  // An unreadable, non-customer-visible attachment: created_by is another user and it has no parent.
  await sql`
    insert into attachments (id, name, type, size, mime_type, storage_key, visibility, created_by_id, created_at)
    values (${ATTACHMENT_ID}, 'agent_test_om22.pdf', 'Attachment', 12, 'application/pdf',
            ${`attachments/${ATTACHMENT_ID}`}, 'internal', 'someone-else', now())
  `.execute(ctx.database.db);

  // A queued run row bound to conversation A, for the AI read/tool scope assertions. It references a
  // published demo agent so the foreign keys hold; no model call is made.
  const agent = (await sql<{ id: string; version_id: string; version: number }>`
    select a.id, v.id as version_id, v.version
    from ai_agents a join ai_agent_versions v on v.agent_id = a.id and v.version = a.current_version
    where a.is_deleted = false and a.status = 'published'
    limit 1
  `.execute(ctx.database.db)).rows[0];
  expect(agent).toBeDefined();
  await sql`
    insert into ai_agent_runs (id, agent_id, agent_version_id, agent_version, initiated_by_user_id, trigger, status, input, created_at, modified_at)
    values (${AI_RUN_ID}, ${String(agent?.id)}, ${String(agent?.version_id)}, ${Number(agent?.version ?? 1)},
            ${adminId}, 'integration', 'queued',
            ${JSON.stringify({ text: 'AGENT_TEST_OM22 bound run', record: { entity: 'CommunicationConversation', id: conversationA } })}::jsonb,
            now(), now())
  `.execute(ctx.database.db);

  await createTestRole(ctx, {
    id: ROLE_MESSAGE,
    name: `AGENT_TEST OM22 message ${RUN}`,
    permissions: { CommunicationMessage: { create: 'yes' }, CommunicationConversation: { read: 'yes' } },
  });
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`delete from jobs where target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})`.execute(db).catch(() => undefined);
  await sql`delete from voice_consent_events where address in (${PHONE_A}, ${PHONE_B})`.execute(db).catch(() => undefined);
  await sql`delete from voice_suppressions where address in (${PHONE_A}, ${PHONE_B})`.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  // Visitor sessions create web-chat conversations under the module's own account; remove the
  // conversations this run created before the session rows that point at them.
  await sql`
    delete from voice_conversations
    where id in (
      select conversation_id from omnichannel_visitor_sessions
      where user_agent like ${`${SESSION_MARKER}%`} and conversation_id is not null
    )
  `.execute(db).catch(() => undefined);
  await sql`delete from omnichannel_visitor_sessions where user_agent like ${`${SESSION_MARKER}%`}`.execute(db).catch(() => undefined);
  await sql`delete from attachments where id = ${ATTACHMENT_ID}`.execute(db).catch(() => undefined);
  await sql`delete from ai_agent_runs where id = ${AI_RUN_ID}`.execute(db).catch(() => undefined);
  for (const id of createdUserIds) await db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  await db.deleteFrom('roles').where('id', '=', ROLE_MESSAGE).execute().catch(() => undefined);
  if (priorVoice === null) await db.deleteFrom('app_settings').where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorVoice) as Body, modified_at: new Date() }).where('name', '=', 'voiceCommunications').execute().catch(() => undefined);
  if (priorOmnichannel === null) await db.deleteFrom('app_settings').where('name', '=', 'omnichannel').execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(priorOmnichannel) as Body, modified_at: new Date() }).where('name', '=', 'omnichannel').execute().catch(() => undefined);
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  ctx.app.get(OmnichannelSettingsService, { strict: false }).invalidate();
  await shutdownApi();
});

describe('Security hardening (19-OM.22)', () => {
  it('owner timeline is customer-safe by default; the agent surfaces opt in explicitly', async () => {
    const inbox = ctx.app.get(VoiceInboxService, { strict: false });
    const scope = ctx.app.get(REQUEST_SCOPE_TOKEN) as RequestScope;
    const principal = await ctx.auth.principalFromUser(adminId);
    const dto = await scope.runAs(principal, () => inbox.timeline(conversationA, { limit: 100, offset: 0 }));
    expect(JSON.stringify(dto)).not.toContain('INTERNAL ONLY');
    const agentView = await scope.runAs(principal, () => inbox.timeline(conversationA, { limit: 100, offset: 0, includeInternalNotes: true }));
    expect(JSON.stringify(agentView)).toContain('INTERNAL ONLY');
  });

  it('exports notes-free content and reports only that notes exist, never how many', async () => {
    const exported = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationA}/export`);
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    expect(JSON.stringify(exported.body)).not.toContain('INTERNAL ONLY');
    expect((exported.body['excluded'] as Record<string, unknown>)['internalNotes']).toBe(true);
  });

  it('web-chat mutations fail closed without an allowlisted Origin', async () => {
    const missing = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { 'user-agent': `${SESSION_MARKER} missing`, 'content-type': 'application/json' }, '198.51.100.10');
    expect(missing.status).toBe(403);
    const evil = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: 'https://evil.example', 'user-agent': `${SESSION_MARKER} evil`, 'content-type': 'application/json' }, '198.51.100.11');
    expect(evil.status).toBe(403);
    const allowed = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `${SESSION_MARKER} allowed`, 'content-type': 'application/json' }, '198.51.100.12');
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const cookie = cookieKeyOf(allowed.setCookie);
    const noOriginSend = await call(
      'POST',
      '/api/v1/Omnichannel/chat/messages',
      { clientMessageId: `om22_noorigin_${RUN}`, body: 'AGENT_TEST_OM22 hello' },
      { cookie: `omni_visitor=${cookie}`, 'content-type': 'application/json' },
      '198.51.100.12',
    );
    expect(noOriginSend.status).toBe(403);
  });

  it('the per-address session budget survives cookie rotation and the message window is atomic', async () => {
    const ip = '198.51.100.20';
    const first = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `${SESSION_MARKER} budget 1`, 'content-type': 'application/json' }, ip);
    expect(first.status).toBe(200);
    const second = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `${SESSION_MARKER} budget 2`, 'content-type': 'application/json' }, ip);
    expect(second.status).toBe(200);
    const third = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `${SESSION_MARKER} budget 3`, 'content-type': 'application/json' }, ip);
    expect(third.status).toBe(429);

    const cookie = cookieKeyOf(second.setCookie);
    for (let index = 0; index < 3; index += 1) {
      const sent = await call(
        'POST',
        '/api/v1/Omnichannel/chat/messages',
        { clientMessageId: `om22_rate_${RUN}_${index}`, body: `AGENT_TEST_OM22 rate ${index}` },
        { origin: ORIGIN, cookie: `omni_visitor=${cookie}`, 'content-type': 'application/json' },
        ip,
      );
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    }
    const limited = await call(
      'POST',
      '/api/v1/Omnichannel/chat/messages',
      { clientMessageId: `om22_rate_${RUN}_over`, body: 'AGENT_TEST_OM22 over' },
      { origin: ORIGIN, cookie: `omni_visitor=${cookie}`, 'content-type': 'application/json' },
      ip,
    );
    expect(limited.status).toBe(429);
  });

  it('scopes visitor client ids per session so one visitor cannot consume another’s idempotency', async () => {
    const clientId = `om22_shared_${RUN}`;
    for (const [ip, marker] of [['198.51.100.30', 'a'], ['198.51.100.31', 'b']] as const) {
      const session = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `${SESSION_MARKER} scope ${marker}`, 'content-type': 'application/json' }, ip);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      const cookie = cookieKeyOf(session.setCookie);
      const sent = await call(
        'POST',
        '/api/v1/Omnichannel/chat/messages',
        { clientMessageId: clientId, body: `AGENT_TEST_OM22 scope ${marker}` },
        { origin: ORIGIN, cookie: `omni_visitor=${cookie}`, 'content-type': 'application/json' },
        ip,
      );
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body['duplicate']).toBe(false);
      const listed = await call('GET', '/api/v1/Omnichannel/chat/messages', undefined, { origin: ORIGIN, cookie: `omni_visitor=${cookie}` }, ip);
      expect(listed.status).toBe(200);
      expect((listed.body['messages'] as { clientMessageId?: string }[]).map((row) => row.clientMessageId)).toEqual([clientId]);
    }
    const counts = (await sql<{ n: number }>`
      select count(*)::int as n from voice_messages where provider_message_id like ${`%:${clientId}`}
    `.execute(ctx.database.db)).rows[0];
    expect(Number(counts?.n)).toBe(2);
  });

  it('a forged callback cannot poison the genuine event, and diagnostics expose no customer content', async () => {
    const eventId = `evt_om22_${RUN}`;
    const body = inboundBody(eventId, PHONE_A);
    const forged = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body, 'whsec_wrong_om22'));
    expect(forged.status).toBe(401);
    const genuine = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body));
    expect(genuine.status).toBe(202);
    expect(genuine.body['accepted']).toBe(true);
    expect(genuine.body['duplicate']).toBe(false);
    expect(genuine.body['processingStatus']).toBe('received');
    const repeat = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body));
    expect(repeat.body['duplicate']).toBe(true);

    const rows = (await sql<{ id: string; signature_valid: boolean; dedup_key: string }>`
      select id, signature_valid, dedup_key from voice_webhook_events where account_key = ${ACCOUNT_KEY} and vendor_event_id = ${eventId}
      order by received_at asc
    `.execute(ctx.database.db)).rows;
    expect(rows.length).toBe(2);
    const valid = rows.find((row) => row.signature_valid);
    expect(valid?.dedup_key.startsWith('rejected:')).toBe(false);
    expect(rows.find((row) => !row.signature_valid)?.dedup_key.startsWith('rejected:')).toBe(true);

    const inspected = await call('GET', `/api/v1/Omnichannel/action/operations/events/${String(valid?.id ?? '')}`);
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    const payload = inspected.body['payload'] as Record<string, unknown>;
    expect(payload['type']).toBe('message.inbound');
    expect(payload['from']).toBe('[redacted]');
    expect(payload['body']).toBe('[redacted]');
    expect(JSON.stringify(inspected.body)).not.toContain(PHONE_A);
    expect(JSON.stringify(inspected.body)).not.toContain('secret message body');

    const internal = (await sql<{ payload_internal: unknown }>`
      select payload_internal from voice_webhook_events where id = ${String(valid?.id ?? '')}
    `.execute(ctx.database.db)).rows[0];
    expect(JSON.stringify(internal?.payload_internal)).toContain('secret message body');
  });

  it('refuses to send an attachment the actor cannot read or one that is not customer-visible', async () => {
    const user = await createTestUser(ctx, { userName: `AGENT_TEST OM22 sender ${RUN}`, roleIds: [ROLE_MESSAGE] });
    createdUserIds.push(user.id);
    const res = await call(
      'POST',
      '/api/v1/VoiceCommunications/action/messages/send',
      {
        channel: 'sms',
        accountKey: ACCOUNT_KEY,
        conversationId: conversationA,
        body: 'AGENT_TEST_OM22 attach',
        idempotencyKey: `om22_attach_${RUN}`,
        mediaAttachmentIds: [ATTACHMENT_ID],
      },
      { ...authHeader(user.token), 'content-type': 'application/json' },
    );
    expect([403, 404, 422], JSON.stringify(res.body)).toContain(res.status);
    const stored = (await sql<{ n: number }>`
      select count(*)::int as n from voice_messages where idempotency_key = ${`om22_attach_${RUN}`}
    `.execute(ctx.database.db)).rows[0];
    expect(Number(stored?.n)).toBe(0);
  });

  it('binds an AI run to its conversation and refuses a tool send aimed elsewhere', async () => {
    const own = await call('GET', `/api/v1/Omnichannel/action/ai/runs/${AI_RUN_ID}?conversationId=${conversationA}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body['runId']).toBe(AI_RUN_ID);

    const other = await call('GET', `/api/v1/Omnichannel/action/ai/runs/${AI_RUN_ID}?conversationId=${conversationB}`);
    expect(other.status).toBe(404);

    const registry = ctx.app.get(AIToolRegistry, { strict: false });
    const tool = registry.get('omnichannel.send_message');
    const context: AIToolContext = { runId: AI_RUN_ID, step: 1, actorUserId: adminId, idempotencyKey: `om22_tool_${RUN}` };
    await expect(
      tool.execute({ conversationId: conversationB, body: 'AGENT_TEST_OM22 tool send', idempotencyKey: `om22_tool_${RUN}` }, context),
    ).rejects.toThrow(/conversation it was started from/);
  });
});
