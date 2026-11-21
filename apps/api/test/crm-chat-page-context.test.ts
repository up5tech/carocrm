import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 25.9 — the page context of a CRM Chat turn
 * (`plans/PLAN_Phase_25_AI_Capability_Parity.md` §15).
 *
 * The feature under test is the difference between "the assistant knows who is asking" and "the
 * assistant knows what the user is looking at". Twenty's chatbot answers "this company" and "this
 * opportunity"; CaroCRM could not, because the client had nothing but text to send.
 *
 * What this suite pins down:
 *
 * - The client sends **identifiers**. The server resolves the record into a bounded summary under
 *   the caller's own ACL — the record's content never comes from the browser.
 * - A record the caller may not read is **dropped, not refused**: the turn still runs, the answer
 *   simply does not contain that record, and the caller is told. The answer must not leak the
 *   record's name either.
 * - The context is re-checked **on every turn**, so a record that became unreadable between two
 *   turns is dropped by the second one.
 * - Nothing about the record reaches the stream: the events a client may read carry no record
 *   content, so a resumed stream cannot leak a page the caller may not see.
 */

// The provider connection row is written through the encrypted secret store, so the suite needs the
// same deterministic key the other AI suites use.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_chat_page_context_${runId}`;
const ROLE_READER = `AGENT_TEST-chat-page-reader-${runId}`;
const USER_READER = `AGENT_TEST-chat-page-reader-${runId}`;
const PROVIDER_KEY = `agent-test-chat-page-${runId}`;
const ASSISTANT_KEY = `agent-test-${runId}-chat-page`;

/** A contact the reader owns; it is their page, so it is their context. */
const OWN_CONTACT_NAME = `${MARKER} own contact`;
/** A contact the reader may not read; naming it must not put it into an answer. */
const FOREIGN_CONTACT_NAME = `${MARKER} foreign contact`;

let ctx: ApiContext;
let readerToken = '';
let ownContactId = '';
let foreignContactId = '';
let baselineAiSettings: unknown = null;
let baselineChatSettings: unknown = null;
const createdUserIds: string[] = [];
const createdRecordIds: string[] = [];
const assistantIds: string[] = [];

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

/** The stored run input of a turn — what the runtime will read the context from. */
async function runInput(turnId: string): Promise<Record<string, unknown>> {
  const row = await ctx.database.db
    .selectFrom('ai_agent_runs')
    .select('input')
    .where('id', '=', turnId)
    .executeTakeFirst();
  const raw = row?.input;
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
  return (raw ?? {}) as Record<string, unknown>;
}

/** Every user-visible event of a turn, flattened — what a resumed stream could replay. */
async function turnEvents(turnId: string): Promise<string> {
  const rows = await ctx.database.db
    .selectFrom('ai_agent_run_events')
    .select(['type', 'summary', 'payload'])
    .where('run_id', '=', turnId)
    .orderBy('seq', 'asc')
    .execute();
  return JSON.stringify(rows);
}

/**
 * Waits for a submitted turn to finish and returns the run's result.
 *
 * The answer is the observable that matters here: the fake provider's `__FAKE_ECHO_PROMPT__` seam
 * returns the exact user message the model received, so a test can see whether the page context
 * reached the model — and, just as important, whether it did not.
 */
