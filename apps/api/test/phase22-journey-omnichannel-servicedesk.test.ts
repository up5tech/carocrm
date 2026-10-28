import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import type { FileStorage } from '@carocrm/files';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import { AuthService } from '../src/auth/auth.service.js';
import { createApp } from '../src/bootstrap.js';
import { buildConfig } from '../src/config.js';
import { DatabaseService } from '../src/database/database.service.js';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { OmnichannelSettingsService } from '../src/omnichannel/omnichannel-settings.service.js';
import { ServiceDeskSettingsService } from '../src/service-desk/service-desk-settings.service.js';
import { signFakeWebhook } from '../src/voice-communications/index.js';
import { VoiceCommunicationsSettingsService } from '../src/voice-communications/voice-communications-settings.service.js';
import { buildMultipart } from './module-test-app.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, loginAs } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 22.11 — the journey: an Omnichannel conversation becomes a ServiceDesk case
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §13.4, steps 1–10).
 *
 * One story, in order, through the public contracts: a signed provider event arrives, it is
 * deduplicated and mapped to one canonical conversation and one canonical contact, the conversation
 * is routed to a queue and an agent, it is handed to Service Desk as a Case, an internal note is
 * written on that Case — and it never reaches a customer-facing payload. A second customer with the
 * same phone number is **not** merged into the first, and a portal user sees only the Cases that are
 * theirs.
 *
 * The provider is the in-process fake: the signature is really computed and really verified, and
 * nothing leaves the machine.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No database is created, reset or
 * truncated; every record is created with an `AGENT_TEST_LS22D_` marker and deleted by exact id.
 */

const runId = randomUUID();
const marker = (suffix: string) => `AGENT_TEST_LS22D_${suffix}_${runId}`;
const ACCOUNT_KEY = `agent_test_ls22d_${runId}`;
const WEBHOOK_SECRET = randomBytes(32).toString('hex');
const PHONE = `+1202555${String(randomInt(0, 10_000)).padStart(4, '0')}`;
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;
const INTERNAL_NOTE = 'LS22D_INTERNAL_SECRET_do_not_show';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

let ctx: ApiContext;
let portalToken = '';
let conversationId = '';
let caseId = '';
let receiptEventId = '';
let providerEventId = '';
let contactId = '';
let portalId = '';
let portalRoleId = '';
let portalUserId = '';
let adminSessionHash = '';
let queueId = '';
let ruleId = '';
let adminId = '';
const caseIds: string[] = [];
const attachmentIds: string[] = [];
const queued: { job: string; data: Record<string, unknown>; jobRowId?: string | undefined }[] = [];
const created = { ids: [] as string[], settings: {} as Record<string, unknown> };

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

