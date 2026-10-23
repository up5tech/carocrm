import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CHAT.9 — handbook-backed help answers
 * (PLAN_Phase_19_CRM_Chat.md §5.3, §17 `19-CHAT.9`; acceptance: "Help answers cite approved material and
 * admit when no reliable source is found").
 *
 * A user asks Chat how to use the product. The answer must come from the in-app handbook (`content/docs`,
 * served by the `Docs` module), read through the same visibility rules as the `/docs` screen, and the page
 * it came from must be citable.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row carries the run marker and is
 * removed by exact id in `afterAll`; the two settings documents are restored to their baseline. Model calls
 * use the deterministic fake adapter — no billable API, no network.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_docs_help_${runId}`;
const PROVIDER_KEY = `agent-test-docs-${runId}`;
const AGENT_KEY = `agent-test-${runId}-help`;
const ROLE_MEMBER = `AGENT_TEST-docs-member-${runId}`;
const USER_MEMBER = `AGENT_TEST-docs-member-${runId}`;
/** An admin-audience handbook page, which a regular user must not be able to read. */
const ADMIN_PAGE = 'admin/crm-chat';
/** A page every reader may open. */
const OPEN_PAGE = 'user/chat-and-voice';
/** The Vietnamese translation of the reports guide, which a Vietnamese reader should be sent to. */
const VI_PAGE = 'user/dashboards-and-reports';

let ctx: ApiContext;
let memberToken = '';
let memberUserId = '';
let agentId = '';
let baselineAiSettings: unknown = null;
let baselineChatSettings: unknown = null;
const runIds: string[] = [];
const conversationIds: string[] = [];

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

async function restoreSettings(name: string, baseline: unknown): Promise<void> {
  const db = ctx.database.db;
  if (baseline === null) {
    await db.deleteFrom('app_settings').where('name', '=', name).execute();
    return;
  }
  const serialized = JSON.stringify(baseline);
  await db
    .insertInto('app_settings')
    .values({ name, data: serialized, modified_at: new Date() })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
    .execute();
}

/** The tool calls of one run, oldest first — what the model asked for and what the server answered. */
async function toolCallsOf(id: string) {
  return ctx.database.db
    .selectFrom('ai_agent_tool_calls')
    .select(['tool_key', 'status', 'result_ref', 'outcome', 'error_category'])
    .where('run_id', '=', id)
    .orderBy('created_at', 'asc')
    .execute();
}

/** The tool call outcome column, which the driver hands back parsed or raw depending on the column type. */
function outcomeOf(row: { outcome: unknown } | undefined): Record<string, unknown> {
  const raw = row?.outcome;
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
  return (raw ?? {}) as Record<string, unknown>;
}

async function createRun(token: string, text: string): Promise<string> {
  const created = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, token, {
    input: { text: `${MARKER} ${text}` },
    idempotencyKey: `${MARKER}-${text.slice(0, 24)}-${String(Math.random())}`,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  runIds.push(id);
  return id;
}

/** The fake adapter answers with one tool call taken from the prompt, then a plain text answer. */
async function runTool(token: string, text: string) {
  const id = await createRun(token, text);
  const executed = await call('POST', `/api/v1/AIAgents/action/runs/${id}/execute`, ctx.adminToken, {});
  expect(executed.status, JSON.stringify(executed.body)).toBe(200);
  return id;
}

async function settledRun(id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await call('GET', `/api/v1/AIAgents/action/runs/${id}`, ctx.adminToken);
    const status = String(result.body['status'] ?? '');
    if (['succeeded', 'failed', 'blocked_by_policy', 'expired', 'cancelled'].includes(status)) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${id} never settled.`);
}

