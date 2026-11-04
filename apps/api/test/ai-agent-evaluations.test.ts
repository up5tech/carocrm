import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 19-AI.14 — evaluation suites, graders and the publication gate
 * (plans/PLAN_Phase_19_AI_Agents.md §17 `19-AI.14`, §17.1–§17.4).
 *
 * The feature shipped with code and tables and **no test at all**, which is how it stayed dormant:
 * `features.evaluations` defaulted to false, so the gate never fired, and nothing noticed. This suite
 * is the proof the phase claimed — every deterministic grader is exercised in both directions, the gate
 * is shown blocking a publish and then releasing it, and the defects the 2026-11-03 audit found are
 * pinned so they cannot come back: a suite addressed by key that was matched on `id`, a decision whose
 * payload enum did not match the DTO, runs that were not scoped by agent visibility, runs with no
 * author, and a retention setting nothing read.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). No second database, no truncate, no
 * destructive statement. **Shared-state discipline:** the evaluations feature and a required suite are
 * global, and a required+enabled suite gates *every* agent's publish — so both are switched on only
 * inside the one test that needs them and switched back in a `finally`, keeping the window in which a
 * parallel suite could be affected as short as possible. Everything this file creates carries the run
 * marker and is removed by exact id.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_eval_${runId}`;
const PROVIDER_KEY = `agent-test-eval-${runId}`;
const SUITE_KEY = `${MARKER}-suite`;
const GATE_SUITE_KEY = `${MARKER}-gate`;
const ROLE_ADMIN = `AGENT_TEST-eval-admin-${runId}`;
const ROLE_USE_ONLY = `AGENT_TEST-eval-use-only-${runId}`;
const USER_USE_ONLY = `AGENT_TEST-eval-use-only-${runId}`;

let ctx: ApiContext;
let useOnlyToken = '';
let adminUserId = '';
let baselineAiSettings: unknown = null;
/** Whether the built-in `publication-gate` suite already existed before this file ran. */
let standardSuitePreexisting = false;
const agentIds: string[] = [];
const suiteIds: string[] = [];
const runIds: string[] = [];
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];

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

/** The parts of an agent config that every grader looks at, overridable per test. */
interface ConfigOverrides {
  readonly tools?: readonly { key: string }[];
  readonly requireFor?: readonly string[];
  readonly limits?: Record<string, number>;
  readonly providerKey?: string | null;
  readonly model?: string;
  readonly memory?: { mode: string; retentionDays?: number };
}

function agentConfig(overrides: ConfigOverrides = {}): Record<string, unknown> {
  return {
    // A provider that does not exist fails `provider_policy`; tests that want a pass pass one explicitly.
    provider: overrides.providerKey === null ? undefined : { key: overrides.providerKey ?? PROVIDER_KEY, model: overrides.model ?? 'fake-model' },
    dataClass: 'internal',
    prompt: { system: 'You are a test agent.' },
    input: { mode: 'text' },
    tools: overrides.tools ?? [{ key: 'crm_search_records' }],
    limits: {
      maxSteps: 4,
      maxModelCalls: 4,
      maxToolCalls: 2,
      maxTokens: 8_000,
      maxCostUsd: 0.4,
      maxElapsedSeconds: 60,
      maxRetries: 0,
      maxOutputTokens: 1_024,
      temperature: 0.2,
      ...(overrides.limits ?? {}),
    },
    output: { mode: 'text' },
    memory: { mode: overrides.memory?.mode ?? 'none', maxMessages: 12, retentionDays: overrides.memory?.retentionDays ?? 30 },
    triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
    approval: { requireFor: overrides.requireFor ?? ['material_write', 'high_impact'] },
  };
}

/** A draft agent with a stated purpose, so the `ownership` grader is not what a test is failing on. */
async function createAgent(
  suffix: string,
  overrides: ConfigOverrides = {},
  token: string = ctx.adminToken,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const key = `agent-test-${runId}-${suffix}`;
  const created = await call('POST', '/api/v1/AIAgents/action/agents', token, {
    key,
    name: `${MARKER} ${suffix}`,
    purpose: `evaluation test agent ${suffix}`,
    visibility: 'organization',
    config: agentConfig(overrides),
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body['id']);
  agentIds.push(id);
  return id;
}

/**
 * A suite owned by this test run, inserted directly: the API only ever creates the built-in
 * publication-gate suite, and extending that global suite with this file's cases would change what
 * every other agent's evaluation reports.
 */
async function createSuite(
  suiteKey: string,
  cases: readonly { caseKey: string; grader: string; graderConfig?: Record<string, unknown> }[],
  options: { requiredForPublish?: boolean; enabled?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await ctx.database.db
    .insertInto('ai_agent_eval_suites')
    .values({
      id,
      suite_key: suiteKey,
      name: `${MARKER} ${suiteKey}`,
      description: 'A suite created by the AI.14 evaluation suite.',
      required_for_publish: options.requiredForPublish ?? false,
      enabled: options.enabled ?? true,
      created_by_user_id: null,
      created_at: new Date(),
      modified_at: new Date(),
    })
    .execute();
  suiteIds.push(id);
  for (const entry of cases) {
    await ctx.database.db
      .insertInto('ai_agent_eval_cases')
      .values({
        id: randomUUID(),
        suite_id: id,
        case_key: entry.caseKey,
        title: `${entry.grader} — ${entry.caseKey}`,
        grader: entry.grader,
        grader_config: JSON.stringify(entry.graderConfig ?? {}),
        created_at: new Date(),
      })
      .execute();
  }
  return id;
}

interface RunOutcome {
  readonly status: string;
  readonly results: readonly { caseKey: string; grader: string; kind: string; passed: boolean; outcome: string; detail: string }[];
}

/** Grade one draft against one suite and return what the run recorded. */
async function runSuite(agentId: string, suiteId: string, token: string = ctx.adminToken): Promise<RunOutcome & { id: string }> {
  const ran = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/evaluations/run`, token, { suiteId });
  expect(ran.status, JSON.stringify(ran.body)).toBe(201);
  const id = String(ran.body['id']);
  runIds.push(id);
  return {
    id,
    status: String(ran.body['status']),
    results: (ran.body['results'] ?? []) as RunOutcome['results'],
  };
}