async function call(
  method: Method,
  url: string,
  payload?: unknown,
  token?: string,
): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** The webhook door is public: no session, only the provider's signature. */
async function publicPost(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<CallResult> {
  const res = await ctx.app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
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

async function inboundBody(eventId: string, text: string): Promise<Record<string, unknown>> {
  return {
    type: 'message.inbound',
    eventId,
    messageId: `SM_${eventId}`,
    channel: 'sms',
    direction: 'inbound',
    from: PHONE,
    to: '+14155550100',
    body: text,
    occurredAt: new Date().toISOString(),
  };
}

/** Process a receipt the way the worker does. */
async function processReceipt(eventId: string): Promise<CallResult> {
  const response = await ctx.app.inject({
    method: 'POST', url: '/api/v1/VoiceCommunications/action/webhook-events/process',
    headers: { ...authHeader(ctx.adminToken), 'x-worker-secret': ctx.config.reportWorkerSecret }, payload: { eventId },
  });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

async function upload(caseRecordId: string, name: string, text: string): Promise<string> {
  const multipart = buildMultipart([
    { name: 'parentType', data: 'Case' }, { name: 'parentId', data: caseRecordId },
    { name: 'file', filename: name, contentType: 'text/plain', data: text },
  ]);
  const response = await ctx.app.inject({
    method: 'POST', url: '/api/v1/Attachment/upload',
    headers: { ...authHeader(ctx.adminToken), ...multipart.headers }, payload: multipart.payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json<{ id: string }>().id;
  attachmentIds.push(id);
  return id;
}

/** The `count` of a query that selected one. */
function countOf(result: { readonly rows: readonly { readonly count: number }[] }): number {
  return Number(result.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  // Reuse the configured database without reseeding installation settings or applying migrations.
  vi.stubEnv('MAIL_TRANSPORT', 'none');
  vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('REPORT_WORKER_SECRET', randomBytes(32).toString('hex'));
  vi.stubEnv('JOB_QUEUE_NAME', `agent-test-${runId}`);
  const config = buildConfig();
  const app = await createApp(config, { skipMigrations: true });
  const database = app.get(DatabaseService);
  const auth = app.get(AuthService);
  ctx = { app, config, database, auth, adminToken: '' };
  const admin = await database.db.selectFrom('users').select('id').where('user_name', '=', 'admin')
    .where('is_active', '=', true).where('is_deleted', '=', false).executeTakeFirstOrThrow();
  adminId = admin.id;
  const session = await auth.createSession(adminId, 'admin');
  adminSessionHash = createHash('sha256').update(session.refreshToken).digest('hex');
  ctx = { ...ctx, adminToken: session.accessToken };
  // Substitute only Redis delivery; JobsService still persists the real job and its payload.
  vi.spyOn(app.get(JobQueueService), 'enqueue').mockImplementation(async (input) => {
    queued.push(input);
    return `agent-test-${runId}-${queued.length}`;
  });
  for (const name of ['voiceCommunications', 'serviceDesk', 'omnichannel']) {
    created.settings[name] = await snapshotSettings(ctx, name);
  }

  const voice = await call('POST', '/api/v1/VoiceCommunications/action/settings', {
    features: { sms: true },
    provider: { defaultAccountKey: ACCOUNT_KEY },
    policy: { defaultRegion: 'US', requireConsent: { sms: true }, quietHours: { enabled: false } },
  });
  expect(voice.status, JSON.stringify(voice.body)).toBe(200);
  const serviceDesk = await call('POST', '/api/v1/ServiceDesk/action/settings', {
    features: { queues: true, caseManagement: true, portal: true, sla: false, notifications: true },
    assignment: { defaultQueueId: null },
  });
  expect(serviceDesk.status, JSON.stringify(serviceDesk.body)).toBe(200);
  const omnichannel = await call('POST', '/api/v1/Omnichannel/action/settings', { features: { workspace: true } });
  expect(omnichannel.status, JSON.stringify(omnichannel.body)).toBe(200);
  ctx.app.get(VoiceCommunicationsSettingsService, { strict: false }).invalidate();
  ctx.app.get(ServiceDeskSettingsService, { strict: false }).invalidate();
  ctx.app.get(OmnichannelSettingsService, { strict: false }).invalidate();

  // The provider account: the fake, with a webhook secret and the signature capability.
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${runId} ls22d journey`,
    environment: 'test',
    enabled: true,
    capabilities: [
      'messaging.sms.send',
      'messaging.sms.receive',
      'messaging.deliveryStatus',
      'webhook.signatureValidation',
      'provider.healthCheck',
    ],
    config: { sandboxRecipients: [PHONE] },
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  // The customer's consent for the channel, and the canonical contact.
  const consent = await call('POST', '/api/v1/VoiceCommunications/action/consent', {
    channel: 'sms',
    address: PHONE,
    purpose: 'service',
    status: 'granted',
    basis: 'explicit_opt_in',
    source: 'manual_record',
    evidence: marker('consent'),
  });
  expect(consent.status, JSON.stringify(consent.body)).toBeLessThan(300);

  const contact = await call('POST', '/api/v1/Contact', {
    firstName: 'Journey',
    lastName: `Customer ${runId}`,
    phoneNumber: PHONE,
    status: 'Active',
  });
  expect(contact.status, JSON.stringify(contact.body)).toBe(201);
  contactId = String(contact.body['id']);
  created.ids.push(contactId);

  const queue = await call('POST', '/api/v1/CaseQueue', {
    name: marker('queue'),
    code: `ls22d_${runId.slice(0, 20)}`,
    strategy: 'roundRobin',
    acceptsConversations: true,
  });
  expect(queue.status, JSON.stringify(queue.body)).toBe(201);
  queueId = String(queue.body['id']);
  created.ids.push(queueId);
  const member = await call('POST', '/api/v1/QueueMember', {
    name: marker('membership'),
    queueId,
    userId: adminId,
  });
  expect(member.status, JSON.stringify(member.body)).toBe(201);
  created.ids.push(String(member.body['id']));
  const rule = await call('POST', '/api/v1/RoutingRule', {
    name: marker('sms rule'),
    conditions: JSON.stringify([{ field: 'category', operator: 'equals', value: marker('routing') }]),
    routedObjectType: 'conversation',
    queueId,
    strategy: 'roundRobin',
    isActive: true,
    sortOrder: -2_000_000_000,
  });
  expect(rule.status, JSON.stringify(rule.body)).toBe(201);
  ruleId = String(rule.body['id']);
  created.ids.push(ruleId);

  // The portal customer: a portal, a role that may read cases, and a user bound to a contact.
  const portal = await call('POST', '/api/v1/Portal', { name: marker('Portal') });
  expect(portal.status, JSON.stringify(portal.body)).toBe(201);
  portalId = String(portal.body['id']);
  const portalRole = await call('POST', '/api/v1/PortalRole', {
    name: marker('PortalRole'),
    permissions: { Case: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'yes' } },
  });
  expect(portalRole.status, JSON.stringify(portalRole.body)).toBe(201);
  portalRoleId = String(portalRole.body['id']);
  const link = await call('POST', `/api/v1/Portal/${portalId}/roles`, { portalRoleIds: [portalRoleId] });
  expect(link.status, JSON.stringify(link.body)).toBe(201);
  const user = await call('POST', '/api/v1/User', {
    userName: `portal_${runId}`,
    password: 'portalpass123',
    type: 'portal',
    portalId,
    contactId,
    portalRoleIds: [portalRoleId],
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  portalUserId = String(user.body['id']);
  portalToken = await loginAs(ctx, `portal_${runId}`, 'portalpass123');
}, 240_000);

afterAll(async () => {
  if (!ctx) return;
  const db = ctx.database.db;
  try {
    if (caseIds.length > 0) {
      const children = await db.selectFrom('entity_records').select('id')
        .where('entity_type', 'in', ['CaseTransition', 'CaseAssignment', 'CaseSLAClock'])
        .where(sql<string>`attrs->>'caseId'`, 'in', caseIds).execute();
      created.ids.push(...children.map((row) => row.id));
      const streamIds = (await db.selectFrom('stream_items').select('id')
        .where('entity_type', '=', 'Case').where('entity_id', 'in', caseIds).execute()).map((row) => row.id);
      if (streamIds.length > 0) {
        await db.deleteFrom('stream_mentions').where('stream_item_id', 'in', streamIds).execute();
        await db.deleteFrom('stream_attachments').where('stream_item_id', 'in', streamIds).execute();
        await db.deleteFrom('stream_items').where('id', 'in', streamIds).execute();
      }
      await db.deleteFrom('stream_followers').where('entity_type', '=', 'Case').where('entity_id', 'in', caseIds).execute();
      await db.deleteFrom('notifications').where(sql<string>`data->>'caseId'`, 'in', caseIds).execute();
      await db.deleteFrom('outbox_events').where(sql<string>`payload->>'caseId'`, 'in', caseIds).execute();
    }
    for (const id of attachmentIds) {
      const row = await db.selectFrom('attachments').select('storage_key').where('id', '=', id).executeTakeFirstOrThrow();
      if (row.storage_key) await ctx.app.get<FileStorage>(FILE_STORAGE_TOKEN).delete(row.storage_key);
      await db.deleteFrom('attachments').where('id', '=', id).execute();
    }
    const jobIds = queued.map((entry) => entry.jobRowId).filter((id): id is string => id !== undefined);
    if (jobIds.length > 0) await db.deleteFrom('jobs').where('id', 'in', jobIds).execute();
    await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db);
    await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db);
    await db.deleteFrom('outbox_events').where(sql<string>`payload->>'accountKey'`, '=', ACCOUNT_KEY).execute();
    await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db);
    await sql`delete from voice_consent_events where address = ${PHONE} and evidence = ${marker('consent')}`.execute(db);
    if (created.ids.length > 0) {
      await db.deleteFrom('entity_links').where((eb) => eb.or([
        eb('record_id_a', 'in', created.ids), eb('record_id_b', 'in', created.ids),
      ])).execute();
      await db.deleteFrom('outbox_events').where(sql<string>`payload->>'entityId'`, 'in', created.ids).execute();
      await db.deleteFrom('audit_log').where('record_id', 'in', [...created.ids, conversationId, ACCOUNT_KEY]).execute();
      await db.deleteFrom('entity_records').where('id', 'in', created.ids).execute();
      expect(await db.selectFrom('entity_records').select('id').where('id', 'in', created.ids).execute()).toEqual([]);
    }
    if (portalUserId) await db.deleteFrom('users').where('id', '=', portalUserId).execute();
    if (portalId) await db.deleteFrom('portals').where('id', '=', portalId).execute();
    if (portalRoleId) await db.deleteFrom('portal_roles').where('id', '=', portalRoleId).execute();
    if (adminSessionHash) await db.deleteFrom('user_sessions').where('refresh_token', '=', adminSessionHash).execute();
    expect((await sql<{ id: string }>`select id from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db)).rows).toEqual([]);
  } finally {
    for (const [name, baseline] of Object.entries(created.settings)) await restoreSettings(ctx, name, baseline);
    ctx.app.get(VoiceCommunicationsSettingsService).invalidate();
    ctx.app.get(ServiceDeskSettingsService).invalidate();
    ctx.app.get(OmnichannelSettingsService).invalidate();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await ctx.app.close();
  }
}, 240_000);

describe('the journey: a conversation becomes a case (22.11)', () => {
  it('step 1 — a signed inbound event is accepted, and only one receipt is written', async () => {
    const body = await inboundBody(`evt_${runId}_inbound`, 'I cannot log in to my invoice portal');
    const accepted = await publicPost(`${OMNI}/message-events`, body, signedHeaders(body));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body['duplicate']).toBe(false);
    expect(accepted.body['accepted']).toBe(true);
    receiptEventId = String(accepted.body['eventId'] ?? '');
    expect(receiptEventId).not.toBe('');
    providerEventId = `evt_${runId}_inbound`;

    const receipts = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_webhook_events
        where account_key = ${ACCOUNT_KEY} and dedup_key = ${`id:${providerEventId}`}
      `.execute(ctx.database.db),
    );
    expect(receipts).toBe(1);
  });

  it('step 2 — a forged signature is refused, and it cannot occupy the genuine key', async () => {
    const body = await inboundBody(`evt_${runId}_forged`, 'forged');
    const forged = await publicPost(`${OMNI}/message-events`, body, {
      'content-type': 'application/json',
      'x-webhook-timestamp': new Date().toISOString(),
      'x-webhook-signature': 'not-the-signature',
    });
    expect(forged.status).toBe(401);
    expect(errorCode(forged)).toBe('AUTHENTICATION_FAILED');

    // The refusal is recorded under its own key, so the genuine delivery is still accepted.
    const accepted = await publicPost(`${OMNI}/message-events`, body, signedHeaders(body));
    expect(accepted.status).toBe(202);
    expect(accepted.body['duplicate']).toBe(false);
  });

  it('step 3 — the receipt becomes one canonical conversation, one message and one contact', async () => {
    const processed = await processReceipt(receiptEventId);
    expect(processed.status, JSON.stringify(processed.body)).toBe(200);
    expect(processed.body['status']).toBe('processed');
    expect(processed.body['kind']).toBe('message');

    const conversations = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_conversations where account_key = ${ACCOUNT_KEY}
      `.execute(ctx.database.db),
    );
    const messages = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_messages where account_key = ${ACCOUNT_KEY} and is_internal_note = false
      `.execute(ctx.database.db),
    );
    expect(conversations).toBe(1);
    expect(messages).toBe(1);

    const rows = (await sql<{ id: string }>`select id from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(ctx.database.db)).rows;
    expect(rows).toHaveLength(1);
    conversationId = rows[0]?.id ?? '';

    // The identity review resolves the participant to the canonical contact, with evidence.
    const review = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity`);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const participants = (review.body['participants'] ?? []) as Record<string, unknown>[];
    const participant = participants[0] ?? {};
    expect(participant['resolution']).toBe('matched');
    expect(participant['entityId']).toBe(contactId);
    expect(participant['linkConfidence']).toBe('exact');
    expect(participant['verificationState']).toBe('verified');
  });

  it('step 4 — the same delivery again changes nothing', async () => {
    const body = await inboundBody(`evt_${runId}_inbound`, 'I cannot log in to my invoice portal');
    const replay = await publicPost(`${OMNI}/message-events`, body, signedHeaders(body));
    expect(replay.status).toBe(202);
    expect(replay.body['duplicate']).toBe(true);
    expect(String(replay.body['eventId'] ?? '')).toBe(receiptEventId);

    const receipts = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_webhook_events
        where account_key = ${ACCOUNT_KEY} and dedup_key = ${`id:${providerEventId}`}
      `.execute(ctx.database.db),
    );
    const conversations = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_conversations where account_key = ${ACCOUNT_KEY}
      `.execute(ctx.database.db),
    );
    const messages = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_messages where account_key = ${ACCOUNT_KEY} and is_internal_note = false
      `.execute(ctx.database.db),
    );
    expect(receipts).toBe(1);
    expect(conversations).toBe(1);
    expect(messages).toBe(1);
  });

  it('step 5 — the conversation is routed to a queue and an agent, with the decision explained', async () => {
    // Category has no public writer; seed this fixture's routing attribute, never other conversations.
    await sql`update voice_conversations set category = ${marker('routing')} where id = ${conversationId}`.execute(ctx.database.db);
    const routed = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/route`, {});
    expect(routed.status, JSON.stringify(routed.body)).toBe(200);
    const decision = (routed.body['decision'] ?? {}) as Record<string, unknown>;
    expect(decision).toMatchObject({ routingRuleId: ruleId, queueId, assignedUserId: adminId });

    // The decision is stored on the conversation itself.
    const stored = (await sql<{ current_queue_id: string | null; assigned_user_id: string | null }>`
      select current_queue_id, assigned_user_id from voice_conversations where id = ${conversationId}
    `.execute(ctx.database.db)).rows[0];
    expect(stored?.current_queue_id).toBe(decision['queueId']);
    expect(stored?.assigned_user_id).toBe(decision['assignedUserId']);
  });

  it('step 6 — the hand-off creates one case, linked to the conversation', async () => {
    const internal = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: `${INTERNAL_NOTE}_conversation`, isInternalNote: true, idempotencyKey: `${runId}-internal`,
    });
    expect(internal.status, JSON.stringify(internal.body)).toBe(201);
    // Do not let installation-wide case rules assign this test case to unrelated users.
    expect((await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { queues: false } })).status).toBe(200);
    const handoff = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/case/handoff`, {});
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    expect(handoff.body['created']).toBe(true);
    expect(handoff.body['linked']).toBe(true);
    const createdCase = (handoff.body['case'] ?? {}) as Record<string, unknown>;
    caseId = String(createdCase['id'] ?? '');
    expect(caseId).not.toBe('');
    caseIds.push(caseId);
    created.ids.push(caseId);
    expect(createdCase['source']).toBe('Omnichannel');
    expect(createdCase['externalId']).toBe(`omnichannel:${conversationId}`);
    expect(String(createdCase['caseNumber'] ?? '')).not.toBe('');

    // The shared context is shared at the allowed level: the Case carries the customer's own words,
    // because those are what the customer can already see.
    const described = await ctx.database.db
      .selectFrom('entity_records')
      .select('attrs')
      .where('entity_type', '=', 'Case')
      .where('id', '=', caseId)
      .executeTakeFirst();
    const description = String((described?.attrs as Record<string, unknown>)['description'] ?? '');
    expect(description).toContain('I cannot log in to my invoice portal');
    expect(description).not.toContain(INTERNAL_NOTE);
    expect((described?.attrs as Record<string, unknown>)['contactId']).toBe(contactId);
  });

  it('step 7 — the hand-off is idempotent: a retry creates no second case', async () => {
    const again = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/case/handoff`, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body['created']).toBe(false);

    const cases = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from entity_records
        where entity_type = 'Case' and attrs->>'externalId' = ${`omnichannel:${conversationId}`} and deleted_at is null
      `.execute(ctx.database.db),
    );
    expect(cases).toBe(1);
  });

  it('step 8 — an authorized portal sees the public reply/file, never internal notes/files', async () => {
    expect((await call('GET', `/api/v1/Case/${caseId}`, undefined, portalToken)).status).toBe(200);
    const internalFile = await upload(caseId, 'internal.txt', INTERNAL_NOTE);
    const note = await call('POST', `/api/v1/ServiceDesk/action/case/${caseId}/note`, {
      text: INTERNAL_NOTE, attachmentIds: [internalFile], idempotencyKey: `${runId}-case-note`,
    });
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    expect(note.body['visibility']).toBe('internal');
    const publicText = marker('public reply');
    const publicFile = await upload(caseId, 'public.txt', publicText);
    const reply = await call('POST', `/api/v1/ServiceDesk/action/case/${caseId}/reply`, {
      text: publicText, attachmentIds: [publicFile],
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const agentStream = await call('GET', `/api/v1/Case/${caseId}/stream?order=asc&maxSize=100`);
    expect(agentStream.status).toBe(200);
    expect(JSON.stringify(agentStream.body)).toContain(INTERNAL_NOTE);
    for (const url of [
      `/api/v1/Case/${caseId}/stream?order=asc&maxSize=100`,
      `/api/v1/ServiceDesk/action/case/${caseId}/conversation`,
    ]) {
      const portal = await call('GET', url, undefined, portalToken);
      expect(portal.status, JSON.stringify(portal.body)).toBe(200);
      expect(JSON.stringify(portal.body)).toContain(publicText);
      expect(JSON.stringify(portal.body)).not.toContain(INTERNAL_NOTE);
      expect(JSON.stringify(portal.body)).not.toContain(internalFile);
      expect((portal.body['list'] as Record<string, unknown>[]).every((item) => item['visibility'] === 'public')).toBe(true);
    }
    for (const [id, token, status] of [
      [publicFile, portalToken, 200], [internalFile, ctx.adminToken, 200], [internalFile, portalToken, 403],
    ] as const) {
      const download = await ctx.app.inject({ method: 'GET', url: `/api/v1/Attachment/${id}/file`, headers: authHeader(token) });
      expect(download.statusCode, download.body).toBe(status);
      if (id === publicFile) expect(download.body).toBe(publicText);
      if (status === 403) expect(download.body).not.toContain(INTERNAL_NOTE);
    }
    expect((await call('POST', `/api/v1/ServiceDesk/action/case/${caseId}/note`, { text: 'forbidden' }, portalToken)).status).toBe(403);
    const timelineUrl = `/api/v1/VoiceCommunications/action/conversations/${conversationId}/timeline`;
    const staffTimeline = await call('GET', timelineUrl);
    expect(staffTimeline.status).toBe(200);
    expect(JSON.stringify(staffTimeline.body)).toContain(`${INTERNAL_NOTE}_conversation`);
    expect((await call('GET', timelineUrl, undefined, portalToken)).status).toBe(403);
    const exported = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/export`);
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    expect(JSON.stringify(exported.body)).toContain('I cannot log in');
    expect(JSON.stringify(exported.body)).not.toContain(INTERNAL_NOTE);
    const notifications = await ctx.database.db.selectFrom('notifications').select('data')
      .where(sql<string>`data->>'caseId'`, '=', caseId).execute();
    expect(JSON.stringify(notifications)).not.toContain(INTERNAL_NOTE);
    expect(JSON.stringify(notifications)).not.toContain(String(note.body['messageId']));
  });

  it('step 9 — a delayed delivery of the same message changes nothing', async () => {
    // The provider retries with a **new** event id but the same message id: a new receipt, and no
    // second message.
    const original = await inboundBody(`evt_${runId}_inbound`, 'I cannot log in to my invoice portal');
    const delayed = { ...original, eventId: `evt_${runId}_delayed` };
    const accepted = await publicPost(`${OMNI}/message-events`, delayed, signedHeaders(delayed));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body['duplicate']).toBe(false);

    const processed = await processReceipt(String(accepted.body['eventId'] ?? ''));
    expect(processed.status).toBe(200);

    const messages = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_messages where account_key = ${ACCOUNT_KEY} and is_internal_note = false
      `.execute(ctx.database.db),
    );
    const conversations = countOf(
      await sql<{ count: number }>`
        select count(*)::int as count from voice_conversations where account_key = ${ACCOUNT_KEY}
      `.execute(ctx.database.db),
    );
    expect(messages).toBe(1);
    expect(conversations).toBe(1);
  });

  it('step 10 — provider failure is recorded and replay cannot silently send again', async () => {
    const accountUrl = `/api/v1/VoiceCommunications/action/accounts/${ACCOUNT_KEY}`;
    expect((await call('PATCH', accountUrl, { config: { sandboxRecipients: [PHONE], simulateOutage: true } })).status).toBe(200);
    const url = `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`;
    const command = { body: marker('outage reply'), idempotencyKey: `${runId}-outage` };
    const failed = await call('POST', url, command);
    expect(failed.status, JSON.stringify(failed.body)).toBe(201);
    expect(failed.body['message']).toMatchObject({ state: 'failed', failureCategory: 'provider_unavailable', providerMessageId: null });
    const failedId = (failed.body['message'] as Record<string, unknown>)['id'];
    const inbound = await inboundBody(`evt_${runId}_during_outage`, 'still here');
    const accepted = await publicPost(`${OMNI}/message-events`, inbound, signedHeaders(inbound));
    expect(accepted.status).toBe(202);
    expect(accepted.body['accepted']).toBe(true);
    expect((await call('PATCH', accountUrl, { config: { sandboxRecipients: [PHONE], simulateOutage: false } })).status).toBe(200);
    const replay = await call('POST', url, command);
    expect(replay.body).toMatchObject({ duplicate: true, message: { id: failedId, state: 'failed' } });
    const sent = await call('POST', url, { body: marker('new deliberate reply'), idempotencyKey: `${runId}-recovered` });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body['message']).toMatchObject({ state: 'sent', failureCategory: null });
    const sameKey = await sql<{ id: string }>`select id from voice_messages
      where account_key = ${ACCOUNT_KEY} and idempotency_key = ${command.idempotencyKey}`.execute(ctx.database.db);
    expect(sameKey.rows).toHaveLength(1);
  });

  it('step 11 — a second contact with the same number is disputed, not merged', async () => {
    const duplicate = await call('POST', '/api/v1/Contact', {
      firstName: 'Duplicate',
      lastName: `Customer ${runId}`,
      phoneNumber: PHONE,
      status: 'Active',
    });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(201);
    created.ids.push(String(duplicate.body['id']));

    const review = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/identity`);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const participants = (review.body['participants'] ?? []) as Record<string, unknown>[];
    const participant = participants[0] ?? {};
    expect(participant['resolution']).toBe('ambiguous');
    expect(participant['entityId']).toBeNull();
    expect(participant['linkConfidence']).toBe('heuristic');
    expect(participant['verificationState']).toBe('disputed');

    // And it is waiting for a person, not silently resolved.
    const conflicts = await call('GET', '/api/v1/Omnichannel/action/identities/conflicts');
    expect(conflicts.status, JSON.stringify(conflicts.body)).toBe(200);
    const listed = (conflicts.body['list'] ?? []) as Record<string, unknown>[];
    expect(listed.some((row) => row['conversationId'] === conversationId)).toBe(true);
  });

  it('step 12 — a portal user reads the authorized case but not another customer case/file', async () => {
    const contact = await call('POST', '/api/v1/Contact', { lastName: marker('foreign customer') });
    expect(contact.status).toBe(201);
    const foreignContact = String(contact.body['id']);
    created.ids.push(foreignContact);
    const result = await call('POST', '/api/v1/Case', { name: marker('foreign case'), contactId: foreignContact });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const foreignCase = String(result.body['id']);
    created.ids.push(foreignCase);
    caseIds.push(foreignCase);
    const foreignFile = await upload(foreignCase, 'foreign.txt', marker('foreign content'));
    const reply = await call('POST', `/api/v1/ServiceDesk/action/case/${foreignCase}/reply`, { text: 'Other customer', attachmentIds: [foreignFile] });
    expect(reply.status).toBe(200);
    expect((await call('GET', `/api/v1/Case/${foreignCase}`, undefined, portalToken)).status).toBe(404);
    const visible = await call('GET', '/api/v1/Case?maxSize=200', undefined, portalToken);
    expect(visible.status, JSON.stringify(visible.body)).toBe(200);
    const list = (visible.body['list'] ?? []) as Record<string, unknown>[];
    expect(list.some((row) => row['id'] === caseId)).toBe(true);
    expect(list.some((row) => row['id'] === foreignCase)).toBe(false);
    const stream = await call('GET', `/api/v1/Case/${foreignCase}/stream`, undefined, portalToken);
    expect([403, 404]).toContain(stream.status);
    const download = await ctx.app.inject({ method: 'GET', url: `/api/v1/Attachment/${foreignFile}/file`, headers: authHeader(portalToken) });
    expect(download.statusCode).toBe(403);
    expect(download.body).not.toContain(marker('foreign content'));
  });
});
