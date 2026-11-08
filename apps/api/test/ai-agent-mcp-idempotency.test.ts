import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-AI.23 — MCP direct-call idempotency
 * (`plans/PLAN_Phase_19_AI_Agents.md` §24, `19-AI.23`).
 *
 * `POST /api/v1/AIAgents/action/mcp/call` runs a tool with no run behind it, so the run pipeline's
 * tool-call dedup cannot apply. The dedicated receipt must make a replayed `low_write` call return
 * the original tool-call id and result without duplicating the effect, refuse a key reused with
 * different arguments, and leave read tools and the approval gate untouched.
 *
 * Runs against the configured primary database (AGENTS.md §3.1); every row carries the run marker
 * and is removed by exact id in `afterAll`.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';

type Method = 'POST';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_mcp_${runId}`;

let ctx: ApiContext;
let accountId = '';
const streamItemIds: string[] = [];
const receiptKeys: string[] = [];

async function call(method: Method, url: string, token: string | undefined, payload?: unknown): Promise<CallResult> {
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

function mcpCall(payload: Record<string, unknown>, token = ctx.adminToken): Promise<CallResult> {
  return call('POST', '/api/v1/AIAgents/action/mcp/call', token, payload);
}

function noteArgs(text: string): Record<string, unknown> {
  return { entity: 'Account', id: accountId, text };
}

async function countMarkerNotes(): Promise<number> {
  const rows = await ctx.database.db
    .selectFrom('stream_items')
    .select('id')
    .where('entity_id', '=', accountId)
    .where('entity_type', '=', 'Account')
    .where('post', 'like', `${MARKER}%`)
    .execute();
  streamItemIds.push(...rows.map((row) => row.id));
  return rows.length;
}

beforeAll(async () => {
  ctx = await bootApi();
  const created = await call('POST', '/api/v1/Account', ctx.adminToken, { name: `${MARKER} account` });
  expect(created.status).toBe(201);
  accountId = String(created.body['id']);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (receiptKeys.length > 0) {
    await db
      .deleteFrom('ai_agent_mcp_direct_calls')
      .where('idempotency_key', 'in', receiptKeys)
      .execute();
  }
  if (streamItemIds.length > 0) {
    await db.deleteFrom('stream_items').where('id', 'in', streamItemIds).execute();
  }
  await db.deleteFrom('entity_links').where('record_id_a', '=', accountId).execute();
  await db.deleteFrom('entity_links').where('record_id_b', '=', accountId).execute();
  await db.deleteFrom('entity_records').where('id', '=', accountId).execute();
  await shutdownApi();
});

describe('MCP direct-call idempotency (19-AI.23)', () => {
  it('requires an idempotency key for a write-capable tool', async () => {
    const res = await mcpCall({ name: 'crm_post_note', arguments: noteArgs(`${MARKER} no key`) });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('AI_IDEMPOTENCY_KEY_REQUIRED');
    expect(await countMarkerNotes()).toBe(0);
  });

  it('replays a low_write call with the same key without duplicating the effect', async () => {
    const key = `mcp-key-${runId}-replay`;
    receiptKeys.push(key);
    const args = noteArgs(`${MARKER} replayed note`);

    const first = await mcpCall({ name: 'crm_post_note', arguments: args, idempotencyKey: key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstCallId = String(first.body['toolCallId'] ?? '');
    expect(firstCallId).not.toBe('');

    const replay = await mcpCall({ name: 'crm_post_note', arguments: args, idempotencyKey: key });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body['toolCallId']).toBe(firstCallId);
    // The replayed payload is the stored result verbatim — same stream item, not a new note.
    // (jsonb normalizes key order, so compare the parsed payload, not the raw text.)
    const payloadJson = (body: Record<string, unknown>) =>
      JSON.parse(
        String(((body['content'] as { text?: string }[] | undefined) ?? [])[0]?.text ?? '{}'),
      ) as Record<string, unknown>;
    expect(payloadJson(replay.body)).toEqual(payloadJson(first.body));
    expect(payloadJson(replay.body)['streamItemId']).toBeDefined();

    // Exactly one note reached the record's timeline.
    expect(await countMarkerNotes()).toBe(1);
  });

  it('refuses a key reused with different arguments', async () => {
    const key = `mcp-key-${runId}-conflict`;
    receiptKeys.push(key);
    const first = await mcpCall({
      name: 'crm_post_note',
      arguments: noteArgs(`${MARKER} conflict a`),
      idempotencyKey: key,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const conflict = await mcpCall({
      name: 'crm_post_note',
      arguments: noteArgs(`${MARKER} conflict b`),
      idempotencyKey: key,
    });
    expect(conflict.status).toBe(422);
    expect(JSON.stringify(conflict.body)).toContain('AI_IDEMPOTENCY_CONFLICT');
    expect(await countMarkerNotes()).toBe(2); // only the two legitimately different notes
  });

  it('still executes once more under a different key', async () => {
    const keyA = `mcp-key-${runId}-distinct-a`;
    const keyB = `mcp-key-${runId}-distinct-b`;
    receiptKeys.push(keyA, keyB);
    const args = noteArgs(`${MARKER} distinct`);

    const a = await mcpCall({ name: 'crm_post_note', arguments: args, idempotencyKey: keyA });
    const b = await mcpCall({ name: 'crm_post_note', arguments: args, idempotencyKey: keyB });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body['toolCallId']).not.toBe(a.body['toolCallId']);
    // replayed(1) + conflict-a(1) + distinct(2) marker notes on the record.
    expect(await countMarkerNotes()).toBe(4);
  });

  it('keeps read tools working without a key and the approval gate unchanged', async () => {
    const read = await mcpCall({
      name: 'crm_read_record',
      arguments: { entity: 'Account', id: accountId },
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(JSON.stringify(read.body)).toContain(accountId);

    const gated = await mcpCall({
      name: 'crm_update_record_fields',
      arguments: { entity: 'Account', id: accountId, fields: { name: `${MARKER} gated` } },
      idempotencyKey: `mcp-key-${runId}-gated`,
    });
    expect(gated.status).toBe(422);
    expect(JSON.stringify(gated.body)).toContain('AI_TOOL_APPROVAL_REQUIRED');
    receiptKeys.push(`mcp-key-${runId}-gated`);
  });
});