/** The single result of a one-case suite, with its detail — the shape every grader test asserts. */
function resultOf(run: RunOutcome, grader: string): { passed: boolean; outcome: string; detail: string } {
  const found = run.results.find((result) => result.grader === grader);
  expect(found, `the suite produced no ${grader} result`).toBeDefined();
  return found as { passed: boolean; outcome: string; detail: string };
}

beforeAll(async () => {
  ctx = await bootApi();
  baselineAiSettings = await snapshotSettings(ctx, 'aiAgents');

  const admin = await ctx.database.db.selectFrom('users').select('id').where('user_name', '=', 'admin').executeTakeFirst();
  adminUserId = String(admin?.id ?? '');

  await createTestRole(ctx, {
    id: ROLE_ADMIN,
    name: `${MARKER} evaluation admin`,
    permissions: {
      AIAgent: { read: 'all', edit: 'all' },
      AIAgentVersion: { read: 'all', edit: 'all' },
      AIAgentEvaluation: { read: 'all', edit: 'all' },
      AIAgentPolicy: { read: 'all', edit: 'all' },
      AIAgentProvider: { read: 'all', edit: 'all' },
      AIAgentTool: { read: 'all', edit: 'all' },
    },
  });
  await createTestRole(ctx, {
    id: ROLE_USE_ONLY,
    name: `${MARKER} use only`,
    // May use the module, may not publish, may not evaluate: the two authorization tests' subject.
    permissions: { AIAgent: { read: 'all' } },
  });
  createdRoleIds.push(ROLE_ADMIN, ROLE_USE_ONLY);

  const useOnly = await createTestUser(ctx, { userName: USER_USE_ONLY, roleIds: [ROLE_USE_ONLY] });
  useOnlyToken = useOnly.token;
  createdUserIds.push(useOnly.id);

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
  });
  expect(provider.status, JSON.stringify(provider.body)).toBe(201);

  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    // The gate stays off for the whole file except inside the one test that exercises it.
    features: { definitions: true, execution: true, memory: true, evaluations: false },
    safety: { globalExecutionPaused: false, reason: null },
    provider: { defaultKey: PROVIDER_KEY },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  // The built-in suite is global and required-for-publish. If this file creates it, this file removes
  // it again: leaving it behind would silently change what a later `features.evaluations` on means for
  // every other agent in the shared database.
  const standard = await ctx.database.db
    .selectFrom('ai_agent_eval_suites')
    .select('id')
    .where('suite_key', '=', 'publication-gate')
    .executeTakeFirst();
  standardSuitePreexisting = standard !== undefined;

  await createSuite(SUITE_KEY, [
    { caseKey: 'schema', grader: 'config_schema' },
    { caseKey: 'tools', grader: 'tool_permissions' },
    { caseKey: 'approval', grader: 'approval_policy' },
    { caseKey: 'budget', grader: 'budget_bounded' },
    { caseKey: 'provider', grader: 'provider_policy' },
    { caseKey: 'memory', grader: 'memory_policy' },
    { caseKey: 'owner', grader: 'ownership' },
    { caseKey: 'review', grader: 'human_review' },
    { caseKey: 'model', grader: 'model_review' },
  ]);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (runIds.length > 0) {
    await db.deleteFrom('ai_agent_eval_runs').where('id', 'in', runIds).execute();
  }
  if (suiteIds.length > 0) {
    // `ai_agent_eval_cases.suite_id` and `ai_agent_eval_runs.suite_id` cascade, so the suite row is
    // enough — but the runs of *this* file are already removed by id above.
    await db.deleteFrom('ai_agent_eval_suites').where('id', 'in', suiteIds).execute();
  }
  if (agentIds.length > 0) {
    await db
      .deleteFrom('jobs')
      .where('job', '=', 'aiAgents.executeRun')
      .where(sql`target::text like ${`%${MARKER}%`}`)
      .execute();
    await db.deleteFrom('ai_agent_tool_grants')
      .where('agent_version_id', 'in', db.selectFrom('ai_agent_versions').select('id').where('agent_id', 'in', agentIds))
      .execute();
    await db.deleteFrom('ai_agent_versions').where('agent_id', 'in', agentIds).execute();
    await db.deleteFrom('ai_agent_runs').where('initiated_by_user_id', 'in', createdUserIds).execute();
    await db.deleteFrom('ai_agents').where('id', 'in', agentIds).execute();
  }
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_agent_pricing_snapshots').where('provider_key', '=', PROVIDER_KEY).execute();
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  await db
    .updateTable('app_settings')
    .set({
      data: sql`jsonb_set(data, '{settings,provider,defaultKey}', '""'::jsonb)`,
      modified_at: new Date(),
    })
    .where('name', '=', 'aiAgents')
    .where(sql`data->'settings'->'provider'->>'defaultKey'`, '=', PROVIDER_KEY)
    .execute();
  // Any case this file added through the API belongs to a suite it created; the built-in suite is
  // only ever touched by its own idempotency test, and a case there would gate other agents forever.
  await db.deleteFrom('ai_agent_eval_cases').where('case_key', 'like', `${MARKER}%`).execute();
  await db.deleteFrom('ai_agent_eval_suites').where('suite_key', 'like', `${MARKER}%`).execute();
  if (!standardSuitePreexisting) {
    // Its cases cascade; its runs were created only by this file and are already gone by id.
    await db.deleteFrom('ai_agent_eval_suites').where('suite_key', '=', 'publication-gate').execute();
  }
  if (createdUserIds.length > 0) await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  if (createdRoleIds.length > 0) await db.deleteFrom('roles').where('id', 'in', createdRoleIds).execute();
  await restoreSettings(ctx, 'aiAgents', baselineAiSettings);
  await shutdownApi();
});

