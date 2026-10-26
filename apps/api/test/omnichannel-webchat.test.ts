import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.9 — the website chat channel (contract §7; migration 079).
 *
 * Against the configured primary database (AGENTS.md §3.1). The visitor flows are exercised through
 * the public endpoints exactly as a widget would; rows this suite creates are the
 * `AGENT_TEST_WEBCHAT_*` conversations and the sessions whose conversations they are, all deleted by
 * conversation id in `afterAll`. The shared `omnichannel` settings row is snapshotted and restored.
 *
 * Proved here: a visitor session is created and resumed only through its httpOnly cookie; consent is
 * required and versioned; forged and expired sessions, disallowed origins and rate abuse are
 * rejected; the visitor's message lands in the canonical `web_chat` conversation through the normal
 * ingest path; an agent reply is visible to the widget while a staff **internal note is not**; two
 * visitors cannot see each other's history; and the widget responses carry no CRM/internal fields.
 */

const RUN = Date.now().toString(36);
const ORIGIN = 'https://widget.example';

let ctx: ApiContext;
let priorSettings: string | null = null;
let cookie = '';
let conversationId = '';

type Body = Record<string, unknown>;

interface CookieCapable {
  readonly status: number;
  readonly body: Body;
  readonly setCookie: string | undefined;
}

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>): Promise<CookieCapable> {
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
  const raw = res.headers['set-cookie'];
  const setCookie = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  return { status: res.statusCode, body, setCookie };
}

function cookieKeyOf(setCookie: string | undefined): string {
  const match = /omni_visitor=([^;]+)/.exec(setCookie ?? '');
  return match?.[1] ?? '';
}

async function restoreChatSettings(patch: Record<string, unknown>): Promise<void> {
  const res = await call('POST', '/api/v1/Omnichannel/action/settings', { webChat: patch });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'omnichannel').executeTakeFirst();
  priorSettings = row === undefined ? null : JSON.stringify(row.data);
  await restoreChatSettings({
    enabled: true,
    requireConsent: true,
    allowedOrigins: [ORIGIN],
    maxMessagesPerMinute: 4,
    maxBodyChars: 500,
    consentText: 'AGENT_TEST consent notice',
    consentVersion: 'test-1',
  });
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  const conversations = (await sql<{ id: string }>`
    select id from voice_conversations where account_key = 'omnichannel-web-chat' and channel = 'web_chat'
      and id in (select conversation_id from omnichannel_visitor_sessions where conversation_id is not null
                 and user_agent like ${`AGENT_TEST%${RUN}%`})
  `.execute(db)).rows;
  for (const row of conversations) {
    await db.deleteFrom('voice_conversations').where('id', '=', row.id).execute().catch(() => undefined);
  }
  await sql`delete from omnichannel_visitor_sessions where user_agent like ${`AGENT_TEST%${RUN}%`}`.execute(db).catch(() => undefined);
  if (priorSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', 'omnichannel').execute().catch(() => undefined);
  } else {
    await db.updateTable('app_settings').set({ data: JSON.parse(priorSettings) as Body, modified_at: new Date() }).where('name', '=', 'omnichannel').execute().catch(() => undefined);
  }
  const { OmnichannelSettingsService } = await import('../src/omnichannel/index.js');
  ctx.app.get(OmnichannelSettingsService, { strict: false }).invalidate();
  await shutdownApi();
});

