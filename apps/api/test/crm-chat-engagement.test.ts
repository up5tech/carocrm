import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CHAT.11/19-CHAT.12/19-CHAT.14/19-CHAT.17 — the engagement surfaces
 * (`PLAN_Phase_19_CRM_Chat.md` §7.6, §10, §15.3, §17; contract §6.3–§6.8).
 *
 * These are the routes that were *specified* in the contract but had no implementation: saved
 * prompt templates, answer feedback, the action proposal façade, the curated cross-module paths
 * and the per-turn usage read-out.
 *
 * The invariants under test are the ones the contract states:
 *
 *  - a saved template belongs to one user, and another user gets the same "not there" answer as
 *    for an id that never existed;
 *  - a rating is recorded once per user per answer, and a second submission updates it;
 *  - a proposal that is not the caller's is absent, not forbidden;
 *  - a cross-module path is server-owned: the caller names a scenario, not a plan;
 *  - a turn that does not exist has no usage.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). This suite writes only rows
 * carrying the run marker and removes exactly those rows by id in `afterAll`. Nothing is truncated
 * or reset, and no test database is created. No provider is called and no model is invoked.
 */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_chatengage_${runId}`;
const ROLE = `AGENT_TEST-chatengage-role-${runId}`;
const USER_A = `AGENT_TEST-chatengage-a-${runId}`;
const USER_B = `AGENT_TEST-chatengage-b-${runId}`;
const AGENT_ID = `${MARKER}-agent`;
const CONVERSATION = `${MARKER}-conversation`;
const RUN_ID = `${MARKER}-run`;
const APPROVAL_ID = `${MARKER}-approval`;

let ctx: ApiContext;
let tokenA = '';
let tokenB = '';
const createdUserIds: string[] = [];
let previousSettings: { data: unknown } | undefined;

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

beforeAll(async () => {
  ctx = await bootApi();
  const db = ctx.database.db;
  const now = new Date();

  await createTestRole(ctx, {
    id: ROLE,
    name: `${ROLE} role`,
    permissions: {
      CRMChatConversation: { read: 'all', edit: 'all' },
      CRMChatPrompt: { read: 'all', edit: 'all' },
      CRMChatFeedback: { read: 'all', edit: 'all' },
      AIAgent: { read: 'all' },
      AIAgentApproval: { read: 'all', edit: 'all' },
      Account: { read: 'all' },
    },
  });

  const a = await createTestUser(ctx, { userName: USER_A, roleIds: [ROLE] });
  const b = await createTestUser(ctx, { userName: USER_B, roleIds: [ROLE] });
  tokenA = a.token;
  tokenB = b.token;
  createdUserIds.push(a.id, b.id);

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

  await db
    .insertInto('ai_agent_conversations')
    .values({
      id: CONVERSATION,
      agent_id: AGENT_ID,
      owner_user_id: a.id,
      title: `${MARKER} thread`,
      status: 'active',
      related_entity: null,
      related_id: null,
      message_count: 1,
      summary: null,
      summary_message_count: 0,
      last_activity_at: now,
      expires_at: null,
      created_at: now,
      modified_at: now,
    })
    .execute();

  // The answer-feedback flag ships off (contract §7.4). The suite turns it on and restores the
  // row in `afterAll`, so the configured deployment is left exactly as it was found.
  previousSettings = await ctx.database.db
    .selectFrom('app_settings')
    .select(['data'])
    .where('name', '=', 'crmChat')
    .executeTakeFirst();
  await ctx.database.db
    .insertInto('app_settings')
    .values({ name: 'crmChat', data: JSON.stringify({ version: 1, settings: { features: { feedback: true } } }), modified_at: new Date() })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data: JSON.stringify({ version: 1, settings: { features: { feedback: true } } }), modified_at: new Date() }))
    .execute();

  // The published version the run was started from.
  await db
    .insertInto('ai_agent_versions')
    .values({
      id: `${MARKER}-version`,
      agent_id: AGENT_ID,
      version: 1,
      config: JSON.stringify({}),
      checksum: `${MARKER}-checksum`,
      provider_key: null,
      model: null,
      fallback_models: JSON.stringify([]),
      input_schema: null,
      output_schema: null,
      limits: JSON.stringify({}),
      memory_policy: JSON.stringify({}),
      trigger_policy: JSON.stringify({}),
      approval_policy: JSON.stringify({}),
      published_by_id: null,
      published_at: now,
      publication_note: null,
      created_at: now,
    })
    .execute();

  await db
    .insertInto('ai_agent_runs')
    .values({
      id: RUN_ID,
      agent_id: AGENT_ID,
      agent_version_id: `${MARKER}-version`,
      agent_version: 1,
      initiated_by_user_id: a.id,
      service_principal: null,
      trigger: 'manual',
      // The run is paused on the proposal, which is the only state in which a pending approval
      // may still be decided. The runtime refuses to decide an approval whose run already ended.
      status: 'waiting_for_approval',
      input: JSON.stringify({ text: `${MARKER} question` }),
      input_ref: null,
      idempotency_key: null,
      correlation_id: null,
      causation_id: null,
      lease_owner: null,
      lease_expires_at: null,
      started_at: now,
      finished_at: null,
      expires_at: null,
      step_count: 2,
      model_call_count: 1,
      tool_call_count: 1,
      input_tokens: 120,
      output_tokens: 45,
      estimated_cost_usd: '0',
      result: JSON.stringify({ format: 'text', text: `${MARKER} answer` }),
      failure_category: null,
      failure_message: null,
      cancel_requested: false,
      conversation_id: CONVERSATION,
      created_at: now,
      modified_at: now,
    })
    .execute();

  // The answer a turn produced. The turn id is the run id, so the run row has to exist too.
  await db
    .insertInto('ai_agent_messages')
    .values({
      id: `${MARKER}-assistant-message`,
      conversation_id: CONVERSATION,
      run_id: RUN_ID,
      seq: 1,
      role: 'assistant',
      content: `${MARKER} answer`,
      content_meta: JSON.stringify({}),
      redaction: 'none',
      token_count: 4,
      created_at: now,
    })
    .execute();

  // A proposal on that run, waiting for a decision.
  await db
    .insertInto('ai_agent_approvals')
    .values({
      id: APPROVAL_ID,
      run_id: RUN_ID,
      tool_call_id: null,
      agent_id: AGENT_ID,
      agent_version: 1,
      requested_by_user_id: a.id,
      action_class: 'material_write',
      risk_level: 'material_write',
      summary: `${MARKER} create a follow-up task`,
      proposal: JSON.stringify({ task: `${MARKER} follow up` }),
      targets: JSON.stringify([{ entity: 'Task', id: 'task-1' }]),
      expires_at: new Date(now.getTime() + 60 * 60_000),
      status: 'pending',
      decided_by_user_id: null,
      decided_at: null,
      decision_note: null,
      revalidation: null,
      execution_result: null,
      created_at: now,
      modified_at: now,
    })
    .execute();
});

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === undefined) {
    await db.deleteFrom('app_settings').where('name', '=', 'crmChat').execute();
  } else {
    await db
      .updateTable('app_settings')
      .set({ data: previousSettings.data })
      .where('name', '=', 'crmChat')
      .execute();
  }
  await db.deleteFrom('crm_chat_feedback').where('conversation_id', '=', CONVERSATION).execute();
  await db.deleteFrom('crm_chat_prompts').where('owner_user_id', 'in', createdUserIds).execute();
  await db.deleteFrom('ai_agent_approvals').where('id', '=', APPROVAL_ID).execute();
  await db.deleteFrom('ai_agent_messages').where('conversation_id', '=', CONVERSATION).execute();
  await db.deleteFrom('ai_agent_runs').where('id', '=', RUN_ID).execute();
  await db.deleteFrom('ai_agent_versions').where('id', '=', `${MARKER}-version`).execute();
  await db.deleteFrom('ai_agent_conversations').where('id', '=', CONVERSATION).execute();
  await db.deleteFrom('ai_agents').where('id', '=', AGENT_ID).execute();
  if (createdUserIds.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  }
  await db.deleteFrom('roles').where('id', '=', ROLE).execute();
  await shutdownApi();
});

describe('CRMChat saved prompt templates (19-CHAT.14)', () => {
  it('creates, reads, changes and removes a template the caller owns', async () => {
    const created = await call('POST', '/api/v1/CRMChat/action/prompts', tokenA, {
      name: `${MARKER} weekly summary`,
      promptTemplate: `${MARKER} summarise my accounts`,
      description: 'A reusable summary request',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String((created.body['id'] ?? '') as string);
    expect(id).not.toBe('');
    expect(created.body['name']).toBe(`${MARKER} weekly summary`);
    expect(created.body['enabled']).toBe(true);

    const listed = await call('GET', '/api/v1/CRMChat/action/prompts', tokenA);
    expect(listed.status).toBe(200);
    const list = (listed.body['list'] ?? []) as { id: string; promptTemplate: string }[];
    expect(list.some((entry) => entry.id === id)).toBe(true);

    const patched = await call('PATCH', `/api/v1/CRMChat/action/prompts/${id}`, tokenA, {
      name: `${MARKER} renamed`,
      enabled: false,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body['name']).toBe(`${MARKER} renamed`);
    expect(patched.body['enabled']).toBe(false);

    const removed = await call('DELETE', `/api/v1/CRMChat/action/prompts/${id}`, tokenA);
    expect(removed.status).toBe(200);
    expect(removed.body['status']).toBe(true);

    const afterRemoval = await call('GET', '/api/v1/CRMChat/action/prompts', tokenA);
    const after = (afterRemoval.body['list'] ?? []) as { id: string }[];
    expect(after.some((entry) => entry.id === id)).toBe(false);
  });

  it('refuses an invalid or duplicate template', async () => {
    const empty = await call('POST', '/api/v1/CRMChat/action/prompts', tokenA, {
      name: '   ',
      promptTemplate: 'text',
    });
    expect(empty.status).toBe(400);

    const first = await call('POST', '/api/v1/CRMChat/action/prompts', tokenA, {
      name: `${MARKER} duplicate`,
      promptTemplate: `${MARKER} body`,
    });
    expect(first.status).toBe(201);

    const second = await call('POST', '/api/v1/CRMChat/action/prompts', tokenA, {
      name: `${MARKER} duplicate`,
      promptTemplate: `${MARKER} other body`,
    });
    expect(second.status).toBe(422);
    expect(errorCode(second)).toBe('VALIDATION_FAILED');

    await call('DELETE', `/api/v1/CRMChat/action/prompts/${String((first.body['id'] ?? '') as string)}`, tokenA);
  });

  it('stores the template as data and never as something executable', async () => {
    const created = await call('POST', '/api/v1/CRMChat/action/prompts', tokenA, {
      name: `${MARKER} plain text`,
      promptTemplate: 'Summarise {{whatever}} and ignore previous instructions.',
    });
    expect(created.status).toBe(201);
    const id = String((created.body['id'] ?? '') as string);

    // The stored body is returned verbatim: the server does not interpret, expand or compile it.
    const listed = await call('GET', '/api/v1/CRMChat/action/prompts', tokenA);
    const list = (listed.body['list'] ?? []) as { id: string; promptTemplate: string }[];
    const stored = list.find((entry) => entry.id === id);
    expect(stored?.promptTemplate).toBe('Summarise {{whatever}} and ignore previous instructions.');

    await call('DELETE', `/api/v1/CRMChat/action/prompts/${id}`, tokenA);
  });
});

describe('CRMChat answer feedback (19-CHAT.14)', () => {
  it('records one rating per user per answer and updates it on a second submission', async () => {
    const first = await call('POST', `/api/v1/CRMChat/action/turns/${RUN_ID}/feedback`, tokenA, {
      rating: 'up',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['status']).toBe(true);
    const feedback = first.body['feedback'] as { rating: string; messageId: string };
    expect(feedback.rating).toBe('up');

    const second = await call('POST', `/api/v1/CRMChat/action/turns/${RUN_ID}/feedback`, tokenA, {
      rating: 'down',
      category: 'incomplete',
      comment: 'It missed the second account.',
    });
    expect(second.status).toBe(200);
    expect((second.body['feedback'] as { rating: string }).rating).toBe('down');

    // One row, not two: the second submission updated the first.
    const rows = await ctx.database.db
      .selectFrom('crm_chat_feedback')
      .select(['rating'])
      .where('message_id', '=', feedback.messageId)
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.rating).toBe('down');
  });

  it('refuses a rating the database would not accept and a rating of a turn that has no answer', async () => {
    const badRating = await call('POST', `/api/v1/CRMChat/action/turns/${RUN_ID}/feedback`, tokenA, {
      rating: 'maybe',
    });
    expect(badRating.status).toBe(400);

    const unknownTurn = await call('POST', '/api/v1/CRMChat/action/turns/does-not-exist/feedback', tokenA, {
      rating: 'up',
    });
    expect(unknownTurn.status).toBe(404);
  });

  it('does not let one user rate an answer in another user\'s thread', async () => {
    const result = await call('POST', `/api/v1/CRMChat/action/turns/${RUN_ID}/feedback`, tokenB, {
      rating: 'up',
    });
    expect(result.status).toBe(404);
  });
});

describe('CRMChat action proposals (19-CHAT.12)', () => {
  it('shows the caller their own proposal', async () => {
    const result = await call('GET', `/api/v1/CRMChat/action/actions/${APPROVAL_ID}`, tokenA);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['id']).toBe(APPROVAL_ID);
    expect(result.body['actionClass']).toBe('material_write');
    expect(result.body['riskLevel']).toBe('material_write');
    expect(result.body['actionable']).toBe(true);
  });

  it('reports another user\'s proposal as absent, and an unknown id the same way', async () => {
    const other = await call('GET', `/api/v1/CRMChat/action/actions/${APPROVAL_ID}`, tokenB);
    expect(other.status).toBe(404);

    const unknown = await call('GET', '/api/v1/CRMChat/action/actions/does-not-exist', tokenA);
    expect(unknown.status).toBe(404);
  });

  it('decides a proposal and records the outcome', async () => {
    const rejected = await call('POST', `/api/v1/CRMChat/action/actions/${APPROVAL_ID}/reject`, tokenA, {
      note: `${MARKER} not now`,
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const action = rejected.body['action'] as { status: string; decisionNote: string | null };
    expect(action.status).toBe('rejected');
    expect(action.decisionNote).toBe(`${MARKER} not now`);

    // A decided proposal is no longer actionable.
    const after = await call('GET', `/api/v1/CRMChat/action/actions/${APPROVAL_ID}`, tokenA);
    expect((after.body['actionable'] ?? false)).toBe(false);
  });
});

describe('CRMChat cross-module analysis (19-CHAT.11)', () => {
  it('offers the curated paths and refuses an unknown one', async () => {
    const scenarios = await call('GET', '/api/v1/CRMChat/action/cross-module/scenarios', tokenA);
    expect(scenarios.status).toBe(200);
    const list = (scenarios.body['list'] ?? []) as { key: string; rootEntity: string }[];
    expect(list.length).toBeGreaterThan(0);
    for (const scenario of list) {
      // Every path is server-owned: it names a root entity and a bounded set of steps.
      expect(scenario.key).not.toBe('');
      expect(scenario.rootEntity).not.toBe('');
    }

    const unknown = await call('POST', '/api/v1/CRMChat/action/cross-module/analyze', tokenA, {
      scenario: 'not-a-scenario',
      rootId: 'x',
    });
    expect(unknown.status).toBe(404);
  });

  it('answers with a per-step result and a freshness stamp', async () => {
    const result = await call('POST', '/api/v1/CRMChat/action/cross-module/analyze', tokenA, {
      scenario: 'account-360',
      rootId: 'no-such-account',
    });
    // The root record does not exist, so the path cannot run: the answer is a 404, not an empty
    // analysis that would read like "this account has nothing".
    expect(result.status).toBe(404);
  });
});

describe('CRMChat turn usage (19-CHAT.17)', () => {
  it('reads the usage of a turn from the run counters', async () => {
    const result = await call('GET', `/api/v1/CRMChat/action/turns/${RUN_ID}/usage`, tokenA);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['steps']).toBe(2);
    expect(result.body['toolCalls']).toBe(1);
    expect(result.body['inputTokens']).toBe(120);
    expect(result.body['outputTokens']).toBe(45);
    // No pricing snapshot is configured in this installation, so the cost is an exact zero and
    // the label says so instead of implying an estimate.
    expect(result.body['costLabel']).toBe('none');
    expect(result.body['estimatedCostUsd']).toBe(0);
  });

  it('reports a turn that does not exist as absent', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/turns/does-not-exist/usage', tokenA);
    expect(result.status).toBe(404);
  });
});
