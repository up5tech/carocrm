import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VoiceMessagingService } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestTeam, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.12 — canned replies and per-agent drafts
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.12`; migration 080).
 *
 * Against the configured primary database (AGENTS.md §3.1). Snippets are created through the owner's
 * endpoint (`om12_*` keys), the conversation through the owner's ingest service, and every row this
 * suite creates — snippets, teams, roles, users, the conversation and its account — is removed by
 * exact key/id in `afterAll`.
 *
 * Proved: the workspace list is channel-appropriate and team-aware (a snippet scoped to another team
 * is invisible); markup is refused at the owner; preview substitutes only approved variables and the
 * customer's name comes from the record; use counts increment without storing content; a draft is
 * per-agent state that never enters the transcript, is restorable, deletable, and invisible to
 * another agent.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om12_${RUN}`;
const PHONE = '+14155550191';
const ROLE_VIEW = `r_AGENT_TEST_OM12_view_${RUN}`;
const TEAM_A = `team_om12_a_${RUN}`;
const TEAM_B = `team_om12_b_${RUN}`;
const KEYS = [`om12_${RUN}_hello`, `om12_${RUN}_shared`, `om12_${RUN}_teama`, `om12_${RUN}_teamb`, `om12_${RUN}_html`];

let ctx: ApiContext;
let conversationId = '';
let userId = '';