describe('Website chat channel (19-OM.9)', () => {
  it('creates a visitor session and sets an httpOnly cookie, refusing a disallowed origin', async () => {
    const refused = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: 'https://evil.example', 'user-agent': `AGENT_TEST ${RUN}` });
    expect(refused.status).toBe(403);
    const created = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `AGENT_TEST ${RUN}` });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body['status']).toBe('new');
    expect((created.body['consent'] as Record<string, unknown>)['required']).toBe(true);
    expect((created.body['consent'] as Record<string, unknown>)['state']).toBe('pending');
    expect(created.setCookie ?? '').toContain('omni_visitor=');
    expect(created.setCookie ?? '').toContain('HttpOnly');
    expect(JSON.stringify(created.body)).not.toContain(cookieKeyOf(created.setCookie));
    cookie = cookieKeyOf(created.setCookie);
    expect(cookie).not.toBe('');
  });

  it('requires consent before the first message, then ingests it into the canonical web_chat conversation', async () => {
    const refused = await call('POST', '/api/v1/Omnichannel/chat/messages', { clientMessageId: `c_${RUN}_no_consent`, body: 'AGENT_TEST hello' }, { origin: ORIGIN, cookie: `omni_visitor=${cookie}` });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('consent_required');

    const accepted = await call('POST', '/api/v1/Omnichannel/chat/messages', { clientMessageId: `c_${RUN}_1`, body: 'AGENT_TEST hello', consent: true }, { origin: ORIGIN, cookie: `omni_visitor=${cookie}` });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body['accepted']).toBe(true);
    expect(accepted.body['duplicate']).toBe(false);

    const conversation = (await sql<{ id: string; channel: string; account_key: string }>`
      select c.id, c.channel, c.account_key from voice_conversations c
      join omnichannel_visitor_sessions s on s.conversation_id = c.id
      where s.user_agent like ${`AGENT_TEST%${RUN}%`} limit 1
    `.execute(ctx.database.db)).rows[0];
    expect(conversation?.channel).toBe('web_chat');
    expect(conversation?.account_key).toBe('omnichannel-web-chat');
    conversationId = String(conversation?.id ?? '');
    expect(conversationId).not.toBe('');

    const list = await call('GET', '/api/v1/Omnichannel/chat/messages', undefined, { origin: ORIGIN, cookie: `omni_visitor=${cookie}` });
    expect(list.status).toBe(200);
    const messages = list.body['messages'] as Record<string, unknown>[];
    expect(messages.some((message) => message['body'] === 'AGENT_TEST hello' && message['direction'] === 'inbound')).toBe(true);
    // No CRM or internal fields ever reach the widget.
    expect(JSON.stringify(list.body)).not.toMatch(/entityId|participantId|internal|assignedUserId|caseId/);
  });

  it('reconciles an optimistically resent message by its client id', async () => {
    const again = await call('POST', '/api/v1/Omnichannel/chat/messages', { clientMessageId: `c_${RUN}_1`, body: 'AGENT_TEST hello' }, { origin: ORIGIN, cookie: `omni_visitor=${cookie}` });
    expect(again.status).toBe(200);
    expect(again.body['duplicate']).toBe(true);
    const rows = (await sql<{ n: string }>`
      select count(*)::text as n from voice_messages where provider_message_id = ${`c_${RUN}_1`} and channel = 'web_chat'
    `.execute(ctx.database.db)).rows[0];
    expect(rows?.n).toBe('1');
  });

  it('shows an agent reply to the visitor but never a staff internal note', async () => {
    const reply = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST reply from the team',
      idempotencyKey: `om9_reply_${RUN}`,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect((reply.body['message'] as Record<string, unknown>)['state']).toBe('sent');

    const note = await call('POST', `/api/v1/Omnichannel/action/conversations/${conversationId}/messages`, {
      body: 'AGENT_TEST internal note for staff',
      idempotencyKey: `om9_note_${RUN}`,
      isInternalNote: true,
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);

    const list = await call('GET', '/api/v1/Omnichannel/chat/messages', undefined, { origin: ORIGIN, cookie: `omni_visitor=${cookie}` });
    const messages = list.body['messages'] as Record<string, unknown>[];
    expect(messages.some((message) => message['body'] === 'AGENT_TEST reply from the team' && message['direction'] === 'outbound')).toBe(true);
    expect(messages.some((message) => String(message['body']).includes('internal note'))).toBe(false);
    // The note exists in the record — the exclusion is the widget's query, not a missing write.
    const notes = (await sql<{ n: string }>`
      select count(*)::text as n from voice_messages where conversation_id = ${conversationId} and is_internal_note = true
    `.execute(ctx.database.db)).rows[0];
    expect(notes?.n).toBe('1');
  });

  it('rejects forged and expired sessions, and enforces the per-minute rate window', async () => {
    const forged = await call('GET', '/api/v1/Omnichannel/chat/messages', undefined, { origin: ORIGIN, cookie: 'omni_visitor=forged-key-value' });
    expect(forged.status).toBe(401);

    const fresh = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `AGENT_TEST rate ${RUN}` });
    const rateCookie = cookieKeyOf(fresh.setCookie);
    for (let index = 0; index < 4; index += 1) {
      const sent = await call('POST', '/api/v1/Omnichannel/chat/messages', { clientMessageId: `rate_${RUN}_${index}`, body: `AGENT_TEST rate ${index}`, consent: index === 0 }, { origin: ORIGIN, cookie: `omni_visitor=${rateCookie}` });
      expect(sent.status, `message ${index}: ${JSON.stringify(sent.body)}`).toBe(200);
    }
    const limited = await call('POST', '/api/v1/Omnichannel/chat/messages', { clientMessageId: `rate_${RUN}_over`, body: 'AGENT_TEST over' }, { origin: ORIGIN, cookie: `omni_visitor=${rateCookie}` });
    expect(limited.status).toBe(429);

    await sql`update omnichannel_visitor_sessions set expires_at = now() - interval '1 minute' where user_agent like ${`AGENT_TEST%${RUN}%`}`.execute(ctx.database.db);
    const expired = await call('GET', '/api/v1/Omnichannel/chat/messages', undefined, { origin: ORIGIN, cookie: `omni_visitor=${cookie}` });
    expect(expired.status).toBe(401);
  });

  it('keeps visitors isolated: a second session cannot see the first one’s history', async () => {
    const other = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN, 'user-agent': `AGENT_TEST other ${RUN}` });
    const otherCookie = cookieKeyOf(other.setCookie);
    const list = await call('GET', '/api/v1/Omnichannel/chat/messages', undefined, { origin: ORIGIN, cookie: `omni_visitor=${otherCookie}` });
    expect(list.status).toBe(200);
    expect((list.body['messages'] as unknown[]).length).toBe(0);
  });

  it('fails closed when the operator has not named an allowed origin', async () => {
    await restoreChatSettings({ allowedOrigins: [] });
    const refused = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN });
    expect(refused.status).toBe(403);
    // A server-to-server call without an Origin header is still allowed (tests/uptime checks).
    const noOrigin = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { 'user-agent': `AGENT_TEST noorigin ${RUN}` });
    expect(noOrigin.status).toBe(200);
    await restoreChatSettings({ allowedOrigins: [ORIGIN] });
  });

  it('refuses the whole channel while it is switched off', async () => {
    await restoreChatSettings({ enabled: false });
    const refused = await call('POST', '/api/v1/Omnichannel/chat/session', {}, { origin: ORIGIN });
    expect(refused.status).toBe(403);
    await restoreChatSettings({ enabled: true });
  });

  it('seeded the single web-chat connection the records reference (migration 079)', async () => {
    const rows = (await sql<{ key: string; enabled: boolean }>`
      select key, enabled from voice_provider_accounts where key = 'omnichannel-web-chat'
    `.execute(ctx.database.db)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
    // No second conversation store for the channel (D1).
    const tables = (await sql<{ n: string }>`
      select count(*)::text as n from information_schema.tables where table_schema='public' and table_name like 'omnichannel\\_conversation%'
    `.execute(ctx.database.db)).rows[0];
    expect(tables?.n).toBe('0');
  });
});
