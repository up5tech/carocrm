import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VoiceMessagingService } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.10 — the inbox filters are server-side and ACL-scoped
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.10`; acceptance "inbox filters use server-side
 * ACL-constrained data, not client filtering").
 *
 * Against the configured primary database (AGENTS.md §3.1). Conversations are created through the
 * owner's ingest service (the normal path for an inbound message) and their workspace columns are set
 * by SQL, because the priority/language/tag writers arrive with later phases. Every row belongs to
 * `agent_test_om10_*` / the seeded web-chat account addressed `visitor:agent-test-om10...` and is
 * removed by exact key/address in `afterAll`.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om10_${RUN}`;
const PHONE_HOT = '+14155550171';
const PHONE_COLD = '+14155550172';
const VISITOR = `visitor:${RUN}`;

let ctx: ApiContext;
let hot = '';
let cold = '';
let chat = '';

type Body = Record<string, unknown>;

async function call(url: string): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ctx.adminToken) });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function list(querystring: string): Promise<{ total: number; ids: string[] }> {
  const result = await call(`/api/v1/Omnichannel/action/conversations?limit=50${querystring === '' ? '' : `&${querystring}`}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const rows = (result.body['list'] as Record<string, unknown>[]) ?? [];
  return { total: Number(result.body['total'] ?? 0), ids: rows.map((row) => String(row['id'])) };
}

beforeAll(async () => {
  ctx = await bootApi();
  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const account = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/VoiceCommunications/action/accounts',
    headers: authHeader(ctx.adminToken),
    payload: { key: ACCOUNT_KEY, providerKey: 'fake', label: `AGENT_TEST ${RUN} om10 inbox`, environment: 'test', enabled: true, capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'messaging.whatsapp.receive', 'webhook.signatureValidation'], config: {}, webhookSecret: `whsec_om10_${RUN}` },
  });
  expect(account.statusCode, account.body).toBe(201);

  async function ingest(accountKey: string, channel: 'sms' | 'whatsapp' | 'web_chat', from: string, id: string): Promise<string> {
    const result = await messaging.ingestInbound({
      accountKey,
      event: { kind: 'message', providerMessageId: id, state: 'delivered', direction: 'inbound', channel, from, to: null, body: `AGENT_TEST_OM10 ${id}`, occurredAt: new Date().toISOString(), failureCategory: null, vendorStatus: 'received' },
    });
    const row = (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${result.messageId}`.execute(ctx.database.db)).rows[0];
    return String(row?.conversation_id ?? '');
  }

  hot = await ingest(ACCOUNT_KEY, 'sms', PHONE_HOT, `hot_${RUN}`);
  cold = await ingest(ACCOUNT_KEY, 'whatsapp', PHONE_COLD, `cold_${RUN}`);
  chat = await ingest('omnichannel-web-chat', 'web_chat', VISITOR, `chat_${RUN}`);
  expect(hot && cold && chat).toBeTruthy();

  const adminId = String((await sql<{ id: string }>`select id from users where user_name = 'admin' limit 1`.execute(ctx.database.db)).rows[0]?.id ?? '');
  await sql`
    update voice_conversations set priority = 'high', language = 'vi', tags = '["vip"]'::jsonb,
      snoozed_until = now() + interval '1 hour', assigned_user_id = ${adminId}
    where id = ${hot}
  `.execute(ctx.database.db);
  await sql`update voice_conversations set priority = 'low' where id = ${cold}`.execute(ctx.database.db);
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  for (const key of [ACCOUNT_KEY]) {
    await sql`delete from voice_conversations where account_key = ${key}`.execute(db).catch(() => undefined);
    await sql`delete from voice_webhook_events where account_key = ${key}`.execute(db).catch(() => undefined);
    await sql`delete from outbox_events where payload->>'accountKey' = ${key}`.execute(db).catch(() => undefined);
    await sql`delete from voice_provider_accounts where key = ${key}`.execute(db).catch(() => undefined);
  }
  await sql`delete from voice_conversations where account_key = 'omnichannel-web-chat' and channel = 'web_chat' and id in (${chat})`.execute(db).catch(() => undefined);
  await shutdownApi();
});

describe('Omnichannel inbox filters (19-OM.10)', () => {
  it('filters by priority, channel, tag, language, unread and snooze state in SQL', async () => {
    const high = await list('priority=high');
    expect(high.ids).toContain(hot);
    expect((await list('priority=low')).ids).toContain(cold);
    expect((await list('channel=web_chat')).ids).toContain(chat);
    expect((await list('tag=vip')).ids).toEqual([hot]);
    expect((await list('language=vi')).ids).toEqual([hot]);
    expect((await list('unread=true')).ids).toContain(hot);
    expect((await list('snoozed=only')).ids).toContain(hot);
    expect((await list('snoozed=exclude')).ids).not.toContain(hot);
    expect((await list('status=open')).ids).toContain(cold);
  });

  it('scopes unassigned versus mine on the server', async () => {
    const unassigned = await list('assignee=unassigned');
    expect(unassigned.ids).toContain(cold);
    expect(unassigned.ids).not.toContain(hot);
    const mine = await list('assignee=me');
    expect(mine.ids).toContain(hot);
    expect(mine.ids).not.toContain(cold);
  });

  it('returns the workspace projection the list renders (customer, priority, tags, threads)', async () => {
    const result = await call(`/api/v1/Omnichannel/action/conversations?limit=50&priority=high`);
    const row = (result.body['list'] as Record<string, unknown>[])[0] ?? {};
    expect(row['customerAddress']).toBe(PHONE_HOT);
    expect(row['priority']).toBe('high');
    expect(row['tags']).toEqual(['vip']);
    expect(Array.isArray(row['threads'])).toBe(true);
  });
});