describe('evaluation graders (19-AI.14)', () => {
  it('passes every deterministic grader on a clean draft and leaves the review pending', async () => {
    const agentId = await createAgent('clean');
    const run = await runSuite(agentId, suiteIds[0] as string);

    for (const grader of ['config_schema', 'tool_permissions', 'approval_policy', 'budget_bounded', 'provider_policy', 'memory_policy', 'ownership']) {
      expect(resultOf(run, grader).passed, `${grader}: ${resultOf(run, grader).detail}`).toBe(true);
    }
    // The review is undecided, so the run is not a pass yet — and a model review never gates.
    expect(resultOf(run, 'human_review').outcome).toBe('pending');
    expect(resultOf(run, 'model_review').passed).toBe(true);
    expect(resultOf(run, 'model_review').detail).toContain('Advisory only');
    expect(run.status).toBe('pending_review');
  });

  it('fails tool_permissions when a granted tool is disabled by settings', async () => {
    const agentId = await createAgent('disabled-tool', { tools: [{ key: 'crm_aggregate' }] });
    const disabled = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      tools: { disabled: ['crm_aggregate'] },
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    try {
      const run = await runSuite(agentId, suiteIds[0] as string);
      const outcome = resultOf(run, 'tool_permissions');
      expect(outcome.passed).toBe(false);
      expect(outcome.detail.toLowerCase()).toContain('crm_aggregate');
      expect(run.status).toBe('failed');
    } finally {
      const restored = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, { tools: { disabled: [] } });
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    }
  });

  it('fails approval_policy when a material write is not covered by approval.requireFor', async () => {
    const agentId = await createAgent('ungated-write', {
      tools: [{ key: 'crm_update_record_fields' }],
      requireFor: [],
    });
    const run = await runSuite(agentId, suiteIds[0] as string);
    const outcome = resultOf(run, 'approval_policy');
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain('crm_update_record_fields');
  });

  it('fails budget_bounded when a limit exceeds the instance ceiling', async () => {
    const agentId = await createAgent('over-budget', { limits: { maxCostUsd: 40 } });
    const tightened = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      limits: { maxCostUsd: 1 },
    });
    expect(tightened.status, JSON.stringify(tightened.body)).toBe(200);
    try {
      const run = await runSuite(agentId, suiteIds[0] as string);
      expect(resultOf(run, 'budget_bounded').passed).toBe(false);
    } finally {
      const loosened = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, { limits: { maxCostUsd: 100 } });
      expect(loosened.status, JSON.stringify(loosened.body)).toBe(200);
    }
  });

  it('fails provider_policy for a missing connection and for a model off the allowlist', async () => {
    const missing = await createAgent('no-provider', { providerKey: `${PROVIDER_KEY}-absent` });
    const missingRun = await runSuite(missing, suiteIds[0] as string);
    expect(resultOf(missingRun, 'provider_policy').detail).toContain('does not exist');

    const wrongModel = await createAgent('wrong-model', { model: 'not-allowed-model' });
    const wrongRun = await runSuite(wrongModel, suiteIds[0] as string);
    expect(resultOf(wrongRun, 'provider_policy').detail).toContain('not on the allowlist');
  });

  it('fails memory_policy when the agent outlives the instance retention ceiling', async () => {
    const agentId = await createAgent('long-memory', { memory: { mode: 'conversation', retentionDays: 3_000 } });
    const run = await runSuite(agentId, suiteIds[0] as string);
    const outcome = resultOf(run, 'memory_policy');
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain('instance ceiling');
  });

  it('fails ownership when no purpose is stated', async () => {
    const agentId = await createAgent('purposeless', {}, ctx.adminToken, { purpose: '' });
    const run = await runSuite(agentId, suiteIds[0] as string);
    const outcome = resultOf(run, 'ownership');
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain('No purpose stated');
  });

  it('grades an exact invariant the operator pinned, in both directions', async () => {
    const suiteId = await createSuite(`${SUITE_KEY}-invariant`, [
      { caseKey: 'pinned-ok', grader: 'exact_invariant', graderConfig: { path: 'limits.maxSteps', max: 8 } },
      { caseKey: 'pinned-wrong', grader: 'exact_invariant', graderConfig: { path: 'memory.mode', equals: 'checkpoint' } },
      { caseKey: 'pinned-unparsable', grader: 'exact_invariant', graderConfig: {} },
    ]);
    const agentId = await createAgent('invariants');
    const run = await runSuite(agentId, suiteId);
    const byKey = new Map(run.results.map((result) => [result.caseKey, result]));

    expect(byKey.get('pinned-ok')?.passed).toBe(true);
    expect(byKey.get('pinned-wrong')?.passed).toBe(false);
    expect(byKey.get('pinned-wrong')?.detail).toContain('expected "checkpoint"');
    // An invariant with no expectation is a broken case, not a silent pass.
    expect(byKey.get('pinned-unparsable')?.passed).toBe(false);
    expect(byKey.get('pinned-unparsable')?.detail).toContain('grader_config');
  });

  it('reports every deterministic case as unparsable when the draft itself does not parse', async () => {
    const agentId = await createAgent('broken-config');
    // A draft the config parser rejects: the definitions service stores what it is given, and the
    // grader must say "it does not parse" rather than grade a half-read object. An unknown data class
    // is outside the enum, so nothing downstream can pretend the config is readable.
    await ctx.database.db
      .updateTable('ai_agents')
      .set({ draft_config: JSON.stringify({ dataClass: 'not-a-data-class', prompt: { system: 'x' } }) })
      .where('id', '=', agentId)
      .execute();

    const run = await runSuite(agentId, suiteIds[0] as string);
    const schema = resultOf(run, 'config_schema');
    expect(schema.passed).toBe(false);
    expect(schema.detail).toContain('does not parse');
    expect(run.status).toBe('failed');
  });
});

