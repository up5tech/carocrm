import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AIToolRegistry } from '../src/ai-agents/index.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CHAT.23 — module intelligence tools
 * (plans/PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.23`; `plans/SPEC.md` §9.4).
 *
 * Five thin wrappers over services that already exist. The phase's rule is that no business rule is
 * re-derived, so the assertions here are about *identity and isolation*, not about new logic:
 *
 * - each tool returns the owning service's own value for the same record;
 * - `crm_stale_records` excludes records with recent activity in the database (one query, not N+1) and
 *   never surfaces a record the caller may not read;
 * - `crm_run_report` cannot reach a report the caller is not permitted to run;
 * - all five are in the catalogue, each owned by the module that owns the service behind it.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row carries the run marker and
 * is removed by exact id in `afterAll`; nothing is truncated or recreated. Model calls use the
 * deterministic fake adapter — no billable API, no network.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_intel_${runId}`;
const ROLE_TOOLS = `AGENT_TEST-intel-tools-${runId}`;
const ROLE_RESTRICTED = `AGENT_TEST-intel-restricted-${runId}`;
const USER_TOOLS = `AGENT_TEST-intel-tools-user-${runId}`;
const USER_RESTRICTED = `AGENT_TEST-intel-restricted-user-${runId}`;
const PROVIDER_KEY = `agent-test-intel-${runId}`;

/** The five tools this phase adds. */
const INTELLIGENCE_TOOLS = [
  'crm_lead_score',
  'crm_customer_health',
  'crm_case_context',
  'crm_stale_records',
  'crm_run_report',
] as const;

let ctx: ApiContext;
let toolsToken = '';
let toolsUserId = '';
let restrictedToken = '';
const createdUserIds: string[] = [];
const agentKeys: string[] = [];
const entityIds: string[] = [];
const runIds: string[] = [];
const pricingSnapshotIds: string[] = [];
/** app_settings rows this suite changed, restored verbatim in `afterAll`. */
const baselineSettings = new Map<string, string | null>();

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
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
      maxToolCalls: 4,
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

/** A published agent holding exactly the intelligence tools. */
async function toolAgent(suffix: string): Promise<string> {
  const key = `agent-test-${runId}-intel-${suffix}`;
  const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key,
    name: `${MARKER} agent ${suffix}`,
    visibility: 'organization',
    config: baseConfig(INTELLIGENCE_TOOLS.map((k) => ({ key: k }))),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  agentKeys.push(key);
  const id = String(created.body['id']);
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${id}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return id;
}

interface ToolCallOutcome {
  readonly status: string;
  readonly summary: string | null;
  readonly errorCategory: string | null;
  readonly result: Record<string, unknown> | null;
}

/**
 * Runs one tool through the real runtime and returns what the runtime recorded.
 *
 * The outcome is read from `ai_agent_tool_calls` rather than the API projection, because the
 * projection deliberately omits the result payload and the assertions are about the payload.
 */
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

/** Creates one record through the API and registers it for cleanup by exact id. */
async function createEntityRecord(entity: string, data: Record<string, unknown>, token = ctx.adminToken): Promise<string> {
  const created = await call('POST', `/api/v1/${entity}`, token, data);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  entityIds.push(id);
  return id;
}

/** Patches a record's stored attributes directly (test fixture; bypasses the entity write path). */
async function patchAttrs(entity: string, id: string, patch: Record<string, unknown>): Promise<void> {
  await ctx.database.db
    .updateTable('entity_records')
    .set({ attrs: sql`attrs || ${JSON.stringify(patch)}::jsonb` })
    .where('id', '=', id)
    .where('entity_type', '=', entity)
    .execute();
}

/** Backdates a record so the "silent" window sees it. */
async function backdate(id: string, days: number): Promise<void> {
  await ctx.database.db
    .updateTable('entity_records')
    .set({ modified_at: new Date(Date.now() - days * 86_400_000) })
    .where('id', '=', id)
    .execute();
}

/** Captures the current value of an app_settings row so it can be restored verbatim. */
async function captureSettings(name: string): Promise<void> {
  if (baselineSettings.has(name)) return;
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', name).executeTakeFirst();
  baselineSettings.set(name, row === undefined ? null : JSON.stringify(row.data));
}

async function restoreSettings(): Promise<void> {
  for (const [name, data] of baselineSettings) {
    if (data === null) {
      await ctx.database.db.deleteFrom('app_settings').where('name', '=', name).execute();
    } else {
      await ctx.database.db
        .insertInto('app_settings')
        .values({ name, data, modified_at: new Date() })
        .onConflict((oc) => oc.column('name').doUpdateSet({ data, modified_at: new Date() }))
        .execute();
    }
  }
}

beforeAll(async () => {
  ctx = await bootApi();

  await captureSettings('leadScore');
  await captureSettings('serviceDesk');
  // This suite points the default provider at its own fake provider, so the `aiAgents` row is
  // captured too: leaving a dangling default key behind would make the module health report
  // "the default provider is missing" for every later run.
  await captureSettings('aiAgents');

  // 19-CHAT.23: the lead-score tool answers through the module's own gate, so the module must be on
  // and the scoring feature effective. `scoring` depends on `modelAdministration`.
  const leadScoreSettings = await call('POST', '/api/v1/LeadScore/action/settings', ctx.adminToken, {
    enabled: true,
    features: { modelAdministration: true, scoring: true },
  });
  expect(leadScoreSettings.status, JSON.stringify(leadScoreSettings.body)).toBe(200);

  // The knowledge-base suggestions in `crm_case_context` are behind the service-desk feature switch.
  const serviceDeskSettings = await call('POST', '/api/v1/ServiceDesk/action/settings', ctx.adminToken, {
    features: { knowledgeBase: true },
  });
  expect(serviceDeskSettings.status, JSON.stringify(serviceDeskSettings.body)).toBe(200);

  await createTestRole(ctx, {
    id: ROLE_TOOLS,
    name: `${MARKER} intelligence tools`,
    permissions: {
      AIAgent: { read: 'yes' },
      // `viewScore` is a synthetic permission resource owned by the lead-score module.
      LeadScore: { read: 'all' },
      LeadScoreExplain: { read: 'all' },
      Account: { read: 'all', create: 'all', edit: 'all' },
      Contact: { read: 'all', create: 'all' },
      Lead: { read: 'all', create: 'all', edit: 'all' },
      Case: { read: 'all', create: 'all' },
      CustomerSuccessProfile: { read: 'all', create: 'all' },
      CustomerSuccessHealthSnapshot: { read: 'all' },
      KnowledgeArticle: { read: 'all', create: 'all' },
      Report: { read: 'all', create: 'all' },
    },
  });
  await createTestRole(ctx, {
    id: ROLE_RESTRICTED,
    name: `${MARKER} intelligence restricted`,
    permissions: {
      AIAgent: { read: 'yes' },
      // `own` scope: records created by or assigned to this caller only.
      Account: { read: 'own', create: 'all' },
    },
  });

  const toolsUser = await createTestUser(ctx, { userName: USER_TOOLS, roleIds: [ROLE_TOOLS] });
  toolsToken = toolsUser.token;
  toolsUserId = toolsUser.id;
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
  await db.deleteFrom('ai_agent_runs').where('idempotency_key', 'like', `%${MARKER}%`).execute();
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  if (pricingSnapshotIds.length > 0) {
    await db.deleteFrom('ai_agent_pricing_snapshots').where('id', 'in', pricingSnapshotIds).execute();
  }
  await db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  const testAgents = await db
    .selectFrom('ai_agents')
    .select('id')
    .where('agent_key', 'like', `agent-test-${runId}-intel-%`)
    .execute();
  if (testAgents.length > 0) {
    const ids = testAgents.map((agent) => agent.id);
    await db.deleteFrom('ai_agent_memory_items').where('agent_id', 'in', ids).execute();
    await db.deleteFrom('ai_agent_conversations').where('agent_id', 'in', ids).execute();
  }
  await db.deleteFrom('ai_agents').where('agent_key', 'like', `agent-test-${runId}-intel-%`).execute();
  if (entityIds.length > 0) {
    // Stream items and link rows point at the records, so they go first.
    await db.deleteFrom('stream_items').where('entity_id', 'in', entityIds).execute();
    await db
      .deleteFrom('entity_links')
      .where((eb) => eb.or([eb('record_id_a', 'in', entityIds), eb('record_id_b', 'in', entityIds)]))
      .execute();
    await db.deleteFrom('entity_records').where('id', 'in', entityIds).execute();
  }
  await restoreSettings();
  // A crashed earlier run could have captured this suite's provider key as the baseline. Clearing
  // only that exact value keeps a dangling default from outliving the connection it named.
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

describe('module intelligence tools (19-CHAT.23)', () => {
  it('puts all five tools in the catalogue, each owned by the module that owns its service', () => {
    const registry = ctx.app.get(AIToolRegistry);
    for (const key of INTELLIGENCE_TOOLS) {
      expect(registry.has(key), `${key} is not registered`).toBe(true);
    }
    expect(registry.get('crm_lead_score').owningModule).toBe('LeadScore');
    expect(registry.get('crm_customer_health').owningModule).toBe('CustomerSuccess');
    expect(registry.get('crm_case_context').owningModule).toBe('ServiceDesk');
    expect(registry.get('crm_stale_records').owningModule).toBe('AIAgents');
    expect(registry.get('crm_run_report').owningModule).toBe('AIAgents');

    // Every one of them is a read: none of the five may move data.
    for (const key of INTELLIGENCE_TOOLS) {
      const definition = registry.get(key);
      expect(definition.effectClass, `${key} must be a read`).toBe('read');
      expect(definition.requiresApproval, `${key} must not require approval`).toBe(false);
    }
  });

  it('returns the lead score the owning service computes for the same lead', async () => {
    const agentId = await toolAgent('lead-score');
    const leadId = await createEntityRecord(
      'Lead',
      { name: `${MARKER} scored lead`, lastName: 'Scored', assignedUserId: toolsUserId },
      toolsToken,
    );
    // The projection the score engine stores on the Lead; the service reads it back verbatim.
    await patchAttrs('Lead', leadId, { scoreValue: 42, scoreBand: 'Warm', scoreStatus: 'current' });

    const outcome = await runTool(agentId, 'crm_lead_score', { leadId }, toolsToken);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');

    const result = outcome.result as Record<string, unknown>;
    const score = result['score'] as Record<string, unknown>;
    expect(score['value']).toBe(42);
    expect(score['band']).toBe('Warm');
    expect(result['leadId']).toBe(leadId);
    expect(result['scored']).toBe(true);
  });

  it('returns the customer health score the owning service computes for the same profile', async () => {
    const agentId = await toolAgent('customer-health');
    const accountId = await createEntityRecord('Account', { name: `${MARKER} health account` }, toolsToken);
    const profileId = await createEntityRecord(
      'CustomerSuccessProfile',
      { name: `${MARKER} health profile`, accountId },
      toolsToken,
    );

    // The snapshot the health service reads: the tool must return this number, not a new one.
    await ctx.database.db
      .insertInto('entity_records')
      .values({
        id: `AGENT_TEST_intel_snapshot_${runId}`,
        entity_type: 'CustomerSuccessHealthSnapshot',
        name: `${MARKER} health snapshot`,
        attrs: JSON.stringify({
          name: `${MARKER} health snapshot`,
          profileId,
          score: 37,
          status: 'atRisk',
          effectiveStatus: 'atRisk',
          coverage: 80,
          configurationVersion: 1,
          calculatedAt: new Date().toISOString(),
          resultState: 'success',
          components: [],
        }),
        version: 1,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    entityIds.push(`AGENT_TEST_intel_snapshot_${runId}`);

    const outcome = await runTool(agentId, 'crm_customer_health', { profileId }, toolsToken);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');

    const result = outcome.result as Record<string, unknown>;
    expect(result['score']).toBe(37);
    expect(result['profileId']).toBe(profileId);
    expect(result['accountId']).toBe(accountId);
  });

  it('summarises a case with its SLA clocks and suggested articles', async () => {
    const agentId = await toolAgent('case-context');
    const accountId = await createEntityRecord('Account', { name: `${MARKER} case account` }, toolsToken);
    const caseId = await createEntityRecord(
      'Case',
      // `assignedUserId` is set by the Service Desk module and is write-guarded, so it is not sent.
      { name: `${MARKER} broken invoice export`, accountId },
      toolsToken,
    );

    // An SLA clock for the case, stored the way the service desk stores it.
    const clockId = `AGENT_TEST_intel_clock_${runId}`;
    await ctx.database.db
      .insertInto('entity_records')
      .values({
        id: clockId,
        entity_type: 'CaseSLAClock',
        name: `${MARKER} clock`,
        attrs: JSON.stringify({
          name: `${MARKER} clock`,
          caseId,
          targetType: 'firstResponse',
          startAt: new Date(Date.now() - 3_600_000).toISOString(),
          dueAt: new Date(Date.now() + 3_600_000).toISOString(),
          elapsedMinutes: 60,
          status: 'onTrack',
          cycle: 1,
        }),
        version: 1,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    entityIds.push(clockId);

    const outcome = await runTool(agentId, 'crm_case_context', { caseId }, toolsToken);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');

    const result = outcome.result as Record<string, unknown>;
    const caseView = result['case'] as Record<string, unknown>;
    expect(caseView['id']).toBe(caseId);
    expect(caseView['accountId']).toBe(accountId);

    const clocks = result['slaClocks'] as Record<string, unknown>[];
    expect(clocks.length).toBe(1);
    expect(clocks[0]?.['targetType']).toBe('firstResponse');

    expect(Array.isArray(result['suggestedArticles'])).toBe(true);
    expect(result['csat']).not.toBeUndefined();
  });

  it('finds silent records in the database and hides the ones the caller may not read', async () => {
    const agentId = await toolAgent('stale-records');

    // Created by the tools user, so the restricted caller cannot see them at all.
    const staleAccount = await createEntityRecord(
      'Account',
      { name: `${MARKER} silent account`, assignedUserId: toolsUserId },
      toolsToken,
    );
    await backdate(staleAccount, 120);

    // Same age, but it has timeline activity — the database excludes it, not the model.
    const activeAccount = await createEntityRecord(
      'Account',
      { name: `${MARKER} active account`, assignedUserId: toolsUserId },
      toolsToken,
    );
    await backdate(activeAccount, 120);
    await ctx.database.db
      .insertInto('stream_items')
      .values({
        id: `AGENT_TEST_intel_stream_${runId}`,
        entity_type: 'Account',
        entity_id: activeAccount,
        type: 'note',
        data: JSON.stringify({ body: `${MARKER} recent activity` }),
        created_by_id: toolsUserId,
        created_at: new Date(),
        modified_at: new Date(),
        is_deleted: false,
      })
      .execute();

    const outcome = await runTool(
      agentId,
      'crm_stale_records',
      { entity: 'Account', days: 30, limit: 50 },
      toolsToken,
    );
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');

    const result = outcome.result as Record<string, unknown>;
    const records = result['records'] as Record<string, unknown>[];
    const ids = records.map((record) => String(record['id']));
    expect(ids, 'the silent account must be reported').toContain(staleAccount);
    expect(ids, 'an account with timeline activity is not silent').not.toContain(activeAccount);

    // The same call as a caller who may not read those records: neither may appear.
    const restricted = await runTool(
      agentId,
      'crm_stale_records',
      { entity: 'Account', days: 30, limit: 50 },
      restrictedToken,
    );
    expect(restricted.status, JSON.stringify(restricted)).toBe('succeeded');
    const restrictedResult = restricted.result as Record<string, unknown>;
    const restrictedIds = (restrictedResult['records'] as Record<string, unknown>[]).map((record) =>
      String(record['id']),
    );
    expect(restrictedIds).not.toContain(staleAccount);
    expect(restrictedIds).not.toContain(activeAccount);
  });

  it('runs a report the caller may see and refuses one they may not', async () => {
    const agentId = await toolAgent('run-report');

    // A private report owned by the admin: the restricted caller may neither list nor run it.
    const privateReport = await call('POST', '/api/v1/Report', ctx.adminToken, {
      name: `${MARKER} private report`,
      visibility: 'private',
      definition: { entityType: 'Account', kind: 'list', columns: ['name'] },
    });
    expect(privateReport.status, JSON.stringify(privateReport.body)).toBe(201);
    const privateReportId = String(privateReport.body['id']);

    // A shared report everybody with access may run.
    const sharedReport = await call('POST', '/api/v1/Report', ctx.adminToken, {
      name: `${MARKER} shared report`,
      visibility: 'shared',
      definition: { entityType: 'Account', kind: 'list', columns: ['name'] },
    });
    expect(sharedReport.status, JSON.stringify(sharedReport.body)).toBe(201);
    const sharedReportId = String(sharedReport.body['id']);

    const listed = await runTool(agentId, 'crm_run_report', {}, restrictedToken);
    expect(listed.status, JSON.stringify(listed)).toBe('succeeded');
    const listedReports = (listed.result as Record<string, unknown>)['reports'] as Record<string, unknown>[];
    const listedIds = listedReports.map((report) => String(report['id']));
    expect(listedIds).toContain(sharedReportId);
    expect(listedIds, 'a private report must not be listed for another user').not.toContain(privateReportId);

    // Running the shared report works.
    const ran = await runTool(agentId, 'crm_run_report', { reportId: sharedReportId }, restrictedToken);
    expect(ran.status, JSON.stringify(ran)).toBe('succeeded');
    const ranResult = ran.result as Record<string, unknown>;
    expect((ranResult['report'] as Record<string, unknown>)['id']).toBe(sharedReportId);
    expect((ranResult['result'] as Record<string, unknown>)['entityType']).toBe('Account');

    // Running the private report is refused — the service answers "it does not exist" to a caller
    // who may not run it, so the tool must not answer with its rows either.
    const refused = await runTool(agentId, 'crm_run_report', { reportId: privateReportId }, restrictedToken);
    expect(refused.status, JSON.stringify(refused)).not.toBe('succeeded');
    expect(refused.result ?? {}).not.toHaveProperty('result.rows');
  });

  it('refuses an unknown argument rather than inventing an answer', async () => {
    const agentId = await toolAgent('strict-input');
    const outcome = await runTool(agentId, 'crm_lead_score', { leadId: 'x', escalate: 'y' }, toolsToken);
    expect(outcome.status, JSON.stringify(outcome)).not.toBe('succeeded');
  });
});