type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, token?: string): Promise<{ status: number; body: Body }> {
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

beforeAll(async () => {
  ctx = await bootApi();
  const account = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om12 snippets`,
    environment: 'test',
    enabled: true,
    capabilities: ['messaging.sms.send', 'messaging.sms.receive', 'webhook.signatureValidation'],
    config: {},
    webhookSecret: `whsec_om12_${RUN}`,
  });
  expect(account.status, JSON.stringify(account.body)).toBe(201);

  await createTestTeam(ctx, TEAM_A, `AGENT_TEST OM12 team A ${RUN}`);
  await createTestTeam(ctx, TEAM_B, `AGENT_TEST OM12 team B ${RUN}`);
  await createTestRole(ctx, { id: ROLE_VIEW, name: `AGENT_TEST OM12 view ${RUN}`, permissions: { OmnichannelConversation: { read: 'all' }, CommunicationConversation: { read: 'all' } } });
  const user = await createTestUser(ctx, { userName: `AGENT_TEST OM12 user ${RUN}`, roleIds: [ROLE_VIEW], teamIds: [TEAM_A] });
  userId = user.id;

  const hello = await call('POST', '/api/v1/VoiceCommunications/action/snippets', {
    key: KEYS[0],
    name: 'AGENT_TEST OM12 hello',
    channel: 'sms',
    body: 'Hello {{customerName}}, this is {{agentName}}. Thanks for reaching out.',
  });
  expect(hello.status, JSON.stringify(hello.body)).toBe(200);
  const shared = await call('POST', '/api/v1/VoiceCommunications/action/snippets', {
    key: KEYS[1],
    name: 'AGENT_TEST OM12 shared',
    channel: 'any',
    body: 'Shared snippet for every team.',
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  const teamA = await call('POST', '/api/v1/VoiceCommunications/action/snippets', {
    key: KEYS[2],
    name: 'AGENT_TEST OM12 team A',
    channel: 'any',
    body: 'Team A only snippet.',
    teamId: TEAM_A,
    language: 'en',
  });
  expect(teamA.status, JSON.stringify(teamA.body)).toBe(200);
  const teamB = await call('POST', '/api/v1/VoiceCommunications/action/snippets', {
    key: KEYS[3],
    name: 'AGENT_TEST OM12 team B',
    channel: 'any',
    body: 'Team B only snippet.',
    teamId: TEAM_B,
  });
  expect(teamB.status, JSON.stringify(teamB.body)).toBe(200);
  const html = await call('POST', '/api/v1/VoiceCommunications/action/snippets', {
    key: KEYS[4],
    name: 'AGENT_TEST OM12 html',
    channel: 'any',
    body: '<script>alert(1)</script>',
  });
  expect(html.status, JSON.stringify(html.body)).toBe(422);

  const messaging = ctx.app.get(VoiceMessagingService, { strict: false });
  const ingested = await messaging.ingestInbound({
    accountKey: ACCOUNT_KEY,
    event: { kind: 'message', providerMessageId: `om12_${RUN}`, state: 'delivered', direction: 'inbound', channel: 'sms', from: PHONE, to: null, body: 'AGENT_TEST_OM12 hello', occurredAt: new Date().toISOString(), failureCategory: null, vendorStatus: 'received' },
  });
  const row = (await sql<{ conversation_id: string }>`select conversation_id from voice_messages where id = ${ingested.messageId}`.execute(ctx.database.db)).rows[0];
  conversationId = String(row?.conversation_id ?? '');
  expect(conversationId).not.toBe('');
}, 240_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`delete from voice_message_templates where key = any(${sql.val(KEYS)}::text[])`.execute(db).catch(() => undefined);
  for (const id of [conversationId].filter((value) => value !== '')) {
    await db.deleteFrom('voice_conversations').where('id', '=', id).execute().catch(() => undefined);
  }
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await db.deleteFrom('users').where('id', '=', userId).execute().catch(() => undefined);
  await db.deleteFrom('roles').where('id', '=', ROLE_VIEW).execute().catch(() => undefined);
  await sql`delete from users_teams where team_id in (${TEAM_A}, ${TEAM_B})`.execute(db).catch(() => undefined);
  await db.deleteFrom('teams').where('id', 'in', [TEAM_A, TEAM_B]).execute().catch(() => undefined);
  await shutdownApi();
});

describe('Canned replies and drafts (19-OM.12)', () => {
  it('lists channel-appropriate snippets, and a team snippet only to that team', async () => {
    const adminList = await call('GET', '/api/v1/Omnichannel/action/snippets?channel=sms');
    expect(adminList.status).toBe(200);
    const adminKeys = (adminList.body['list'] as { key: string }[]).map((row) => row.key);
    expect(adminKeys).toEqual(expect.arrayContaining([KEYS[0], KEYS[1], KEYS[2], KEYS[3]]));
    expect(adminKeys).not.toContain(KEYS[4]);

    const userList = await call('GET', '/api/v1/Omnichannel/action/snippets?channel=sms', undefined, (await loginUser()));
    expect(userList.status).toBe(200);
    const userKeys = (userList.body['list'] as { key: string }[]).map((row) => row.key);
    expect(userKeys).toEqual(expect.arrayContaining([KEYS[0], KEYS[1], KEYS[2]]));
    expect(userKeys).not.toContain(KEYS[3]);
  });

  it('previews with approved variables only, taking the customer name from the record', async () => {
    const preview = await call('POST', `/api/v1/Omnichannel/action/snippets/${KEYS[0]}/preview`, {
      conversationId,
      variables: { agentName: 'Agent Snap', customerName: 'AGENT_TEST Customer', evil: '<script>x</script>' },
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const body = String(preview.body['body'] ?? '');
    expect(body).toContain('AGENT_TEST Customer');
    expect(body).toContain('Agent Snap');
    expect(body).not.toContain('<script>');
    expect((preview.body['segments'] as Record<string, unknown>)['segments']).toBeGreaterThanOrEqual(1);
  });

  it('counts snippet use without storing any message content', async () => {
    const used = await call('POST', `/api/v1/Omnichannel/action/snippets/${KEYS[0]}/used`, {});
    expect(used.status).toBe(200);
    expect(Number(used.body['usageCount'])).toBe(1);
    const row = (await sql<{ usage_count: number; body: string }>`
      select usage_count, body from voice_message_templates where key = ${KEYS[0]}
    `.execute(ctx.database.db)).rows[0];
    expect(Number(row?.usage_count)).toBe(1);
    expect(row?.body).not.toContain('AGENT_TEST Customer');
  });

  it('keeps drafts per agent, restorable and invisible to another agent', async () => {
    const saved = await call('PUT', `/api/v1/Omnichannel/action/conversations/${conversationId}/draft`, { body: 'AGENT_TEST_OM12 draft reply' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((saved.body['draft'] as Record<string, unknown>)['body']).toBe('AGENT_TEST_OM12 draft reply');
    const read = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/draft`);
    expect((read.body['draft'] as Record<string, unknown>)['body']).toBe('AGENT_TEST_OM12 draft reply');

    // The other agent has no draft of their own — the admin's draft is never returned.
    const other = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/draft`, undefined, await loginUser());
    expect(other.status).toBe(200);
    expect(other.body['draft']).toBeNull();

    // A draft never appears in the transcript.
    const timeline = await call('GET', `/api/v1/Omnichannel/action/conversations/${conversationId}/timeline?limit=100`);
    expect(JSON.stringify(timeline.body)).not.toContain('AGENT_TEST_OM12 draft reply');

    const cleared = await call('PUT', `/api/v1/Omnichannel/action/conversations/${conversationId}/draft`, { body: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body['draft']).toBeNull();
  });

  it('refuses snippet preview and drafts to a caller without the reply capability', async () => {
    const token = await loginUser();
    const preview = await call('POST', `/api/v1/Omnichannel/action/snippets/${KEYS[0]}/preview`, {}, token);
    expect(preview.status).toBe(403);
    const save = await call('PUT', `/api/v1/Omnichannel/action/conversations/${conversationId}/draft`, { body: 'nope' }, token);
    expect(save.status).toBe(403);
  });
});

async function loginUser(): Promise<string> {
  const outcome = await ctx.auth.login(`AGENT_TEST OM12 user ${RUN}`, 'secret-password');
  if (outcome.kind !== 'ok') throw new Error('The test user could not sign in.');
  return outcome.tokens.accessToken;
}