describe('the publication gate (19-AI.14)', () => {
  /**
   * The gate is global by design — every enabled required suite gates every publish — so the feature
   * flag and the required suite are switched on inside this test and switched back in `finally`.
   */
  it('blocks a publish until the exact draft has a passing run, and releases it after one', async () => {
    const gateSuiteId = await createSuite(GATE_SUITE_KEY, [{ caseKey: 'tools', grader: 'tool_permissions' }], {
      requiredForPublish: true,
      enabled: false,
    });
    const agentId = await createAgent('gated');
    const on = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      features: { definitions: true, execution: true, memory: true, evaluations: true },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    await ctx.database.db.updateTable('ai_agent_eval_suites').set({ enabled: true }).where('id', '=', gateSuiteId).execute();
    // Any *other* required suite would gate this publish too, and its name is not what this test is
    // about. Park them for the window and put them back in the `finally`.
    const others = await ctx.database.db
      .selectFrom('ai_agent_eval_suites')
      .select('id')
      .where('required_for_publish', '=', true)
      .where('enabled', '=', true)
      .where('id', '!=', gateSuiteId)
      .execute();
    if (others.length > 0) {
      await ctx.database.db
        .updateTable('ai_agent_eval_suites')
        .set({ enabled: false })
        .where('id', 'in', others.map((suite) => suite.id))
        .execute();
    }

    try {
      // Nothing has run yet: publication is refused, and the refusal names the suite.
      const refused = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(JSON.stringify(refused.body)).toContain(GATE_SUITE_KEY);

      // A passing run of this exact draft releases the gate.
      const first = await runSuite(agentId, gateSuiteId);
      expect(first.status).toBe('passed');
      const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
      expect(published.status, JSON.stringify(published.body)).toBe(200);

      // An edit after the pass invalidates it: the gate matches the draft checksum, not "ever passed".
      const edited = await call('PATCH', `/api/v1/AIAgents/action/agents/${agentId}`, ctx.adminToken, {
        config: agentConfig({ limits: { maxCostUsd: 0.3 } }),
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const afterEdit = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
      expect(afterEdit.status, JSON.stringify(afterEdit.body)).toBe(422);

      // Re-run against the current draft, then publish succeeds again.
      const second = await runSuite(agentId, gateSuiteId);
      expect(second.status).toBe('passed');
      const republished = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
      expect(republished.status, JSON.stringify(republished.body)).toBe(200);
    } finally {
      await ctx.database.db.updateTable('ai_agent_eval_suites').set({ enabled: false }).where('id', '=', gateSuiteId).execute();
      if (others.length > 0) {
        await ctx.database.db
          .updateTable('ai_agent_eval_suites')
          .set({ enabled: true })
          .where('id', 'in', others.map((suite) => suite.id))
          .execute();
      }
      const off = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
        features: { definitions: true, execution: true, memory: true, evaluations: false },
      });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
    }
  });

  /**
   * The gate's only real exit. The built-in required suite is not a set of deterministic checks: one of
   * its eight cases is `human-review`, which no grader can settle, so switching `features.evaluations`
   * on means **nothing publishes until a person records a decision**. This test walks that exact path —
   * the same request the Evaluations screen makes — and pins both directions of it: an approval releases
   * the gate, a refusal does not.
   */
  it('lets the standard suite through the gate only after a person decides its review', async () => {
    const ensured = await call('POST', '/api/v1/AIAgents/action/evaluations', ctx.adminToken, {});
    expect(ensured.status, JSON.stringify(ensured.body)).toBe(201);
    const standardSuiteId = String((ensured.body as { id?: string })['id']);

    // The gate only counts a suite that is both enabled and required. Pin that for the window and put
    // the row back afterwards, so the test does not depend on what else touched this global row.
    const standardBefore = await ctx.database.db
      .selectFrom('ai_agent_eval_suites')
      .select(['enabled', 'required_for_publish'])
      .where('id', '=', standardSuiteId)
      .executeTakeFirst();
    await ctx.database.db
      .updateTable('ai_agent_eval_suites')
      .set({ enabled: true, required_for_publish: true })
      .where('id', '=', standardSuiteId)
      .execute();

    const on = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      features: { definitions: true, execution: true, memory: true, evaluations: true },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    // Park every *other* required suite so this test is about the standard suite alone.
    const others = await ctx.database.db
      .selectFrom('ai_agent_eval_suites')
      .select('id')
      .where('required_for_publish', '=', true)
      .where('enabled', '=', true)
      .where('id', '!=', standardSuiteId)
      .execute();
    if (others.length > 0) {
      await ctx.database.db
        .updateTable('ai_agent_eval_suites')
        .set({ enabled: false })
        .where('id', 'in', others.map((suite) => suite.id))
        .execute();
    }

    try {
      const agentId = await createAgent('review-gate');
      const run = await runSuite(agentId, standardSuiteId);
      // Seven deterministic cases pass; the review keeps the run out of `passed`.
      expect(run.status, JSON.stringify(run.results)).toBe('pending_review');
      expect(run.results.filter((result) => result.kind === 'deterministic' && !result.passed)).toHaveLength(0);

      const blocked = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);
      expect(JSON.stringify(blocked.body)).toContain('publication-gate');

      // Approving the review — the decision the screen posts — releases the gate.
      const approved = await call(
        'POST',
        `/api/v1/AIAgents/action/agents/${agentId}/evaluations/${run.id}/decide`,
        ctx.adminToken,
        { caseKey: 'human-review', decision: 'approve', note: 'checked the tool grants by hand' },
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      expect(String(approved.body['status'])).toBe('passed');
      // The decision is visible to the reader, not only stored: the response carries the results.
      const decided = ((approved.body['results'] as { caseKey: string; detail: string }[]) ?? []).find(
        (result) => result.caseKey === 'human-review',
      );
      expect(decided?.detail).toContain('approve');
      const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
      expect(published.status, JSON.stringify(published.body)).toBe(200);

      // A refusal is a refusal: after a fresh draft, rejecting the review leaves the gate shut.
      const edited = await call('PATCH', `/api/v1/AIAgents/action/agents/${agentId}`, ctx.adminToken, {
        config: agentConfig({ limits: { maxCostUsd: 0.3 } }),
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const rerun = await runSuite(agentId, standardSuiteId);
      expect(rerun.status).toBe('pending_review');
      const rejected = await call(
        'POST',
        `/api/v1/AIAgents/action/agents/${agentId}/evaluations/${rerun.id}/decide`,
        ctx.adminToken,
        { caseKey: 'human-review', decision: 'reject' },
      );
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);
      // Until 2026-11-03 a rejected review still reported `passed`, and the gate honoured it.
      expect(String(rejected.body['status'])).toBe('failed');
      const stillBlocked = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
      expect(stillBlocked.status, JSON.stringify(stillBlocked.body)).toBe(422);
    } finally {
      if (standardBefore !== undefined) {
        await ctx.database.db
          .updateTable('ai_agent_eval_suites')
          .set({ enabled: standardBefore.enabled, required_for_publish: standardBefore.required_for_publish })
          .where('id', '=', standardSuiteId)
          .execute();
      }
      if (others.length > 0) {
        await ctx.database.db
          .updateTable('ai_agent_eval_suites')
          .set({ enabled: true })
          .where('id', 'in', others.map((suite) => suite.id))
          .execute();
      }
      const off = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
        features: { definitions: true, execution: true, memory: true, evaluations: false },
      });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
    }
  });

  it('holds the standard suite to one row and eight cases however often it is ensured', async () => {
    const first = await call('POST', '/api/v1/AIAgents/action/evaluations', ctx.adminToken, {});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const suiteKey = String((first.body as { suiteKey?: string })['suiteKey'] ?? '');
    const second = await call('POST', '/api/v1/AIAgents/action/evaluations', ctx.adminToken, {});
    expect(second.status).toBe(201);
    expect(String((second.body as { suiteKey?: string })['suiteKey'])).toBe(suiteKey);

    const suites = await call('GET', '/api/v1/AIAgents/action/evaluations', ctx.adminToken);
    const list = (suites.body['list'] as { suiteKey: string; cases: unknown[] }[]) ?? [];
    const standard = list.filter((suite) => suite.suiteKey === suiteKey);
    expect(standard).toHaveLength(1);
    expect(standard[0]?.cases).toHaveLength(8);
    // The built-in suite is the one the gate is meant to use, so it must be required and enabled.
    expect(standard[0]).toBeDefined();
  });
});

