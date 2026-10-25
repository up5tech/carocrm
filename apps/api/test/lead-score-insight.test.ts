import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type AuthenticatedPrincipal, REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import {
  buildInsightEvidence,
  extractInsight,
  INSIGHT_FACT_FIELDS,
  insightIdempotencyKey,
  runAsLeadScoreInternal,
} from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.17 — the optional AI fit insight
 * (`PLAN_Phase_19_LeadScore.md` §6.7, §11.1, §16 `19-LS.17`; audit §7.3; compatibility §2/§8).
 *
 * The exit criterion has two halves, and this suite drives both:
 *
 *  1. **core scoring works with AI disabled** — with the feature off, a real recalculation still produces the
 *     same deterministic score, the score read answers normally, and the only difference is that the insight
 *     action is refused and no stored answer is shown;
 *  2. **AI text cannot change scores** — generating an insight writes one append-only `LeadScoreInsight` row
 *     and leaves the Lead's projection (value, band, model version, timestamp) and the record's `version`
 *     untouched. The evidence sent to the agent is asserted from the AIAgents run's own stored input: it
 *     carries business facts and the deterministic score, and never the Lead's e-mail, phone or name.
 *
 * The provider is AIAgents' deterministic fake adapter — no network, no billable call. The configured agents
 * are ordinary published AIAgents records created through the AIAgents API; the suite removes its runs,
 * agents, provider, model, rules, Leads and insight rows by exact id and restores both settings documents.
 */

const RUN = `AGENT_TEST_LS17_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const AI_SETTINGS_ROW = 'aiAgents';
// Agent and provider keys are lowercase slugs by their own schemas; the run marker stays in names and records.
const AGENT_PREFIX = `ls17-${Date.now().toString(36)}`;
const PROVIDER_KEY = `${AGENT_PREFIX}-fake`;
const INSIGHT_PATH = '/api/v1/LeadScore/action/insight';
const RECALCULATE_PATH = '/api/v1/LeadScore/action/score/recalculate';

let ctx: ApiContext;
let previousSettings: string | null = null;
let previousAiSettings: unknown = null;
let adminPrincipal: AuthenticatedPrincipal | undefined;
let providerKey = '';
let textAgentId = '';
let recordAgentId = '';
let writeAgentId = '';
let modelId = '';
let leadId = '';
let baseSettings = '';
const created = { records: [] as string[], users: [] as string[], roles: [] as string[], runs: [] as string[] };

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface InsightBody {
  id: string;
  leadId: string;
  runId: string;
  label: string;
  agent: { id: string; name: string; key: string; version: number | null; providerKey: string | null; model: string | null; settingsVersion: number | null };
  text: string | null;
  withheld: string | null;
  confidence: number | null;
  generatedAt: string | null;
  input: { digest: string | null; fields: string[]; chars: number | null };
  counters: { durationMs: number | null; inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null };
  score: { value: number | null; band: string; modelVersion: number | null; calculatedAt: string | null };
}

interface ScoreBody {
  score: { value: number | null; band: string; modelVersion: number | null; calculatedAt: string | null; evaluationId: string | null };
  actions: { insight: { allowed: boolean; reason: string | null }; recalculate: { allowed: boolean; reason: string | null } };
  insight: InsightBody | null;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
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

function errorOf(result: CallResult): { code: string; details: Body } {
  return (result.body['error'] ?? {}) as { code: string; details: Body };
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, `${entity}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  created.records.push(id);
  return id;
}

function insight(result: CallResult): InsightBody {
  return result.body as unknown as InsightBody;
}