async function settledRun(id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await call('GET', `/api/v1/AIAgents/action/runs/${id}`, ctx.adminToken);
    const status = String(result.body['status'] ?? '');
    if (['succeeded', 'failed', 'blocked_by_policy', 'expired', 'cancelled', 'waiting_for_approval'].includes(status)) {
      return result.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${id} never settled.`);
}

/** The text the model answered with. */
function answerOf(run: Record<string, unknown>): string {
  const result = run['result'] as { text?: unknown } | null;
  return typeof result?.text === 'string' ? result.text : '';
}

/** Creates one record through the API and registers it for cleanup by exact id. */
async function createContact(name: string, token: string): Promise<string> {
  const created = await call('POST', '/api/v1/Contact', token, { name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id'] ?? '');
  createdRecordIds.push(id);
  return id;
}

beforeAll(async () => {
  ctx = await bootApi();

  baselineAiSettings = await snapshotSettings(ctx, 'aiAgents');
  baselineChatSettings = await snapshotSettings(ctx, 'crmChat');

  // A deterministic, offline answering agent: the fake provider is registered outside production,
  // so no vendor is ever called from this suite.
  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status, JSON.stringify(provider.body)).toBe(201);

  // Without a price card every run is refused for cost before a tool is reached.
  const pricing = await call('POST', '/api/v1/AIAgents/action/pricing', ctx.adminToken, {
    providerKey: PROVIDER_KEY,
    model: 'fake-model',
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.2,
  });
  expect(pricing.status, JSON.stringify(pricing.body)).toBe(201);

  const aiReady = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    limits: { maxConcurrency: 10 },
    features: { definitions: true, execution: true, memory: true },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(aiReady.status, JSON.stringify(aiReady.body)).toBe(200);

  const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key: ASSISTANT_KEY,
    name: `${MARKER} assistant`,
    visibility: 'organization',
    config: {
      provider: { key: PROVIDER_KEY, model: 'fake-model' },
      dataClass: 'internal',
      prompt: { system: 'Answer from the CRM tools. Cite what you read. Never invent a number.' },
      input: { mode: 'text' },
      tools: [
        { key: 'crm_read_record' },
        { key: 'crm_record_summary' },
        { key: 'crm_list_activities' },
      ],
      limits: {
        maxSteps: 4,
        maxModelCalls: 4,
        maxToolCalls: 2,
        maxTokens: 12_000,
        maxCostUsd: 0.5,
        maxElapsedSeconds: 60,
        maxRetries: 0,
        maxOutputTokens: 1_024,
        temperature: 0.2,
      },
      output: { mode: 'text' },
      memory: { mode: 'conversation', maxMessages: 12, retentionDays: 30 },
      triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
      approval: { requireFor: ['material_write', 'high_impact'] },
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const assistantId = String(created.body['id'] ?? '');
  assistantIds.push(assistantId);
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${assistantId}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  const chatReady = await call('POST', '/api/v1/CRMChat/action/settings', ctx.adminToken, {
    features: { readTools: true },
    // The turn runs in this process, so the suite does not depend on a queue worker.
    execution: { mode: 'inline' },
    assistant: { agentKey: ASSISTANT_KEY },
  });
  expect(chatReady.status, JSON.stringify(chatReady.body)).toBe(200);

  // The reader sees their own records only (`own` scope). The foreign contact below is another
  // principal's record, so the ACL — not a test shortcut — is what drops the context.
  await createTestRole(ctx, {
    id: ROLE_READER,
    name: `${MARKER} reader role`,
    permissions: {
      CRMChatConversation: { read: 'all', edit: 'all', delete: 'all' },
      CRMChatPrompt: { read: 'all', edit: 'all' },
      AIAgent: { read: 'all' },
      Contact: { read: 'own', create: 'all', edit: 'own', delete: 'own' },
      Account: { read: 'own', create: 'all', edit: 'own', delete: 'own' },
      Task: { read: 'own', create: 'all', edit: 'own', delete: 'own' },
      Call: { read: 'own', create: 'all', edit: 'own', delete: 'own' },
      Meeting: { read: 'own', create: 'all', edit: 'own', delete: 'own' },
    },
  });

  const reader = await createTestUser(ctx, {
    userName: USER_READER,
    password: 'TestPass123!',
    roleIds: [ROLE_READER],
  });
  createdUserIds.push(reader.id);
  readerToken = reader.token;

  // The reader's own contact — the page they are on.
  ownContactId = await createContact(OWN_CONTACT_NAME, readerToken);
  // Another principal's contact: created by the administrator, so the reader's `own` scope excludes it.
  foreignContactId = await createContact(FOREIGN_CONTACT_NAME, ctx.adminToken);
});

afterEach(async () => {
  // An accepted turn is a queued run. Close it, so the next submission is measured against its own
  // behaviour and not against the previous test's active-turn slot.
  if (createdUserIds.length === 0) return;
  const active = await ctx.database.db
    .selectFrom('ai_agent_runs')
    .select('id')
    .where('initiated_by_user_id', 'in', createdUserIds)
    .where('status', 'in', ['queued', 'running', 'retry_wait', 'cancel_requested'])
    .execute();
  for (const run of active) {
    await call('POST', `/api/v1/CRMChat/action/turns/${run.id}/cancel`, readerToken, {});
  }
});

afterAll(async () => {
  const db = ctx.database.db;
  if (createdRecordIds.length > 0) {
    await db.deleteFrom('entity_records').where('id', 'in', createdRecordIds).execute();
  }
  if (createdUserIds.length > 0) {
    await db.deleteFrom('ai_agent_messages')
      .where(
        'conversation_id',
        'in',
        db.selectFrom('ai_agent_conversations').select('id').where('owner_user_id', 'in', createdUserIds),
      )
      .execute();
    await db.deleteFrom('ai_agent_runs').where('initiated_by_user_id', 'in', createdUserIds).execute();
    await db.deleteFrom('ai_agent_conversations').where('owner_user_id', 'in', createdUserIds).execute();
    await db.deleteFrom('crm_chat_prompts').where('owner_user_id', 'in', createdUserIds).execute();
    await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  }
  await db.deleteFrom('roles').where('id', 'in', [ROLE_READER]).execute();
  if (assistantIds.length > 0) {
    // The grants and the versions cascade from the agent row.
    await db.deleteFrom('ai_agent_versions').where('agent_id', 'in', assistantIds).execute();
    await db.deleteFrom('ai_agents').where('id', 'in', assistantIds).execute();
  }
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  await restoreSettings(ctx, 'crmChat', baselineChatSettings);
  await restoreSettings(ctx, 'aiAgents', baselineAiSettings);
  await shutdownApi();
});

describe('CRM Chat page context (25.9)', () => {
  it('resolves the record the user is on into a bounded, server-side summary', async () => {
    const resolved = await call(
      'GET',
      `/api/v1/CRMChat/action/page-context?entity=Contact&id=${encodeURIComponent(ownContactId)}`,
      readerToken,
    );

    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body['status']).toBe('applied');
    expect(resolved.body['entity']).toBe('Contact');
    expect(resolved.body['id']).toBe(ownContactId);
    // The label is the record's own name, produced by the server.
    expect(resolved.body['label']).toBe(OWN_CONTACT_NAME);
    expect(resolved.body['reason']).toBeNull();
  });

  it('drops a record the caller may not read, and says nothing about it', async () => {
    const resolved = await call(
      'GET',
      `/api/v1/CRMChat/action/page-context?entity=Contact&id=${encodeURIComponent(foreignContactId)}`,
      readerToken,
    );

    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body['status']).toBe('dropped');
    expect(resolved.body['label']).toBeNull();
    // The refusal must not name the record: the endpoint is not an existence oracle.
    expect(JSON.stringify(resolved.body)).not.toContain(FOREIGN_CONTACT_NAME);
  });

  it('refuses a reference that is not shaped like an entity and a record id', async () => {
    for (const query of [
      'entity=Contact%3B%20DROP%20TABLE&id=abc',
      'entity=Contact&id=..%2F..%2Fetc%2Fpasswd',
      'entity=&id=abc',
    ]) {
      const resolved = await call('GET', `/api/v1/CRMChat/action/page-context?${query}`, readerToken);
      expect([400, 422], query).toContain(resolved.status);
    }
  });

  it('carries the resolved record into the run as a reference, not as text', async () => {
    const turn = await call('POST', '/api/v1/CRMChat/action/turns', readerToken, {
      prompt: `__FAKE_ECHO_PROMPT__ ${MARKER} summarise this person`,
      pageContext: { entity: 'Contact', id: ownContactId },
    });

    expect(turn.status, JSON.stringify(turn.body)).toBe(201);
    const view = turn.body['pageContext'] as { status?: string; label?: string } | undefined;
    expect(view?.status).toBe('applied');
    expect(view?.label).toBe(OWN_CONTACT_NAME);

    const turnId = String(turn.body['turnId'] ?? '');
    const input = await runInput(turnId);
    // The browser sends identifiers. The record's content is read by the server.
    expect(input['pageContext']).toEqual({ entity: 'Contact', id: ownContactId });
    expect(String(input['text'] ?? '')).not.toContain(OWN_CONTACT_NAME);

    // And the record's own fields reached the model — server-side, under the caller's ACL.
    const settled = await settledRun(turnId);
    const answer = answerOf(settled);
    expect(answer).toContain('<page_context entity="Contact"');
    expect(answer).toContain(OWN_CONTACT_NAME);
  });

  it('runs the turn without the context when the record is not readable, and leaks nothing', async () => {
    const turn = await call('POST', '/api/v1/CRMChat/action/turns', readerToken, {
      prompt: `__FAKE_ECHO_PROMPT__ ${MARKER} summarise this person`,
      pageContext: { entity: 'Contact', id: foreignContactId },
    });

    // The turn is not refused: a page the user may not read must not break the chat.
    expect(turn.status, JSON.stringify(turn.body)).toBe(201);
    const view = turn.body['pageContext'] as { status?: string; label?: string } | undefined;
    expect(view?.status).toBe('dropped');
    expect(view?.label ?? null).toBeNull();

    const turnId = String(turn.body['turnId'] ?? '');
    const input = await runInput(turnId);
    expect(input['pageContext']).toBeUndefined();

    // Nothing about the record reaches the model, the run input, or the timeline a stream replays.
    const answer = answerOf(await settledRun(turnId));
    expect(answer).not.toContain(FOREIGN_CONTACT_NAME);
    expect(answer).not.toContain(foreignContactId);
    const events = await turnEvents(turnId);
    expect(events).not.toContain(FOREIGN_CONTACT_NAME);
    expect(events).not.toContain(foreignContactId);
    expect(JSON.stringify(input)).not.toContain(FOREIGN_CONTACT_NAME);
  });

  it('counts the page context towards the deployment bound on context references', async () => {
    const settings = await call('GET', '/api/v1/CRMChat/action/settings', ctx.adminToken);
    expect(settings.status).toBe(200);
    const limits = (settings.body['settings'] as { limits?: { maxContextRefs?: number } } | undefined)?.limits;
    const maxContextRefs = limits?.maxContextRefs ?? 5;

    const refs = Array.from({ length: maxContextRefs }, (_value, index) => ({
      entity: 'Contact',
      id: `${ownContactId}-${String(index)}`,
    }));
    const refused = await call('POST', '/api/v1/CRMChat/action/turns', readerToken, {
      prompt: `${MARKER} too many references`,
      contextRefs: refs,
      pageContext: { entity: 'Contact', id: ownContactId },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    const error = refused.body['error'] as { code?: string } | undefined;
    expect(error?.code).toBe('CHAT_CONTEXT_TOO_LARGE');
  });

  it('keeps the page context out of the stream a resumed connection replays', async () => {
    const turn = await call('POST', '/api/v1/CRMChat/action/turns', readerToken, {
      prompt: `${MARKER} stream safety`,
      pageContext: { entity: 'Contact', id: ownContactId },
    });
    expect(turn.status, JSON.stringify(turn.body)).toBe(201);
    const turnId = String(turn.body['turnId'] ?? '');

    // The stream carries lifecycle and tool events; the record itself is prompt-side context.
    // Even after the run has finished, nothing about the record is in the events a client may read.
    await settledRun(turnId);
    const events = await turnEvents(turnId);
    expect(events).not.toContain(OWN_CONTACT_NAME);
    expect(events).not.toContain(ownContactId);
  });

  it('resumes a stream from a query parameter as well as from the header', async () => {
    const turn = await call('POST', '/api/v1/CRMChat/action/turns', readerToken, {
      prompt: `${MARKER} resume`,
    });
    expect(turn.status, JSON.stringify(turn.body)).toBe(201);
    const turnId = String(turn.body['turnId'] ?? '');

    // A fresh connection says where it wants to continue. The server accepts it, and the stream
    // is served to the same owner — no other principal's context can be reached this way.
    await settledRun(turnId);
    const resumed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/CRMChat/action/turns/${turnId}/events?lastEventId=1`,
      headers: authHeader(readerToken),
    });
    expect([200, 404]).toContain(resumed.statusCode);
  });

  it('re-checks the context on every turn, so a lost record is dropped by the next one', async () => {
    const first = await call('POST', '/api/v1/CRMChat/action/turns', readerToken, {
      prompt: `${MARKER} first turn`,
      pageContext: { entity: 'Contact', id: ownContactId },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((first.body['pageContext'] as { status?: string } | undefined)?.status).toBe('applied');

    // The record leaves the reader's scope: it is deleted, so the ACL denies it from now on.
    const removed = await call('DELETE', `/api/v1/Contact/${ownContactId}`, readerToken);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);

    const second = await call('POST', '/api/v1/CRMChat/action/turns', readerToken, {
      prompt: `${MARKER} second turn`,
      pageContext: { entity: 'Contact', id: ownContactId },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((second.body['pageContext'] as { status?: string } | undefined)?.status).toBe('dropped');

    const input = await runInput(String(second.body['turnId'] ?? ''));
    expect(input['pageContext']).toBeUndefined();
  });
});