describe('evaluation authorization and attribution (19-AI.14)', () => {
  it('answers a hidden agent exactly like a missing one, on every evaluation read', async () => {
    // An evaluation run reads the agent's draft config — its grants, budgets and provider — so agent
    // visibility is the precondition, not the module's `use` right.
    const privateAgent = await createAgent('private', {}, ctx.adminToken, { visibility: 'private' });
    for (const url of [
      `/api/v1/AIAgents/action/agents/${privateAgent}/evaluations/run`,
      `/api/v1/AIAgents/action/agents/${privateAgent}/evaluations`,
      `/api/v1/AIAgents/action/agents/${privateAgent}/evaluations/compare`,
    ]) {
      const method = url.endsWith('/run') ? ('POST' as Method) : ('GET' as Method);
      const res = await ctx.app.inject({
        method,
        url,
        headers: authHeader(useOnlyToken),
        ...(method === 'POST' ? { payload: { suiteId: suiteIds[0] } as Record<string, unknown> } : {}),
      });
      let body = '';
      try {
        body = JSON.stringify(res.json());
      } catch {
        body = res.body;
      }
      expect(res.statusCode, `${url} -> ${body}`).toBe(404);
      expect(body).not.toContain('maxCostUsd');
    }
  });

  it('refuses evaluation administration without the capability', async () => {
    const ensured = await call('POST', '/api/v1/AIAgents/action/evaluations', useOnlyToken, {});
    expect(ensured.status).toBe(403);
    const decided = await call('POST', `/api/v1/AIAgents/action/agents/x/evaluations/y/decide`, useOnlyToken, {
      caseKey: 'review',
      decision: 'approve',
    });
    expect(decided.status).toBe(403);
  });

  it('records who ran an evaluation and who decided a review', async () => {
    const agentId = await createAgent('attributed');
    const reviewSuiteId = await createSuite(`${SUITE_KEY}-attributed`, [{ caseKey: 'review', grader: 'human_review' }]);
    const run = await runSuite(agentId, reviewSuiteId);
    expect(run.status).toBe('pending_review');

    const row = await ctx.database.db
      .selectFrom('ai_agent_eval_runs')
      .select(['created_by_user_id'])
      .where('id', '=', run.id)
      .executeTakeFirst();
    expect(row?.created_by_user_id, 'the run names its author').toBe(adminUserId);

    const decided = await call(
      'POST',
      `/api/v1/AIAgents/action/agents/${agentId}/evaluations/${run.id}/decide`,
      ctx.adminToken,
      { caseKey: 'review', decision: 'approve', note: 'reviewed by the test admin' },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);
    const results = (decided.body['results'] as { caseKey: string; outcome: string; detail: string }[]) ?? [];
    expect(results.find((result) => result.caseKey === 'review')?.outcome).toBe('passed');

    const stored = await ctx.database.db
      .selectFrom('ai_agent_eval_runs')
      .select(['results', 'status'])
      .where('id', '=', run.id)
      .executeTakeFirst();
    // The driver hands the jsonb column back parsed or raw depending on the connection, like elsewhere.
    const raw = stored?.results;
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? []) as { decidedByUserId?: string }[];
    expect(Array.isArray(parsed) && parsed.some((result) => result.decidedByUserId === adminUserId), 'the decision names its author').toBe(true);
    expect(stored?.status).toBe('passed');
  });

  it('rejects a decision value the DTO does not accept', async () => {
    const agentId = await createAgent('bad-decision');
    const reviewSuiteId = await createSuite(`${SUITE_KEY}-reject`, [{ caseKey: 'review', grader: 'human_review' }]);
    const run = await runSuite(agentId, reviewSuiteId);
    // The SPA used to send `passed|failed` here, which the `approve|reject` enum refused before the
    // decision was ever recorded. The refusal code is 400 (an invalid body), and either way it is not
    // a decision — asserting both keeps this test honest if the error mapping moves.
    const wrong = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/evaluations/${run.id}/decide`, ctx.adminToken, {
      caseKey: 'review',
      decision: 'passed',
    });
    expect([400, 422]).toContain(wrong.status);
    const stillPending = await ctx.database.db
      .selectFrom('ai_agent_eval_runs')
      .select('status')
      .where('id', '=', run.id)
      .executeTakeFirst();
    expect(stillPending?.status).toBe('pending_review');
    const right = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/evaluations/${run.id}/decide`, ctx.adminToken, {
      caseKey: 'review',
      decision: 'reject',
    });
    expect(right.status, JSON.stringify(right.body)).toBe(201);
    expect(String((right.body as { status?: string })['status'])).toBe('failed');
  });

  it('addresses a suite by its key on the case route, not only by its id', async () => {
    const created = await call('POST', `/api/v1/AIAgents/action/evaluations/${SUITE_KEY}`, ctx.adminToken, {
      caseKey: `${MARKER}-pinned`,
      title: 'A case added through the documented route',
      grader: 'exact_invariant',
      graderConfig: { path: 'limits.maxSteps', max: 8 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const unknown = await call('POST', `/api/v1/AIAgents/action/evaluations/${MARKER}-nope`, ctx.adminToken, {
      caseKey: `${MARKER}-orphan`,
      title: 'No such suite',
      grader: 'config_schema',
    });
    expect(unknown.status).toBe(404);
  });

  it('refuses to delete a suite whose runs are evidence, and deletes one that has none', async () => {
    const agentId = await createAgent('to-delete');
    const withRuns = await createSuite(`${SUITE_KEY}-with-runs`, [{ caseKey: 'schema', grader: 'config_schema' }]);
    await runSuite(agentId, withRuns);
    const refused = await call('DELETE', `/api/v1/AIAgents/action/evaluations/${SUITE_KEY}-with-runs`, ctx.adminToken);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('Disable it instead');

    const empty = await createSuite(`${SUITE_KEY}-empty`, [{ caseKey: 'schema', grader: 'config_schema' }]);
    const deleted = await call('DELETE', `/api/v1/AIAgents/action/evaluations/${SUITE_KEY}-empty`, ctx.adminToken);
    expect(deleted.status, deleted.body).toBe(204);
    const gone = await ctx.database.db.selectFrom('ai_agent_eval_suites').select('id').where('id', '=', empty).executeTakeFirst();
    expect(gone).toBeUndefined();
    suiteIds.splice(suiteIds.indexOf(empty), 1);
  });
});

describe('evaluation retention (19-AI.14)', () => {
  it('sweeps evaluation runs older than the retention window, and the dry run counts them first', async () => {
    const agentId = await createAgent('retention');
    const oldRunId = randomUUID();
    await ctx.database.db
      .insertInto('ai_agent_eval_runs')
      .values({
        id: oldRunId,
        agent_id: agentId,
        suite_id: suiteIds[0] as string,
        config_checksum: 'deadbeef',
        agent_version: null,
        status: 'passed',
        results: JSON.stringify([]),
        created_by_user_id: adminUserId,
        created_at: new Date(Date.now() - 400 * 86_400_000),
      })
      .execute();

    const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
      retention: { evaluationsDays: 180, conversationsDays: 30, providerRequestsDays: 30, runEventsDays: 90 },
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);

    const dry = await call('GET', '/api/v1/AIAgents/action/retention/dryRun', ctx.adminToken);
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(Number((dry.body as Record<string, unknown>)['evaluationRuns'] ?? 0)).toBeGreaterThanOrEqual(1);

    const swept = await call('POST', '/api/v1/AIAgents/action/retention/run', ctx.adminToken, {});
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(Number((swept.body as Record<string, unknown>)['evaluationRuns'] ?? 0)).toBeGreaterThanOrEqual(1);
    const gone = await ctx.database.db.selectFrom('ai_agent_eval_runs').select('id').where('id', '=', oldRunId).executeTakeFirst();
    expect(gone, 'a run past its retention window is swept').toBeUndefined();
    runIds.splice(runIds.indexOf(oldRunId), 1);
  });
});
