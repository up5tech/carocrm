import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CHAT.4 — conversation and message APIs
 * (`PLAN_Phase_19_CRM_Chat.md` §17 `19-CHAT.4`; contract §6.2, §7.6, §13).
 *
 * Acceptance: two users cannot read or mutate one another's private conversations; message history is
 * paginated and stable under concurrent inserts; repeated submissions with one idempotency key cannot
 * create two turns (the latter is the existing `uq_ai_agent_runs_idempotency` index, verified at 19-CHAT.5
 * when submission exists).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). This suite writes its own agent,
 * conversations and messages with the run marker, and removes exactly those rows by id in `afterAll`.
 * Nothing is truncated or reset, and no test database is created. No provider is called: conversation
 * reads never reach a model.
 */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface ConversationBody {
  readonly id: string;
  readonly title: string | null;
  readonly status: string;
  readonly messageCount: number;
  readonly lastMessageAt: string;
}

interface MessageBody {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly content: string;
  readonly contentFormat: string;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_chatconv_${runId}`;
const ROLE_FULL = `AGENT_TEST-chatconv-full-${runId}`;
const ROLE_READ = `AGENT_TEST-chatconv-read-${runId}`;
const USER_A = `AGENT_TEST-chatconv-a-${runId}`;
const USER_B = `AGENT_TEST-chatconv-b-${runId}`;
const USER_READ = `AGENT_TEST-chatconv-read-${runId}`;
const AGENT_ID = `${MARKER}-agent`;
const CONVERSATION_A1 = `${MARKER}-conv-a1`;
const CONVERSATION_A2 = `${MARKER}-conv-a2`;
const CONVERSATION_A3 = `${MARKER}-conv-a3`;
const CONVERSATION_B1 = `${MARKER}-conv-b1`;

let ctx: ApiContext;
let tokenA = '';
let tokenB = '';
let tokenRead = '';
const createdUserIds: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
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

function errorCode(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function listOf(body: Record<string, unknown>): ConversationBody[] {
  return (body['list'] ?? []) as ConversationBody[];
}

function ids(body: Record<string, unknown>): string[] {
  return listOf(body).map((entry) => entry.id);
}


beforeAll(async () => {
  ctx = await bootApi();
  const db = ctx.database.db;
  const now = new Date();

  await db
    .insertInto('ai_agents')
    .values({
      id: AGENT_ID,
      agent_key: `${MARKER}-agent-key`,
      name: `${MARKER} assistant`,
      description: null,
      purpose: null,
      category: null,
      icon: null,
      owner_user_id: null,
      team_id: null,
      visibility: 'organization',
      status: 'published',
      draft_config: JSON.stringify({}),
      current_version: 1,
      data_sensitivity: 'internal',
      is_deleted: false,
      created_at: now,
      modified_at: now,
      created_by_id: null,
      modified_by_id: null,
    })
    .execute();

  await createTestRole(ctx, {
    id: ROLE_FULL,
    name: `${MARKER} full chat role`,
    permissions: { CRMChatConversation: { read: 'all', edit: 'all', delete: 'all' } },
  });
  await createTestRole(ctx, {
    id: ROLE_READ,
    name: `${MARKER} read-only chat role`,
    permissions: { CRMChatConversation: { read: 'all' } },
  });

  const a = await createTestUser(ctx, { userName: USER_A, roleIds: [ROLE_FULL] });
  const b = await createTestUser(ctx, { userName: USER_B, roleIds: [ROLE_FULL] });
  const read = await createTestUser(ctx, { userName: USER_READ, roleIds: [ROLE_READ] });
  tokenA = a.token;
  tokenB = b.token;
  tokenRead = read.token;
  createdUserIds.push(a.id, b.id, read.id);

  const conversation = (id: string, owner: string, title: string, minutesAgo: number, status = 'active') => ({
    id,
    agent_id: AGENT_ID,
    owner_user_id: owner,
    title,
    status,
    related_entity: null,
    related_id: null,
    message_count: 0,
    summary: null,
    summary_message_count: 0,
    last_activity_at: new Date(now.getTime() - minutesAgo * 60_000),
    expires_at: null,
    created_at: new Date(now.getTime() - minutesAgo * 60_000),
    modified_at: new Date(now.getTime() - minutesAgo * 60_000),
  });
  await db
    .insertInto('ai_agent_conversations')
    .values([
      conversation(CONVERSATION_A1, a.id, `${MARKER} oldest A`, 30),
      conversation(CONVERSATION_A2, a.id, `${MARKER} middle A`, 20),
      conversation(CONVERSATION_A3, a.id, `${MARKER} newest A`, 10),
      conversation(CONVERSATION_B1, b.id, `${MARKER} B private`, 5),
    ])
    .execute();

  // Five messages on A1, so one page cannot contain them all. `seq` is the keyset cursor.
  const messages = [1, 2, 3, 4, 5].map((seq) => ({
    id: `${MARKER}-msg-${String(seq)}`,
    conversation_id: CONVERSATION_A1,
    run_id: null,
    seq,
    role: seq % 2 === 1 ? 'user' : 'assistant',
    content: `${MARKER} message ${String(seq)}`,
    content_meta: JSON.stringify({}),
    redaction: 'none',
    token_count: 4,
    created_at: new Date(now.getTime() - (6 - seq) * 60_000),
  }));
  await db.insertInto('ai_agent_messages').values(messages).execute();
  await db
    .updateTable('ai_agent_conversations')
    .set({ message_count: 5 })
    .where('id', '=', CONVERSATION_A1)
    .execute();
});

afterAll(async () => {
  const db = ctx.database.db;
  await db.deleteFrom('ai_agent_messages').where('conversation_id', '=', CONVERSATION_A1).execute();
  await db
    .deleteFrom('ai_agent_conversations')
    .where('id', 'in', [CONVERSATION_A1, CONVERSATION_A2, CONVERSATION_A3, CONVERSATION_B1])
    .execute();
  await db.deleteFrom('ai_agents').where('id', '=', AGENT_ID).execute();
  if (createdUserIds.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  }
  await db.deleteFrom('roles').where('id', 'in', [ROLE_FULL, ROLE_READ]).execute();
  await shutdownApi();
});

describe('CRMChat conversations (19-CHAT.4)', () => {
  it('lists only the caller’s own threads, newest activity first', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/conversations', tokenA);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(ids(result.body)).toEqual([CONVERSATION_A3, CONVERSATION_A2, CONVERSATION_A1]);
    expect(result.body['total']).toBe(3);
    expect(result.body['count']).toBe(3);
    expect(result.body['offset']).toBe(0);

    // The other owner sees only theirs; `status=all` is not a way to widen the scope.
    const b = await call('GET', '/api/v1/CRMChat/action/conversations?status=all', tokenB);
    expect(ids(b.body)).toEqual([CONVERSATION_B1]);
    expect(b.body['total']).toBe(1);
  });

  it('pages the list without repeating or skipping a row', async () => {
    const first = await call('GET', '/api/v1/CRMChat/action/conversations?offset=0&maxSize=2', tokenA);
    const second = await call('GET', '/api/v1/CRMChat/action/conversations?offset=2&maxSize=2', tokenA);
    expect(ids(first.body)).toEqual([CONVERSATION_A3, CONVERSATION_A2]);
    expect(ids(second.body)).toEqual([CONVERSATION_A1]);
    expect(first.body['total']).toBe(3);
    expect(second.body['total']).toBe(3);
  });

  it('hides another user’s conversation behind 404 on every route', async () => {
    const base = `/api/v1/CRMChat/action/conversations/${CONVERSATION_B1}`;
    const read = await call('GET', base, tokenA);
    expect(read.status).toBe(404);
    expect(errorCode(read)).toBe('NOT_FOUND');

    const messages = await call('GET', `${base}/messages`, tokenA);
    expect(messages.status).toBe(404);

    const rename = await call('PATCH', base, tokenA, { title: `${MARKER} hijacked` });
    expect(rename.status).toBe(404);

    const remove = await call('DELETE', base, tokenA);
    expect(remove.status).toBe(404);

    // Still owned and untouched by its real owner.
    const b = await call('GET', base, tokenB);
    expect(b.status).toBe(200);
    expect((b.body['conversation'] as ConversationBody).title).toBe(`${MARKER} B private`);
  });

  it('returns the conversation with its newest page of messages, in read order', async () => {
    const result = await call('GET', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}?`, tokenA);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const conversation = result.body['conversation'] as ConversationBody;
    expect(conversation.id).toBe(CONVERSATION_A1);
    expect(conversation.messageCount).toBe(5);

    const page = result.body['messages'] as { list: MessageBody[]; nextBefore: number | null; hasMore: boolean };
    // All five fit in the default page, and they are ordered as a reader reads them.
    expect(page.list.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(page.hasMore).toBe(false);
    expect(page.nextBefore).toBeNull();
    expect(page.list[0]?.contentFormat).toBe('plain');
    expect(page.list[0]?.role).toBe('user');
    expect(page.list[1]?.role).toBe('assistant');
  });

  it('walks the history by keyset cursor and visits every message exactly once', async () => {
    const first = await call('GET', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}/messages?maxSize=2`, tokenA);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstPage = first.body as { list: MessageBody[]; nextBefore: number | null; hasMore: boolean };
    expect(firstPage.list.map((m) => m.sequence)).toEqual([4, 5]);

    const second = await call(
      'GET',
      `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}/messages?maxSize=2&before=4`,
      tokenA,
    );
    const secondPage = second.body as { list: MessageBody[]; nextBefore: number | null; hasMore: boolean };
    expect(secondPage.list.map((m) => m.sequence)).toEqual([2, 3]);

    const third = await call(
      'GET',
      `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}/messages?maxSize=2&before=2`,
      tokenA,
    );
    const thirdPage = third.body as { list: MessageBody[]; nextBefore: number | null; hasMore: boolean };
    expect(thirdPage.list.map((m) => m.sequence)).toEqual([1]);
    expect(thirdPage.hasMore).toBe(false);
    expect(thirdPage.nextBefore).toBeNull();

    const seen = [...firstPage.list, ...secondPage.list, ...thirdPage.list].map((m) => m.sequence);
    expect(new Set(seen).size).toBe(5);
    expect(seen.length).toBe(5);
  });

  it('renames, archives and reopens a conversation it owns', async () => {
    const renamed = await call('PATCH', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A2}`, tokenA, {
      title: `  ${MARKER} renamed  `,
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((renamed.body as unknown as ConversationBody).title).toBe(`${MARKER} renamed`);

    const archived = await call('PATCH', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A2}`, tokenA, {
      status: 'archived',
    });
    expect((archived.body as unknown as ConversationBody).status).toBe('archived');

    // Archived threads leave the default list, remain reachable when asked for, and come back.
    const active = await call('GET', '/api/v1/CRMChat/action/conversations', tokenA);
    expect(ids(active.body)).not.toContain(CONVERSATION_A2);
    const archivedList = await call('GET', '/api/v1/CRMChat/action/conversations?status=archived', tokenA);
    expect(ids(archivedList.body)).toContain(CONVERSATION_A2);

    const reopened = await call('PATCH', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A2}`, tokenA, {
      status: 'active',
    });
    expect((reopened.body as unknown as ConversationBody).status).toBe('active');
    expect(ids((await call('GET', '/api/v1/CRMChat/action/conversations', tokenA)).body)).toContain(CONVERSATION_A2);
  });

  it('marks a deleted conversation invisible without removing the row', async () => {
    const removed = await call('DELETE', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A3}`, tokenA);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body['status']).toBe(true);

    expect((await call('GET', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A3}`, tokenA)).status).toBe(404);
    expect(ids((await call('GET', '/api/v1/CRMChat/action/conversations?status=all', tokenA)).body)).not.toContain(
      CONVERSATION_A3,
    );

    // The row survives for the AI Agents retention sweep; Chat never runs a destructive delete.
    const row = await ctx.database.db
      .selectFrom('ai_agent_conversations')
      .select(['status'])
      .where('id', '=', CONVERSATION_A3)
      .executeTakeFirst();
    expect(row?.status).toBe('deleted');
  });

  it('refuses mutations to a caller who only holds the read right', async () => {
    const list = await call('GET', '/api/v1/CRMChat/action/conversations', tokenRead);
    expect(list.status).toBe(200);
    expect(ids(list.body)).toEqual([]);

    // The capability is decided before the row is touched, so this is 403 and reveals nothing about
    // whether the id exists. (A capable non-owner gets 404 — covered above.)
    const rename = await call('PATCH', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}`, tokenRead, {
      title: `${MARKER} not mine`,
    });
    expect(rename.status).toBe(403);
    expect(errorCode(rename)).toBe('AUTHORIZATION_DENIED');

    const remove = await call('DELETE', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}`, tokenRead);
    expect(remove.status).toBe(403);

    // Nothing changed for the owner.
    const owner = await call('GET', `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}`, tokenA);
    expect((owner.body['conversation'] as ConversationBody).title).toBe(`${MARKER} oldest A`);
  });

  it('relies on the database, not an application cache, for turn idempotency', async () => {
    // 19-CHAT.3 acceptance: concurrent duplicate submissions cannot create two turns. The guarantee is
    // the partial unique index from migration 045, which survives a restart and a second API instance.
    const rows = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where indexname = 'uq_ai_agent_runs_idempotency'
    `.execute(ctx.database.db);
    expect(rows.rows.length).toBe(1);
    const definition = rows.rows[0]?.indexdef ?? '';
    expect(definition).toContain('UNIQUE INDEX');
    expect(definition).toContain('idempotency_key');
    expect(definition).toContain('WHERE (idempotency_key IS NOT NULL)');
  });

  it('rejects malformed paging, unknown filters and a bad title', async () => {
    const conversation = `/api/v1/CRMChat/action/conversations/${CONVERSATION_A1}`;

    const tooLarge = await call('GET', `/api/v1/CRMChat/action/conversations?maxSize=0`, tokenA);
    expect(tooLarge.status).toBe(400);
    expect(errorCode(tooLarge)).toBe('INVALID_QUERY');

    // `q` is the 19-CHAT.14 search field and its flag is off by default (contract §7.4), so asking
    // for a search while the flag is off is refused rather than silently answered unfiltered.
    const searchDisabled = await call('GET', `/api/v1/CRMChat/action/conversations?q=oldest`, tokenA);
    expect(searchDisabled.status).toBe(403);
    expect(errorCode(searchDisabled)).toBe('FEATURE_DISABLED');

    const badBefore = await call('GET', `${conversation}/messages?before=0`, tokenA);
    expect(badBefore.status).toBe(400);

    const emptyTitle = await call('PATCH', conversation, tokenA, { title: '   ' });
    expect(emptyTitle.status).toBe(400);

    const longTitle = await call('PATCH', conversation, tokenA, { title: 'x'.repeat(201) });
    expect(longTitle.status).toBe(400);

    const wrongType = await call('PATCH', conversation, tokenA, { title: 42 });
    expect(wrongType.status).toBe(400);

    const badStatus = await call('PATCH', conversation, tokenA, { status: 'deleted' });
    expect(badStatus.status).toBe(400);

    // A refused patch changed nothing.
    const after = await call('GET', conversation, tokenA);
    expect((after.body['conversation'] as ConversationBody).title).toBe(`${MARKER} oldest A`);
  });

  it('searches only the caller’s own threads when the search flag is on', async () => {
    // The flag ships off (contract §7.4), so the test turns it on and puts it back afterwards.
    // The settings row is Chat's own single row; it is snapshotted here and restored in `afterAll`.
    const previous = await ctx.database.db
      .selectFrom('app_settings')
      .select(['data'])
      .where('name', '=', 'crmChat')
      .executeTakeFirst();

    const enabled = await call(
      'POST',
      '/api/v1/CRMChat/action/settings',
      ctx.adminToken,
      { features: { conversationSearch: true } },
    );
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

    try {
      // A's own thread is found by a term in its title.
      const found = await call('GET', `/api/v1/CRMChat/action/conversations?q=${encodeURIComponent('oldest')}`, tokenA);
      expect(found.status, JSON.stringify(found.body)).toBe(200);
      expect(ids(found.body)).toContain(CONVERSATION_A1);

      // The same term never reaches the other user's thread: B searches for A's title word and
      // gets nothing, because the search is scoped to the caller's own rows in SQL.
      const otherUser = await call(
        'GET',
        `/api/v1/CRMChat/action/conversations?q=${encodeURIComponent('oldest')}`,
        tokenB,
      );
      expect(otherUser.status).toBe(200);
      expect(ids(otherUser.body)).not.toContain(CONVERSATION_A1);
      expect(ids(otherUser.body)).toEqual([]);

      // B still finds B's own thread by a word in its own title.
      const ownThread = await call(
        'GET',
        `/api/v1/CRMChat/action/conversations?q=${encodeURIComponent('private')}`,
        tokenB,
      );
      expect(ownThread.status).toBe(200);
      expect(ids(ownThread.body)).toEqual([CONVERSATION_B1]);

      // A term that matches nothing is an empty list, not the whole history.
      const noMatch = await call(
        'GET',
        `/api/v1/CRMChat/action/conversations?q=${encodeURIComponent(`${MARKER}-nothing-matches`)}`,
        tokenA,
      );
      expect(noMatch.status).toBe(200);
      expect(ids(noMatch.body)).toEqual([]);

      // A term that is only in a message body is found too — the search covers thread content.
      // Only A1 carries messages, and none of the other titles contain the word.
      const byMessage = await call(
        'GET',
        `/api/v1/CRMChat/action/conversations?q=${encodeURIComponent(`${MARKER} message 3`)}`,
        tokenA,
      );
      expect(byMessage.status).toBe(200);
      expect(ids(byMessage.body)).toEqual([CONVERSATION_A1]);
    } finally {
      if (previous === undefined) {
        await ctx.database.db.deleteFrom('app_settings').where('name', '=', 'crmChat').execute();
      } else {
        await ctx.database.db
          .updateTable('app_settings')
          .set({ data: previous.data })
          .where('name', '=', 'crmChat')
          .execute();
      }
    }
  });
});