function score(result: CallResult): ScoreBody {
  return result.body as unknown as ScoreBody;
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function storedSettings(): Promise<Body> {
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  return (row?.data ?? {}) as Body;
}

/** AIAgents settings: the fake provider runs, definitions and execution on, no global pause. */
async function setAiSettings(patch: Record<string, unknown>): Promise<void> {
  const result = await call('POST', '/api/v1/AIAgents/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

function agentConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: { key: providerKey, model: 'fake-model', fallbackModels: [] },
    dataClass: 'internal',
    prompt: { system: 'Explain Lead fit from the evidence you are given, and nothing else.' },
    input: { mode: 'text' },
    tools: [],
    limits: {
      maxSteps: 4,
      maxModelCalls: 4,
      maxToolCalls: 2,
      maxTokens: 8_000,
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
    ...overrides,
  };
}

async function createAgent(suffix: string, config: Record<string, unknown>): Promise<string> {
  const createdAgent = await call('POST', '/api/v1/AIAgents/action/agents', {
    key: `${AGENT_PREFIX}-${suffix}`,
    name: `${RUN} ${suffix}`,
    visibility: 'organization',
    config,
  });
  expect(createdAgent.status, JSON.stringify(createdAgent.body)).toBe(201);
  const id = String(createdAgent.body['id'] ?? '');
  const published = await call('POST', `/api/v1/AIAgents/action/agents/${id}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return id;
}

async function runCount(agentId: string): Promise<number> {
  const rows = await ctx.database.db
    .selectFrom('ai_agent_runs')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('agent_id', '=', agentId)
    .executeTakeFirst();
  return Number(rows?.count ?? 0);
}

async function insightRowCount(lead: string): Promise<number> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('entity_type', '=', 'LeadScoreInsight')
    .where(sql`attrs ->> 'leadId'`, '=', lead)
    .executeTakeFirst();
  return Number(rows?.count ?? 0);
}

/** base 20 + company 10 + industry 20 = 50 for the Lead this suite creates. */
async function createPublishedModel(): Promise<void> {
  modelId = await createRecord('LeadScoreModel', {
    name: `${RUN} model`,
    modelVersion: 1,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 20,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: JSON.stringify([
      { band: 'Cold', min: 0, max: 39 },
      { band: 'Warm', min: 40, max: 69 },
      { band: 'Hot', min: 70, max: 89 },
      { band: 'Sales Ready', min: 90, max: 100 },
    ]),
    allowedFieldPaths: JSON.stringify(['company', 'industry']),
  });
  await createRecord('LeadScoreRule', {
    name: `${RUN} company rule`,
    modelId,
    modelVersion: 1,
    reasonCode: `ls17_company_${modelId.slice(-6)}`,
    dimension: 'completeness',
    enabled: true,
    condition: JSON.stringify({ field: 'company', operator: 'isNotEmpty' }),
    effect: 'add',
    points: 10,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  await createRecord('LeadScoreRule', {
    name: `${RUN} industry rule`,
    modelId,
    modelVersion: 1,
    reasonCode: `ls17_industry_${modelId.slice(-6)}`,
    dimension: 'fit',
    enabled: true,
    condition: JSON.stringify({ field: 'industry', operator: 'equals', value: 'Software' }),
    effect: 'add',
    points: 20,
    priority: 20,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  const published = await call('POST', '/api/v1/LeadScore/action/model/publish', { modelId });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  await setSettings({ enabled: true, features: { modelAdministration: true, scoring: true, manualRecalculation: true, scoreExplanation: true }, scoring: { activeModelId: modelId } });
}

beforeAll(async () => {
  ctx = await bootApi();
  const admin = await ctx.database.db.selectFrom('users').select(['id', 'user_name']).where('is_admin', '=', true).where('is_deleted', '=', false).limit(1).executeTakeFirst();
  if (admin !== undefined) adminPrincipal = { userId: admin.id, userName: admin.user_name, userType: 'admin', roles: [], teams: [] };

  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const aiRow = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', AI_SETTINGS_ROW).executeTakeFirst();
  previousAiSettings = aiRow?.data ?? null;

  // AIAgents: one deterministic fake provider and execution on. Nothing real is called.
  const provider = await call('POST', '/api/v1/AIAgents/action/providers', {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${RUN} fake provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status, JSON.stringify(provider.body)).toBe(201);
  providerKey = PROVIDER_KEY;
  await setAiSettings({
    features: { definitions: true, execution: true, memory: false, evaluations: false },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
    // The configured database may carry another suite's interrupted runs; this suite's runs are synchronous
    // and removed after each test, so a wider ceiling keeps the shared state from deciding this suite's fate.
    limits: { maxConcurrency: 10 },
  });

  textAgentId = await createAgent('text-agent', agentConfig());
  recordAgentId = await createAgent('record-agent', agentConfig({ input: { mode: 'record', entity: 'Lead' } }));
  writeAgentId = await createAgent('write-agent', agentConfig({ tools: [{ key: 'crm_update_record_fields' }] }));

  await createPublishedModel();
  leadId = await createRecord('Lead', {
    name: `${RUN} lead`,
    firstName: `${RUN}first`,
    lastName: `${RUN}last`,
    company: `${RUN} Acme`,
    industry: 'Software',
    title: 'Head of Operations',
    source: 'Web Site',
    status: 'New',
    emailAddress: `${RUN.toLowerCase()}@example.com`,
    phoneNumber: '+84 912 345 678',
    description: 'Free text that must never reach the agent.',
  });
  const scored = await call('POST', RECALCULATE_PATH, { leadId });
  expect(scored.status, JSON.stringify(scored.body)).toBe(200);
  expect((scored.body as Body)['evaluation']).toMatchObject({ scoreValue: 50 });

  // The baseline every test starts from: scoring on, insight off and unconfigured.
  baseSettings = JSON.stringify(await storedSettings());
}, 240_000);

afterEach(async () => {
  // The settings row is one document shared by every suite: restore the snapshot this suite established, so a
  // test that turned insight on cannot decide what the next one sees. AIAgents execution is restored too.
  await ctx.database.db
    .updateTable('app_settings')
    .set({ data: JSON.parse(baseSettings) as Body, modified_at: new Date() })
    .where('name', '=', SETTINGS_ROW)
    .execute();
  await setAiSettings({ features: { execution: true }, safety: { globalExecutionPaused: false } });

  // Counts are per test: remove the runs and stored answers this test produced, by the exact agents and Lead.
  const db = ctx.database.db;
  const agentIds = [textAgentId, recordAgentId, writeAgentId].filter((id) => id !== '');
  if (agentIds.length > 0) {
    const runs = await db.selectFrom('ai_agent_runs').select('id').where('agent_id', 'in', agentIds).execute().catch(() => [] as { id: string }[]);
    const runIds = runs.map((row) => row.id);
    if (runIds.length > 0) {
      await db.deleteFrom('ai_agent_run_events').where('run_id', 'in', runIds).execute().catch(() => undefined);
      await db.deleteFrom('ai_agent_tool_calls').where('run_id', 'in', runIds).execute().catch(() => undefined);
      await db.deleteFrom('ai_agent_approvals').where('run_id', 'in', runIds).execute().catch(() => undefined);
      await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute().catch(() => undefined);
    }
  }
  await db.deleteFrom('entity_records').where('entity_type', '=', 'LeadScoreInsight').where(sql`attrs ->> 'leadId'`, '=', leadId).execute().catch(() => undefined);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === null) await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() }).where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  if (previousAiSettings === null) await db.deleteFrom('app_settings').where('name', '=', AI_SETTINGS_ROW).execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: previousAiSettings as Body, modified_at: new Date() }).where('name', '=', AI_SETTINGS_ROW).execute().catch(() => undefined);

  const agentIds = [textAgentId, recordAgentId, writeAgentId].filter((id) => id !== '');
  if (agentIds.length > 0) {
    const runs = await db.selectFrom('ai_agent_runs').select('id').where('agent_id', 'in', agentIds).execute().catch(() => [] as { id: string }[]);
    const runIds = [...new Set([...created.runs, ...runs.map((row) => row.id)])];
    if (runIds.length > 0) {
      await db.deleteFrom('ai_agent_run_events').where('run_id', 'in', runIds).execute().catch(() => undefined);
      await db.deleteFrom('ai_agent_tool_calls').where('run_id', 'in', runIds).execute().catch(() => undefined);
      await db.deleteFrom('ai_agent_approvals').where('run_id', 'in', runIds).execute().catch(() => undefined);
      await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute().catch(() => undefined);
    }
    await db.deleteFrom('ai_agent_versions').where('agent_id', 'in', agentIds).execute().catch(() => undefined);
    await db.deleteFrom('ai_agent_memory_items').where('agent_id', 'in', agentIds).execute().catch(() => undefined);
    await db.deleteFrom('ai_agent_conversations').where('agent_id', 'in', agentIds).execute().catch(() => undefined);
    await db.deleteFrom('ai_agents').where('id', 'in', agentIds).execute().catch(() => undefined);
  }
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute().catch(() => undefined);
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute().catch(() => undefined);

  // Insight rows are command-written and not in `created.records` unless the test read them; remove them by
  // the Lead they name (that Lead is this run's, by exact id).
  const insights = await db.selectFrom('entity_records').select('id').where('entity_type', '=', 'LeadScoreInsight').where(sql`attrs ->> 'leadId'`, '=', leadId).execute().catch(() => [] as { id: string }[]);
  const ids = [...created.records, ...insights.map((row) => row.id)];
  if (ids.length > 0) {
    const linked = await db.selectFrom('entity_links').select('id').where((eb) => eb.or([eb('record_id_a', 'in', ids), eb('record_id_b', 'in', ids)])).execute().catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((entry) => entry.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
  }
  if (created.users.length > 0) await db.deleteFrom('users').where('id', 'in', created.users).execute().catch(() => undefined);
  if (created.roles.length > 0) await db.deleteFrom('roles').where('id', 'in', created.roles).execute().catch(() => undefined);

  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`), eb(sql`attrs->>'name'`, 'like', `${RUN}%`)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score insight suite left records behind');

  await shutdownApi();
}, 240_000);

describe('the evidence is the server’s, and it is business data only', () => {
  it('sends the deterministic score and five business fields, never contact details or notes', () => {
    const lead = {
      scoreValue: 50,
      scoreBand: 'Warm',
      scoreModelVersion: 1,
      scoreCalculatedAt: '2026-10-25T10:00:00.000Z',
      scoreStatus: 'current',
      scoreCoverage: 0.8,
      scoreReasonCodes: JSON.stringify(['ls17_company_x', 'ls17_industry_y']),
      company: 'Acme',
      industry: 'Software',
      title: 'Head of Operations',
      source: 'Web Site',
      status: 'New',
      emailAddress: 'someone@example.com',
      phoneNumber: '+84 912 345 678',
      lastName: 'Person',
      description: 'Private note',
      assignedUserId: 'user-1',
    };
    const evidence = buildInsightEvidence(lead);
    expect(evidence).not.toBeNull();
    expect(evidence?.fields).toEqual(['company', 'industry', 'title', 'source', 'status']);
    expect(evidence?.score).toMatchObject({ value: 50, band: 'Warm', modelVersion: 1, reasonCodes: ['ls17_company_x', 'ls17_industry_y'] });
    expect(evidence?.digest).toMatch(/^[0-9a-f]{64}$/);
    for (const forbidden of ['someone@example.com', '+84 912 345 678', 'Person', 'Private note', 'user-1']) {
      expect(evidence?.prompt, forbidden).not.toContain(forbidden);
    }
    expect(evidence?.prompt).toContain('do not estimate or assign a score');
    // The allowlist itself is the guarantee: no personal or free-text field may ever be added by accident.
    for (const forbidden of ['emailAddress', 'phoneNumber', 'firstName', 'lastName', 'description', 'assignedUserId', 'teams']) {
      expect(INSIGHT_FACT_FIELDS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it('has no evidence for a Lead that has not been scored', () => {
    expect(buildInsightEvidence({ company: 'Acme' })).toBeNull();
    expect(buildInsightEvidence({ scoreValue: 10 })).toBeNull();
  });

  it('reads an answer from text or the documented object, and refuses anything else', () => {
    expect(extractInsight('  A short answer.  ')).toEqual({ text: 'A short answer.', confidence: null });
    expect(extractInsight({ summary: 'Fits well.', confidence: 0.7 })).toEqual({ text: 'Fits well.', confidence: 0.7 });
    expect(extractInsight({ text: 'From text.' })).toEqual({ text: 'From text.', confidence: null });
    expect(extractInsight({ confidence: 0.9 })).toBeNull();
    expect(extractInsight({ ok: true })).toBeNull();
    expect(extractInsight('   ')).toBeNull();
    expect(extractInsight(null)).toBeNull();
    expect(extractInsight(['summary'])).toBeNull();
  });

  it('derives a bounded, stable request key from the agent, the Lead and the caller key', () => {
    const first = insightIdempotencyKey('agent', 'lead', 'request');
    expect(first).toMatch(/^ls-insight:[0-9a-f]{48}$/);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(insightIdempotencyKey('agent', 'lead', 'request')).toBe(first);
    expect(insightIdempotencyKey('agent', 'lead', 'other')).not.toBe(first);
    expect(insightIdempotencyKey('other', 'lead', 'request')).not.toBe(first);
    expect(insightIdempotencyKey('agent', 'other', 'request')).not.toBe(first);
  });
});

describe('the action is off until an operator opens it (exit criterion 1)', () => {
  it('refuses with the feature off while scoring keeps working', async () => {
    await setSettings({ enabled: true, features: { aiInsight: false } });
    const before = score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`));
    expect(before.score.value).toBe(50);
    expect(before.actions.insight.allowed).toBe(false);
    expect(before.actions.insight.reason).toBe('LEADSCORE_MODULE_DISABLED');
    expect(before.insight).toBeNull();

    const refused = await call('POST', INSIGHT_PATH, { leadId });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe('LEADSCORE_MODULE_DISABLED');
    expect(JSON.stringify(refused.body)).toContain('aiInsight');
    expect(await runCount(textAgentId)).toBe(0);
    expect(await insightRowCount(leadId)).toBe(0);

    // The deterministic path is untouched: the same Lead recalculates to the same 50, with the AI feature off.
    const recalculated = await call('POST', RECALCULATE_PATH, { leadId });
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    expect((recalculated.body as Body)['evaluation']).toMatchObject({ scoreValue: 50 });
  });

  it('refuses as NOT_CONFIGURED when the switch is on but no agent is chosen', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: null } });
    const view = score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`));
    expect(view.actions.insight).toEqual({ allowed: false, reason: 'NOT_CONFIGURED' });
    const refused = await call('POST', INSIGHT_PATH, { leadId });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe('LEADSCORE_INSIGHT_NOT_CONFIGURED');
    expect(await runCount(textAgentId)).toBe(0);
  });

  it('refuses a caller without the insight right, and says so in the score answer', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: textAgentId } });
    const roleId = `${RUN}_reader`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} reader`,
      permissions: { Lead: { read: 'all' }, LeadScore: { read: 'yes' }, LeadScoreExplain: { read: 'yes' } },
    });
    created.roles.push(roleId);
    const reader = await createTestUser(ctx, { userName: `${RUN}_reader`, roleIds: [roleId] });
    created.users.push(reader.id);

    const view = score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`, undefined, reader.token));
    expect(view.score.value).toBe(50);
    expect(view.actions.insight).toEqual({ allowed: false, reason: 'AUTHORIZATION_DENIED' });
    expect(view.insight).toBeNull();

    const refused = await call('POST', INSIGHT_PATH, { leadId }, reader.token);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe('AUTHORIZATION_DENIED');
    expect(await runCount(textAgentId)).toBe(0);
  });
});