beforeAll(async () => {
  ctx = await bootApi();

  const aiRows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'aiAgents').execute();
  baselineAiSettings = aiRows[0]?.data ?? null;
  const chatRows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'crmChat').execute();
  baselineChatSettings = chatRows[0]?.data ?? null;

  await createTestRole(ctx, {
    id: ROLE_MEMBER,
    name: `${MARKER} member role`,
    permissions: { AIAgent: { read: 'yes' }, CRMChatConversation: { read: 'all', edit: 'all', delete: 'all' } },
  });
  const member = await createTestUser(ctx, {
    userName: USER_MEMBER,
    email: `${USER_MEMBER}@example.com`,
    password: 'TestPass123!',
    roleIds: [ROLE_MEMBER],
  });
  memberUserId = member.id;
  memberToken = member.token;

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status).toBe(201);

  const aiSettings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true, memory: true },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(aiSettings.status).toBe(200);

  const agent = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key: AGENT_KEY,
    name: `${MARKER} handbook assistant`,
    visibility: 'organization',
    config: {
      provider: { key: PROVIDER_KEY, model: 'fake-model' },
      dataClass: 'internal',
      prompt: { system: 'Answer from the handbook and cite the page you read.' },
      input: { mode: 'text' },
      tools: [{ key: 'docs_search' }, { key: 'docs_read_page' }],
      limits: {
        maxSteps: 6,
        maxModelCalls: 6,
        maxToolCalls: 6,
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
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  agentId = String(agent.body['id']);
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
});

afterAll(async () => {
  const db = ctx.database.db;
  for (const id of runIds) {
    await db
      .deleteFrom('jobs')
      .where('job', '=', 'aiAgents.executeRun')
      .where(sql`target::text like ${`%${id}%`}`)
      .execute();
  }
  if (conversationIds.length > 0) {
    await db.deleteFrom('crm_chat_citations').where('conversation_id', 'in', conversationIds).execute();
    await db.deleteFrom('crm_chat_feedback').where('conversation_id', 'in', conversationIds).execute();
  }
  if (runIds.length > 0) {
    await db.deleteFrom('ai_agent_tool_calls').where('run_id', 'in', runIds).execute();
    await db.deleteFrom('ai_agent_run_events').where('run_id', 'in', runIds).execute();
  }
  if (conversationIds.length > 0) {
    await db.deleteFrom('ai_agent_messages').where('conversation_id', 'in', conversationIds).execute();
    await db.deleteFrom('ai_agent_conversations').where('id', 'in', conversationIds).execute();
  }
  if (runIds.length > 0) await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute();
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  const agents = await db.selectFrom('ai_agents').select('id').where('agent_key', 'like', `agent-test-${runId}-%`).execute();
  if (agents.length > 0) {
    const ids = agents.map((agent) => agent.id);
    await db.deleteFrom('ai_agent_memory_items').where('agent_id', 'in', ids).execute();
    await db.deleteFrom('ai_agent_conversations').where('agent_id', 'in', ids).execute();
  }
  await db.deleteFrom('ai_agents').where('agent_key', 'like', `agent-test-${runId}-%`).execute();
  await db
    .updateTable('app_settings')
    .set({
      data: sql`jsonb_set(data, '{settings,provider,defaultKey}', '""'::jsonb)`,
      modified_at: new Date(),
    })
    .where('name', '=', 'aiAgents')
    .where(sql`data->'settings'->'provider'->>'defaultKey'`, '=', PROVIDER_KEY)
    .execute();
  await restoreSettings('aiAgents', baselineAiSettings);
  await restoreSettings('crmChat', baselineChatSettings);
  if (memberUserId !== '') await db.deleteFrom('users').where('id', '=', memberUserId).execute();
  await db.deleteFrom('roles').where('id', '=', ROLE_MEMBER).execute();
  await shutdownApi();
});

