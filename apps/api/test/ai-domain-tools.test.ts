import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AIToolRegistry } from '../src/ai-agents/ai-agent-tools.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 19-AI.15/16/17 — the four domain tools that landed with P1
 * (`plans/PLAN_Phase_19_AI_Agents.md` §13.2, §13.5, §13.6, §20).
 *
 * - `crm_project_status` (Projects) — the compact "where does this project stand" answer.
 * - `crm_commercial_summary` (Sales) — the customer's commercial position through the
 *   contract Sales publishes, with the caller's own ACL applied.
 * - `crm_campaign_performance` (MarketingAutomation) — campaign delivery/engagement counts
 *   through the module's readability gate.
 * - `crm_list_emails` (AIAgents, kernel) — email **metadata** only, never a body; the
 *   record ACL decides which rows the caller sees.
 *
 * Every tool is driven through the real runtime (`POST .../runs` + `.../execute`) with the
 * deterministic fake provider, not by calling the service directly — the thing under test is
 * that the tool is registered, grantable and reachable, and that its gate refuses cleanly
 * when the caller has no rights.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_domain_tools_${runId}`;
const ROLE_TOOLS = `AGENT_TEST-domain-tools-${runId}`;
const ROLE_RESTRICTED = `AGENT_TEST-domain-restricted-${runId}`;
const USER_TOOLS = `AGENT_TEST-domain-user-${runId}`;
const USER_RESTRICTED = `AGENT_TEST-domain-restricted-${runId}`;
const PROVIDER_KEY = `agent-test-domain-tools-${runId}`;

const DOMAIN_TOOLS = [
  { key: 'crm_project_status', owningModule: 'Projects' },
  { key: 'crm_commercial_summary', owningModule: 'Sales' },
  { key: 'crm_campaign_performance', owningModule: 'MarketingAutomation' },
  { key: 'crm_list_emails', owningModule: 'AIAgents' },
] as const;

let ctx: ApiContext;
let toolsToken = '';
let restrictedToken = '';
const createdUserIds: string[] = [];
const agentKeys: string[] = [];
const entityIds: string[] = [];
const runIds: string[] = [];
const pricingSnapshotIds: string[] = [];
const baselineSettings = new Map<string, unknown>();

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

function baseConfig(tools: readonly { key: string }[]): Record<string, unknown> {
  return {
    provider: { key: PROVIDER_KEY, model: 'fake-model', fallbackModels: [] },
    dataClass: 'internal',
    prompt: { system: 'You are a test agent. Follow the task and use tools carefully.' },
    input: { mode: 'text' },
    tools: [...tools],
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
    memory: { mode: 'none' },
    triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
    approval: { requireFor: ['material_write', 'high_impact'] },
  };
}

interface ToolCallOutcome {
  readonly status: string;
  readonly summary: string | null;
  readonly errorCategory: string | null;
  readonly result: Record<string, unknown> | null;
}

async function runTool(
  agentId: string,
  toolKey: string,
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallOutcome> {
  const created = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, token, {
    input: { text: `__FAKE_TOOL__:${toolKey} __FAKE_TOOL_ARGS__:${JSON.stringify(args)}` },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  runIds.push(id);
  const executed = await call('POST', `/api/v1/AIAgents/action/runs/${id}/execute`, ctx.adminToken, {});
  expect(executed.status, JSON.stringify(executed.body)).toBe(200);

  const row = await ctx.database.db
    .selectFrom('ai_agent_tool_calls')
    .select(['status', 'error_category', 'outcome'])
    .where('run_id', '=', id)
    .where('tool_key', '=', toolKey)
    .executeTakeFirst();
  expect(row, `no tool call recorded for ${toolKey}`).toBeDefined();
  const outcome = (row?.outcome ?? null) as
    | { summary?: string; result?: Record<string, unknown> }
    | null;
  return {
    status: String(row?.status ?? ''),
    summary: outcome?.summary ?? null,
    errorCategory: row?.error_category ?? null,
    result: outcome?.result ?? null,
  };
}

async function createRecord(entity: string, data: Record<string, unknown>, token = ctx.adminToken): Promise<string> {
  const created = await call('POST', `/api/v1/${entity}`, token, data);
  expect(created.status, `${entity}: ${JSON.stringify(created.body)}`).toBe(201);
  const id = String(created.body['id']);
  entityIds.push(id);
  return id;
}

let agentId = '';
let accountId = '';
let projectId = '';
let campaignId = '';

beforeAll(async () => {
  ctx = await bootApi();

  baselineSettings.set('aiAgents', await snapshotSettings(ctx, 'aiAgents'));

  await createTestRole(ctx, {
    id: ROLE_TOOLS,
    name: `${MARKER} domain tools`,
    permissions: {
      AIAgent: { read: 'yes' },
      Account: { read: 'all', create: 'all' },
      Contact: { read: 'all', create: 'all' },
      Project: { read: 'all' },
      ProjectTask: { read: 'all' },
      Email: { read: 'all', create: 'all' },
      Invoice: { read: 'all' },
      CreditNote: { read: 'all' },
      Payment: { read: 'all' },
      Subscription: { read: 'all' },
      Campaign: { read: 'all' },
    },
  });
  await createTestRole(ctx, {
    id: ROLE_RESTRICTED,
    name: `${MARKER} domain restricted`,
    permissions: {
      AIAgent: { read: 'yes' },
    },
  });

  const toolsUser = await createTestUser(ctx, { userName: USER_TOOLS, roleIds: [ROLE_TOOLS] });
  toolsToken = toolsUser.token;
  createdUserIds.push(toolsUser.id);

  const restrictedUser = await createTestUser(ctx, { userName: USER_RESTRICTED, roleIds: [ROLE_RESTRICTED] });
  restrictedToken = restrictedUser.token;
  createdUserIds.push(restrictedUser.id);

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status).toBe(201);

  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true, memory: true },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(settings.status).toBe(200);

  // Cheap pricing, or every run is refused for cost before the tool is reached.
  await ctx.database.db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  const snapshot = await call('POST', '/api/v1/AIAgents/action/pricing', ctx.adminToken, {
    providerKey: PROVIDER_KEY,
    model: 'fake-model',
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.2,
  });
  expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
  pricingSnapshotIds.push(String(snapshot.body['id']));

  const key = `agent-test-${runId}-domain`;
  agentKeys.push(key);
  const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key,
    name: `${MARKER} domain tools`,
    visibility: 'organization',
    config: baseConfig(DOMAIN_TOOLS.map((entry) => ({ key: entry.key }))),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  agentId = String(created.body['id']);
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  // Fixtures ------------------------------------------------------------------
  accountId = await createRecord('Account', { name: `${MARKER} commercial` });
  campaignId = await createRecord('Campaign', { name: `${MARKER} campaign` });

  const board = await call('POST', '/api/v1/ProjectBoard', ctx.adminToken, { name: `${MARKER} board` });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  const boardId = String(board.body['id']);
  entityIds.push(boardId);

  // A task needs a stage of its board; the stage mapping derives the task's status.
  const backlogStage = await call('POST', '/api/v1/ProjectBoardStage', ctx.adminToken, {
    name: `${MARKER} backlog`,
    boardId,
    key: `backlog-${runId}`,
    sortOrder: 0,
    statusValue: 'Not Started',
  });
  expect(backlogStage.status, JSON.stringify(backlogStage.body)).toBe(201);
  const backlogStageId = String(backlogStage.body['id']);
  entityIds.push(backlogStageId);
  const doingStage = await call('POST', '/api/v1/ProjectBoardStage', ctx.adminToken, {
    name: `${MARKER} doing`,
    boardId,
    key: `doing-${runId}`,
    sortOrder: 10,
    statusValue: 'Started',
  });
  expect(doingStage.status, JSON.stringify(doingStage.body)).toBe(201);
  const doingStageId = String(doingStage.body['id']);
  entityIds.push(doingStageId);

  projectId = await createRecord('Project', { name: `${MARKER} project`, boardId });

  await createRecord('ProjectTask', {
    name: `${MARKER} overdue task`,
    projectId,
    stageId: doingStageId,
    dateEnd: '2020-01-01',
  });
  await createRecord('ProjectTask', {
    name: `${MARKER} milestone`,
    projectId,
    stageId: backlogStageId,
    taskType: 'Milestone',
    dateStart: '2099-01-01',
  });

  await createRecord(
    'Email',
    {
      name: `${MARKER} outbound update`,
      status: 'Sent',
      direction: 'Outbound',
      dateSent: new Date().toISOString(),
      parentType: 'Account',
      parentId: accountId,
      fromAddress: 'sales@example.com',
      toAddressList: 'buyer@example.com',
      body: `${MARKER} THIS BODY MUST NOT LEAK INTO THE TOOL RESULT`,
    },
    toolsToken,
  );
});

afterAll(async () => {
  const db = ctx.database.db;
  if (runIds.length > 0) {
    for (const id of runIds) {
      await db
        .deleteFrom('jobs')
        .where('job', '=', 'aiAgents.executeRun')
        .where(sql`target::text like ${`%${id}%`}`)
        .execute();
    }
    await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute();
  }
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  if (pricingSnapshotIds.length > 0) {
    await db.deleteFrom('ai_agent_pricing_snapshots').where('id', 'in', pricingSnapshotIds).execute();
  }
  await db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  const testAgents = await db
    .selectFrom('ai_agents')
    .select('id')
    .where('agent_key', 'like', `agent-test-${runId}-domain%`)
    .execute();
  if (testAgents.length > 0) {
    const ids = testAgents.map((agent) => agent.id);
    await db.deleteFrom('ai_agent_memory_items').where('agent_id', 'in', ids).execute();
    await db.deleteFrom('ai_agent_conversations').where('agent_id', 'in', ids).execute();
  }
  await db.deleteFrom('ai_agents').where('agent_key', 'like', `agent-test-${runId}-domain%`).execute();
  if (entityIds.length > 0) {
    await db.deleteFrom('stream_items').where('entity_id', 'in', entityIds).execute();
    await db
      .deleteFrom('entity_links')
      .where((eb) => eb.or([eb('record_id_a', 'in', entityIds), eb('record_id_b', 'in', entityIds)]))
      .execute();
    await db.deleteFrom('entity_records').where('id', 'in', entityIds).execute();
  }
  await restoreSettings(ctx, 'aiAgents', baselineSettings.get('aiAgents'));
  await db
    .updateTable('app_settings')
    .set({
      data: sql`jsonb_set(data, '{settings,provider,defaultKey}', '""'::jsonb)`,
      modified_at: new Date(),
    })
    .where('name', '=', 'aiAgents')
    .where(sql`data->'settings'->'provider'->>'defaultKey'`, '=', PROVIDER_KEY)
    .execute();
  if (createdUserIds.length > 0) await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  await db.deleteFrom('roles').where('id', 'in', [ROLE_TOOLS, ROLE_RESTRICTED]).execute();
  await shutdownApi();
});

describe('domain tools (phase 19-AI.15/16/17)', () => {
  it('registers the four tools, each owned by the module that owns its service', () => {
    const registry = ctx.app.get(AIToolRegistry);
    for (const entry of DOMAIN_TOOLS) {
      expect(registry.has(entry.key), `${entry.key} is not registered`).toBe(true);
      expect(registry.get(entry.key).owningModule).toBe(entry.owningModule);
      expect(registry.get(entry.key).effectClass).toBe('read');
    }
  });

  it('crm_project_status answers with counts over ACL-visible tasks', async () => {
    const outcome = await runTool(agentId, 'crm_project_status', { projectId }, toolsToken);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const result = outcome.result as Record<string, unknown>;
    const tasks = result['tasks'] as Record<string, unknown>;
    expect(tasks['total']).toBe(2);
    expect(tasks['overdue']).toBe(1);
    expect((tasks['byStatus'] as Record<string, number>)?.['Started']).toBe(1);
    const milestones = result['milestones'] as Record<string, unknown>[];
    expect(milestones).toHaveLength(1);
    expect(String(milestones[0]?.['name'] ?? '')).toContain(MARKER);

    const denied = await runTool(agentId, 'crm_project_status', { projectId }, restrictedToken);
    expect(denied.status).not.toBe('succeeded');
  });

  it('crm_list_emails answers with metadata only — never a body', async () => {
    const outcome = await runTool(
      agentId,
      'crm_list_emails',
      { scope: 'record', record: { entity: 'Account', id: accountId }, maxSize: 5 },
      toolsToken,
    );
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const result = outcome.result as Record<string, unknown>;
    const emails = result['emails'] as Record<string, unknown>[];
    expect(emails.length).toBeGreaterThanOrEqual(1);
    for (const email of emails) {
      expect(email, 'the body must never cross the tool boundary').not.toHaveProperty('body');
      expect(email).not.toHaveProperty('bodyHtml');
      expect(email).not.toHaveProperty('headers');
    }

    const denied = await runTool(
      agentId,
      'crm_list_emails',
      { scope: 'record', record: { entity: 'Account', id: accountId }, maxSize: 5 },
      restrictedToken,
    );
    expect(denied.status).not.toBe('succeeded');
  });

  it('crm_commercial_summary answers from the Sales contract, and refuses cleanly without rights', async () => {
    const outcome = await runTool(agentId, 'crm_commercial_summary', { accountId }, toolsToken);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const result = outcome.result as Record<string, unknown>;
    expect(result['contractVersion']).toBe(1);
    const receivables = result['receivables'] as Record<string, unknown>;
    expect(receivables['openInvoiceCount']).toBe(0);

    const denied = await runTool(agentId, 'crm_commercial_summary', { accountId }, restrictedToken);
    expect(denied.status).not.toBe('succeeded');
  });

  it('crm_campaign_performance answers through the readability gate', async () => {
    const outcome = await runTool(agentId, 'crm_campaign_performance', { campaignId }, toolsToken);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const result = outcome.result as Record<string, unknown>;
    const delivery = result['delivery'] as Record<string, unknown>;
    expect(delivery['delivered']).toBe(0);
    expect(result['uniqueRecipients']).toBe(0);

    const denied = await runTool(agentId, 'crm_campaign_performance', { campaignId }, restrictedToken);
    expect(denied.status).not.toBe('succeeded');
  });
});