describe('one request, one stored answer, no score write (exit criterion 2)', () => {
  it('asks the configured agent, stores the answer separately and leaves the score alone', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: textAgentId } });
    const leadBefore = (await call('GET', `/api/v1/Lead/${leadId}`)).body;
    const view = score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`));
    expect(view.actions.insight.allowed).toBe(true);

    const result = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_insight_key` });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = insight(result);
    created.runs.push(answer.runId);
    expect(answer.label).toBe('ai_generated');
    expect(answer.text).toContain('Fake response to:');
    expect(answer.withheld).toBeNull();
    expect(answer.input.fields).toEqual(['company', 'industry', 'title', 'source', 'status']);
    expect(answer.input.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.input.chars).toBeGreaterThan(0);
    expect(answer.agent).toMatchObject({ id: textAgentId, key: `${AGENT_PREFIX}-text-agent`, providerKey: PROVIDER_KEY, model: 'fake-model' });
    expect(answer.agent.version).toBe(1);
    expect(answer.agent.settingsVersion).toBeGreaterThan(0);
    expect(answer.counters.inputTokens).toBeGreaterThan(0);
    expect(answer.counters.outputTokens).toBeGreaterThan(0);
    expect(answer.counters.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(answer.score).toMatchObject({ value: 50, band: 'Warm', modelVersion: 1 });
    expect(typeof answer.generatedAt).toBe('string');

    // The stored record is its own entity, not a field on the Lead — and the projection is byte-for-byte what
    // it was before the AI call, including the record's version.
    const leadAfter = (await call('GET', `/api/v1/Lead/${leadId}`)).body;
    for (const field of ['scoreValue', 'scoreBand', 'scoreModelVersion', 'scoreCalculatedAt', 'scoreStatus', 'version']) {
      expect(leadAfter[field], field).toBe(leadBefore[field]);
    }
    expect(await insightRowCount(leadId)).toBe(1);
    expect(await runCount(textAgentId)).toBe(1);

    // What the model was told is answerable from AIAgents' own run: business facts and the score, no contact
    // details, no note, no ids.
    const run = await ctx.database.db.selectFrom('ai_agent_runs').select(['input']).where('id', '=', answer.runId).executeTakeFirst();
    const prompt = String(((run?.input ?? {}) as Body)['text'] ?? '');
    expect(prompt).toContain(`${RUN} Acme`);
    expect(prompt).toContain('Software');
    expect(prompt).toContain('"value":50');
    for (const forbidden of [`${RUN.toLowerCase()}@example.com`, '+84 912 345 678', `${RUN}last`, 'Free text that must never reach the agent']) {
      expect(prompt, forbidden).not.toContain(forbidden);
    }

    // The score read now carries the answer as a separate object, with the same identity.
    const after = score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`));
    expect(after.insight?.id).toBe(answer.id);
    expect(after.insight?.text).toBe(answer.text);
    expect(after.actions.insight.allowed).toBe(true);
  });

  it('replays the same request key without a second run or a second row', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: textAgentId } });
    const first = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_replay_key` });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const original = insight(first);
    created.runs.push(original.runId);
    expect(await runCount(textAgentId)).toBe(1);

    const again = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_replay_key` });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(insight(again).id).toBe(original.id);
    expect(insight(again).runId).toBe(original.runId);
    expect(await runCount(textAgentId)).toBe(1);
    expect(await insightRowCount(leadId)).toBe(1);

    const different = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_other_key` });
    expect(different.status, JSON.stringify(different.body)).toBe(200);
    created.runs.push(insight(different).runId);
    expect(insight(different).id).not.toBe(original.id);
    expect(await runCount(textAgentId)).toBe(2);
  });

  it('refuses an agent that reads a record or holds a writing tool', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: recordAgentId } });
    const recordInput = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_record_agent` });
    expect(recordInput.status).toBe(409);
    expect(errorOf(recordInput).code).toBe('LEADSCORE_INSIGHT_AGENT_UNSUITABLE');
    expect(errorOf(recordInput).details['issue']).toBe('recordInput');

    await setSettings({ insight: { agentId: writeAgentId } });
    const writeTool = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_write_agent` });
    expect(writeTool.status).toBe(409);
    expect(errorOf(writeTool).code).toBe('LEADSCORE_INSIGHT_AGENT_UNSUITABLE');
    expect(errorOf(writeTool).details['issue']).toBe('writeTool');
    expect(await runCount(recordAgentId)).toBe(0);
    expect(await runCount(writeAgentId)).toBe(0);
  });

  it('refuses when AIAgents execution is paused, and a later replay still answers', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: textAgentId } });
    const first = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_paused_key` });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const original = insight(first);
    created.runs.push(original.runId);

    await setAiSettings({ safety: { globalExecutionPaused: true, reason: 'test pause' } });
    const refused = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_while_paused` });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe('LEADSCORE_INSIGHT_UNAVAILABLE');
    expect(errorOf(refused).details['state']).toBe('executionDisabled');
    // A replay is not a new request: it returns what already happened even while generation is closed.
    const replayed = await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_paused_key` });
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(insight(replayed).id).toBe(original.id);
  });

  it('withholds the text when it was grounded on a field this reader may not see', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: textAgentId } });
    expect((await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_withheld_key` })).status).toBe(200);

    // A row grounded on a field that does not exist for this reader (a metadata field a later build may add
    // and a role may hide) must not be quoted. Crafting the row is the only way to force the condition here.
    if (adminPrincipal === undefined) throw new Error('the admin principal was not resolved');
    const scope = ctx.app.get(REQUEST_SCOPE_TOKEN, { strict: false }) as RequestScope;
    const crud = ctx.app.get(EntityCrudService, { strict: false });
    const crafted = await scope.runAs(adminPrincipal, () =>
      runAsLeadScoreInternal(() =>
        crud.create('LeadScoreInsight', {
          name: `${RUN} withheld insight`,
          leadId,
          runId: `${RUN}_withheld_run`,
          agentId: textAgentId,
          agentName: `${RUN} text agent`,
          agentVersion: 1,
          text: 'This sentence must never be served.',
          label: 'ai_generated',
          inputFields: JSON.stringify(['company', 'aFieldThisReaderCannotSee']),
          inputDigest: 'a'.repeat(64),
          inputChars: 10,
          scoreValue: 50,
          scoreBand: 'Warm',
          scoreModelVersion: 1,
          scoreCalculatedAt: new Date().toISOString(),
          generatedAt: new Date(Date.now() + 60_000).toISOString(),
          idempotencyKey: insightIdempotencyKey(textAgentId, leadId, 'crafted-withheld'),
          durationMs: 1,
        }),
      ),
    );
    created.records.push(String(crafted['id'] ?? ''));

    const view = score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`));
    expect(view.insight?.withheld).toBe('field_hidden');
    expect(view.insight?.text).toBeNull();
    expect(JSON.stringify(view.insight)).not.toContain('This sentence must never be served.');
  });

  it('hides stored answers when the feature is switched off again', async () => {
    await setSettings({ enabled: true, features: { aiInsight: true }, insight: { agentId: textAgentId } });
    expect((await call('POST', INSIGHT_PATH, { leadId, idempotencyKey: `${RUN}_hide_key` })).status).toBe(200);
    expect(score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`)).insight).not.toBeNull();

    await setSettings({ features: { aiInsight: false } });
    const view = score(await call('GET', `/api/v1/LeadScore/action/score/${leadId}`));
    expect(view.insight).toBeNull();
    expect(view.score.value).toBe(50);
    expect(view.actions.insight.reason).toBe('LEADSCORE_MODULE_DISABLED');
  });
});
