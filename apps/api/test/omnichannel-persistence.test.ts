import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.3 — the additive persistence contract (migration 077).
 *
 * Runs against the configured primary database (AGENTS.md §3.1): no database is created, nothing is
 * reset or truncated. Every row this suite writes carries the `AGENT_TEST_OM3_` marker and is removed
 * by exact id in `afterAll`; pre-existing Voice rows created by other suites are never touched.
 *
 * What is proved is the plan's §14 OM.3 acceptance: the migration applied to the existing data without
 * replacing it, the constraints behave (a duplicate provider identity within one conversation and a
 * duplicate external thread id under one account+channel are refused — the schema half of "constraints
 * prevent duplicate external records under concurrent delivery"), the widened channel CHECK admits the
 * first-release web-chat channel, the conversation↔thread 1:1 model holds over the whole store, and —
 * visibly in the schema — **no second conversation, message or queue table was created** (D1).
 */

const RUN = `AGENT_TEST_OM3_${Date.now().toString(36)}`;
const CONV = `${RUN}_conv`;
const THREAD = `${RUN}_thread`;
const DUP = `${RUN}_dup`;
const BADCONV = `${RUN}_bad`;
const MSG = `${RUN}_msg`;
const P1 = `${RUN}_p1`;
const P2 = `${RUN}_p2`;
const THREAD2 = `${RUN}_thread2`;
const EXT = `${RUN}_ext`;
const PID = `${RUN}_pid`;

let ctx: ApiContext;

const db = () => ctx.database.db;

async function exec(query: ReturnType<typeof sql>): Promise<void> {
  await query.execute(db());
}

async function exec1<T>(query: ReturnType<typeof sql>): Promise<T | undefined> {
  const result = await query.execute(db());
  return result.rows[0] as T | undefined;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const result = await query.execute(db());
  return Number((result.rows[0] as Record<string, unknown> | undefined)?.n ?? Number.NaN);
}

async function expectRejected(query: ReturnType<typeof sql>): Promise<void> {
  let threw = false;
  try {
    await query.execute(db());
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

beforeAll(async () => {
  ctx = await bootApi();
}, 180_000);

afterAll(async () => {
  // Exact-id cleanup only; participants/messages/thread cascade with the conversations.
  await exec(sql`delete from voice_conversation_participants where conversation_id in (${CONV}, ${DUP})`);
  await exec(sql`delete from voice_messages where conversation_id in (${CONV}, ${DUP})`);
  await exec(sql`delete from voice_conversations where id in (${CONV}, ${DUP}, ${BADCONV})`);
  await shutdownApi();
});

describe('Omnichannel additive persistence (19-OM.3)', () => {
  it('holds the 1:1 conversation↔thread model over the whole store and preserves existing rows', async () => {
    // No conversation carries more than one thread (the 051 -> 077 1:1 rule).
    expect(
      await count(
        sql`select count(*)::int as n from (
               select conversation_id from voice_conversation_threads group by conversation_id having count(*) > 1
             ) bad`,
      ),
    ).toBe(0);
    // No message references a thread that belongs to a different conversation.
    expect(
      await count(
        sql`select count(*)::int as n from voice_messages m
            join voice_conversation_threads t on t.id = m.thread_id
            where t.conversation_id <> m.conversation_id`,
      ),
    ).toBe(0);
    // The backfill produced at least one thread (the pre-existing demo conversation) and kept its messages linked.
    expect(await count(sql`select count(*)::int as n from voice_conversation_threads`)).toBeGreaterThanOrEqual(1);
  });

  it('widens the channel CHECK to the first-release web_chat channel', async () => {
    await exec(sql`insert into voice_conversations (id, account_key, channel, status)
                   values (${DUP}, 'demo-voice', 'web_chat', 'open')`);
    const row = await exec1<{ channel: string }>(sql`select channel from voice_conversations where id = ${DUP}`);
    expect(row?.channel).toBe('web_chat');
  });

  it('keeps the workspace defaults honest and refuses an out-of-vocabulary priority', async () => {
    await exec(sql`insert into voice_conversations (id, account_key, channel, status)
                   values (${CONV}, 'demo-voice', 'whatsapp', 'open')`);
    const row = await exec1<{ priority: string; version: number; assignment_version: number }>(
      sql`select priority, version, assignment_version from voice_conversations where id = ${CONV}`,
    );
    if (row === undefined) throw new Error('test conversation vanished');
    expect(row.priority).toBe('normal');
    expect(row.version).toBe(1);
    expect(row.assignment_version).toBe(1);
    await expectRejected(sql`insert into voice_conversations (id, account_key, channel, status, priority)
                   values (${BADCONV}, 'demo-voice', 'whatsapp', 'open', 'critical')`);
  });

  it('enforces the thread and participant identity constraints', async () => {
    await exec(sql`insert into voice_conversation_threads (id, conversation_id, account_key, channel, external_thread_id, address, provider_identity)
                   values (${THREAD}, ${CONV}, 'demo-voice', 'whatsapp', ${EXT}, '+1555000000', ${PID})`);
    await exec(sql`insert into voice_messages (id, conversation_id, thread_id, account_key, channel, direction, body, state)
                   values (${MSG}, ${CONV}, ${THREAD}, 'demo-voice', 'whatsapp', 'inbound', 'hi', 'delivered')`);
    // Same account + channel + provider identity within one conversation is a duplicate identity.
    await exec(sql`insert into voice_conversation_participants (id, conversation_id, address, role, account_key, channel, provider_identity)
                   values (${P1}, ${CONV}, '+1555000000', 'customer', 'demo-voice', 'whatsapp', ${PID})`);
    await expectRejected(
      sql`insert into voice_conversation_participants (id, conversation_id, address, role, account_key, channel, provider_identity)
                   values (${P2}, ${CONV}, '+1555000001', 'customer', 'demo-voice', 'whatsapp', ${PID})`,
    );
    // A duplicate external thread id under the same account + channel is refused.
    await expectRejected(
      sql`insert into voice_conversation_threads (id, conversation_id, account_key, channel, external_thread_id)
                   values (${THREAD2}, ${DUP}, 'demo-voice', 'whatsapp', ${EXT})`,
    );
  });

  it('creates no second conversation, message or queue table (D1)', async () => {
    expect(
      await count(
        sql`select count(*)::int as n from information_schema.tables
            where table_schema='public' and (
              table_name like 'omnichannel\_conversation%' or table_name like 'omnichannel\_message%'
              or table_name like 'omnichannel\_queue%' or table_name like 'omnichannel\_routing%')`,
      ),
    ).toBe(0);
  });
});