describe('handbook read tools (19-CHAT.9)', () => {
  it('searches the handbook and returns pages with the route the reader can open', async () => {
    const id = await runTool(
      ctx.adminToken,
      `How do I talk to the assistant? __FAKE_TOOL__:docs_search __FAKE_TOOL_ARGS__:{"query":"chat","maxSize":3}`,
    );
    const settled = await settledRun(id);
    expect(settled['status']).toBe('succeeded');

    const calls = await toolCallsOf(id);
    const search = calls.find((row) => row.tool_key === 'docs_search');
    expect(search?.status).toBe('succeeded');
    const outcome = outcomeOf(search).result as {
      pages: { key: string; title: string; route: string; excerpt: string }[];
    };
    expect(outcome.pages.length).toBeGreaterThan(0);
    // The model gets a key it can read next, and the route the human can open — both server-produced.
    expect(outcome.pages[0]?.route).toBe(`/docs/${String(outcome.pages[0]?.key)}`);
    expect(outcome.pages[0]?.title.length).toBeGreaterThan(0);
  });

  it('reads a page and leaves a citation reference the model cannot write', async () => {
    const id = await runTool(
      ctx.adminToken,
      `Tell me about Chat. __FAKE_TOOL__:docs_read_page __FAKE_TOOL_ARGS__:{"key":"${ADMIN_PAGE}"}`,
    );
    const settled = await settledRun(id);
    expect(settled['status']).toBe('succeeded');

    const calls = await toolCallsOf(id);
    const read = calls.find((row) => row.tool_key === 'docs_read_page');
    expect(read?.status).toBe('succeeded');
    expect(read?.result_ref).toBe(`help_document:${ADMIN_PAGE}`);
    const outcome = outcomeOf(read).result as { content: string; title: string };
    expect(outcome.content.length).toBeGreaterThan(0);
    expect(outcome.title).toBeTypeOf('string');
  });

  it('refuses a page the caller may not read, with no content and no citation', async () => {
    const id = await runTool(
      memberToken,
      `Admin only please. __FAKE_TOOL__:docs_read_page __FAKE_TOOL_ARGS__:{"key":"${ADMIN_PAGE}"}`,
    );
    const settled = await settledRun(id);
    expect(settled['status']).toBe('succeeded');

    const calls = await toolCallsOf(id);
    const read = calls.find((row) => row.tool_key === 'docs_read_page');
    expect(read?.status).toBe('succeeded');
    // No reference means no citation: the answer cannot claim a page this user cannot open.
    expect(read?.result_ref).toBeNull();
    const outcome = outcomeOf(read).result as { content?: string; available?: boolean };
    expect(outcome.available).toBe(false);
    expect(outcome.content).toBeUndefined();
  });

  it('hides an admin page from a regular user in the search results too', async () => {
    const id = await runTool(
      memberToken,
      `What can I see? __FAKE_TOOL__:docs_search __FAKE_TOOL_ARGS__:{"query":"chat","maxSize":5}`,
    );
    await settledRun(id);

    const calls = await toolCallsOf(id);
    const search = calls.find((row) => row.tool_key === 'docs_search');
    const outcome = outcomeOf(search).result as { pages: { key: string }[] };
    const keys = outcome.pages.map((page) => page.key);
    expect(keys).not.toContain(ADMIN_PAGE);
    expect(keys).toContain(OPEN_PAGE);
  });

  it('answers a Vietnamese question from the Vietnamese handbook pages', async () => {
    // The reader's own language picks the corpus, the same way the `/docs` screen does.
    const patched = await call('PATCH', '/api/v1/AppUser/me', memberToken, { locale: 'vi' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const id = await runTool(
      memberToken,
      `Cách tạo báo cáo? __FAKE_TOOL__:docs_search __FAKE_TOOL_ARGS__:{"query":"báo cáo bán hàng","maxSize":3}`,
    );
    await settledRun(id);

    const calls = await toolCallsOf(id);
    const search = calls.find((row) => row.tool_key === 'docs_search');
    const outcome = outcomeOf(search).result as { locale: string; pages: { key: string; locale: string }[] };
    expect(outcome.locale).toBe('vi');
    expect(outcome.pages[0]?.key).toBe(VI_PAGE);
    expect(outcome.pages[0]?.locale).toBe('vi');

    const restored = await call('PATCH', '/api/v1/AppUser/me', memberToken, { locale: null });
    expect(restored.status).toBe(200);
  });

  it('admits when the handbook has nothing for the question', async () => {
    const id = await runTool(
      ctx.adminToken,
      `Nonsense query. __FAKE_TOOL__:docs_search __FAKE_TOOL_ARGS__:{"query":"zzqxvbw jkphmrt","maxSize":3}`,
    );
    await settledRun(id);

    const calls = await toolCallsOf(id);
    const search = calls.find((row) => row.tool_key === 'docs_search');
    const outcome = outcomeOf(search).result as { pages: unknown[]; noSource?: boolean };
    expect(outcome.pages).toHaveLength(0);
    expect(outcome.noSource).toBe(true);
  });
});

describe('handbook citation in a Chat answer (19-CHAT.8)', () => {
  it('materialises a help_document citation that links to the handbook page', async () => {
    const chatSettings = await call('POST', '/api/v1/CRMChat/action/settings', ctx.adminToken, {
      features: { workspace: true },
      assistant: { agentKey: AGENT_KEY },
      execution: { mode: 'inline' },
    });
    expect(chatSettings.status, JSON.stringify(chatSettings.body)).toBe(200);

    const turn = await call('POST', '/api/v1/CRMChat/action/turns', ctx.adminToken, {
      prompt: `How do I use CRM Chat? __FAKE_TOOL__:docs_read_page __FAKE_TOOL_ARGS__:{"key":"${ADMIN_PAGE}"}`,
      idempotencyKey: `${MARKER}-turn-${String(Math.random())}`,
    });
    expect(turn.status, JSON.stringify(turn.body)).toBe(201);
    const turnId = String((turn.body['turnId'] ?? '') as string);
    expect(turnId).not.toBe('');
    runIds.push(turnId);

    const settled = await settledRun(turnId);
    expect(settled['status']).toBe('succeeded');
    const conversationId = String((settled['conversationId'] ?? '') as string);
    expect(conversationId).not.toBe('');
    conversationIds.push(conversationId);

    const messages = await call('GET', `/api/v1/CRMChat/action/conversations/${conversationId}`, ctx.adminToken);
    expect(messages.status).toBe(200);
    const list = ((messages.body['messages'] as { list: Record<string, unknown>[] }).list ?? []) as {
      role: string;
      citations: { sourceType: string; label: string; route: string; entity: string | null; recordId: string | null }[];
    }[];
    const answer = list.find((message) => message.role === 'assistant');
    expect(answer).toBeDefined();
    const citation = answer?.citations.find((entry) => entry.sourceType === 'help_document');
    expect(citation?.route).toBe(`/docs/${ADMIN_PAGE}`);
    // A handbook citation is not a CRM record, so it must not claim an entity or a record id.
    expect(citation?.entity).toBeNull();
    expect(citation?.recordId).toBeNull();
    expect(String(citation?.label).length).toBeGreaterThan(0);

    // The citation route is re-checked, not trusted: a page the caller cannot read stops being a link.
    const reauthMember = await call('POST', '/api/v1/CRMChat/action/citations/reauthorize', memberToken, {
      citations: [{ sourceType: 'help_document', label: 'CRM Chat', route: `/docs/${ADMIN_PAGE}` }],
    });
    expect(reauthMember.status).toBe(200);
    const checked = (reauthMember.body['citations'] as { accessible: boolean; route: string | null }[])[0];
    expect(checked?.accessible).toBe(false);
    expect(checked?.route).toBeNull();

    const reauthAdmin = await call('POST', '/api/v1/CRMChat/action/citations/reauthorize', ctx.adminToken, {
      citations: [{ sourceType: 'help_document', label: 'CRM Chat', route: `/docs/${ADMIN_PAGE}` }],
    });
    const allowed = (reauthAdmin.body['citations'] as { accessible: boolean; route: string | null }[])[0];
    expect(allowed?.accessible).toBe(true);
    expect(allowed?.route).toBe(`/docs/${ADMIN_PAGE}`);
  });
});

describe('help search over the handbook (19-CHAT.9)', () => {
  it('answers a "how do I" question with handbook pages', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/help/search?q=chat', ctx.adminToken);
    expect(result.status).toBe(200);
    expect(result.body['hasResults']).toBe(true);
    const sources = (result.body['sources'] as { sourceType: string; route: string; title: string }[]) ?? [];
    expect(sources.some((source) => source.sourceType === 'module_doc' && source.route.startsWith('/docs/'))).toBe(true);
  });

  it('still refuses an empty question', async () => {
    const result = await call('GET', '/api/v1/CRMChat/action/help/search?q=', ctx.adminToken);
    expect(result.status).toBe(400);
  });
});
