import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 25.10 — the soft-limit warning, the hard limit and the redaction of credential data
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §16 tasks 2–4).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row this suite creates
 * carries the run marker and is removed by exact id in `afterAll`; nothing is truncated or
 * recreated. Model calls use the deterministic fake adapter — no billable API, no network.
 *
 * What is proven here:
 *
 *  - the **soft limit warns before the hard limit stops work**: the run that crosses the soft
 *    threshold still runs, and the warning reaches the administrator's inbox;
 *  - the **hard limit is unchanged**: the next run in the same scope is refused with the quota
 *    error, and the refusal is announced as well;
 *  - the **report and its export carry no credential**: the provider connection in this suite has
 *    a credential, and neither the JSON report nor the CSV file contains it.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'b1c2d3e4f5a60718293a4b5c6d7e8f90b1c2d3e4f5a60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_${runId}`;
const PROVIDER_KEY = `agent-test-25-10-${runId}`;
const CREDENTIAL = `AGENT_TEST_credential_${runId}`;

let ctx: ApiContext;
let agentId = '';
let policyId = '';
let baselineSettings: unknown = null;
const runIds: string[] = [];

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

async function notificationsForPolicy(): Promise<{ id: string; data: { dedupKey?: string; severity?: string } }[]> {
  const rows = await ctx.database.db
    .selectFrom('notifications')
    .select(['id', 'data'])
    .where('type', '=', 'AIAgentsQuotaWarning')
    .where(sql`data ->> 'policyId'`, '=', policyId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as { dedupKey?: string; severity?: string },
  }));
}

beforeAll(async () => {
  ctx = await bootApi();
  // Execution is off on a fresh installation (§19.2), so the suite switches it on and puts the
  // shared settings row back in `afterAll`.
  baselineSettings = await snapshotSettings(ctx, 'aiAgents');
  const settings = await call('POST', '/api/v1/AIAgents/action/settings', ctx.adminToken, {
    features: { definitions: true, execution: true, memory: false },
    safety: { globalExecutionPaused: false, reason: null },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  const provider = await call('POST', '/api/v1/AIAgents/action/providers', ctx.adminToken, {
    kind: 'fake',
    key: PROVIDER_KEY,
    label: `${MARKER} provider`,
    baseUrl: 'https://example.com/v1',
    models: ['fake-model'],
    dataClasses: ['internal'],
    // A real credential, so the redaction assertion has something to fail on.
    apiKey: CREDENTIAL,
  });
  expect(provider.status, JSON.stringify(provider.body)).toBe(201);

  const created = await call('POST', '/api/v1/AIAgents/action/agents', ctx.adminToken, {
    key: `agent-test-25-10-${runId}`,
    name: `${MARKER} agent`,
    visibility: 'organization',
    config: {
      provider: { key: PROVIDER_KEY, model: 'fake-model', fallbackModels: [] },
      dataClass: 'internal',
      prompt: { system: 'You are a test agent.' },
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
        maxOutputTokens: 512,
        temperature: 0.2,
      },
      output: { mode: 'text' },
      memory: { mode: 'none' },
      triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
      approval: { requireFor: ['material_write', 'high_impact'] },
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  agentId = String(created.body['id']);

  const published = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/publish`, ctx.adminToken, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  // A soft limit at 50% of three runs: the warning fires on the third run, the hard limit stops
  // the fourth. The scope is this agent alone, so no other suite is affected.
  const policy = await call('POST', '/api/v1/AIAgents/action/quotas', ctx.adminToken, {
    scope: 'agent',
    agentId,
    period: 'day',
    maxRuns: 3,
    warnPercent: 50,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(201);
  policyId = String(policy.body['id']);
});

afterAll(async () => {
  const db = ctx.database.db;
  if (runIds.length > 0) {
    await db.deleteFrom('ai_agent_run_events').where('run_id', 'in', runIds).execute();
    await db.deleteFrom('ai_agent_provider_requests').where('run_id', 'in', runIds).execute();
    await db.deleteFrom('ai_agent_runs').where('id', 'in', runIds).execute();
  }
  // Safety net: a ledger row whose run was already gone keeps a null run id, so the provider key
  // is the second, exact handle on the rows this suite created.
  await db.deleteFrom('ai_agent_provider_requests').where('provider_key', '=', PROVIDER_KEY).execute();
  if (policyId !== '') {
    await db.deleteFrom('ai_agent_budget_policies').where('id', '=', policyId).execute();
  }
  // Only this suite's own notification rows, identified by the policy they name.
  await db
    .deleteFrom('notifications')
    .where('type', '=', 'AIAgentsQuotaWarning')
    .where(sql`data ->> 'policyId'`, '=', policyId)
    .execute();
  if (agentId !== '') {
    await db.deleteFrom('ai_agent_conversations').where('agent_id', '=', agentId).execute();
    await db.deleteFrom('ai_agents').where('id', '=', agentId).execute();
  }
  await db.deleteFrom('ai_provider_connections').where('key', '=', PROVIDER_KEY).execute();
  await restoreSettings(ctx, 'aiAgents', baselineSettings);
  await shutdownApi();
});

describe('the soft-limit warning arrives before the hard limit stops work (25.10)', () => {
  it('warns on the run that crosses the threshold and still runs it', async () => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const created = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, ctx.adminToken, {
        input: { text: `Say hello ${String(attempt)}.` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      runIds.push(String(created.body['id']));
      const executed = await call('POST', `/api/v1/AIAgents/action/runs/${String(created.body['id'])}/execute`, ctx.adminToken, {});
      expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    }

    // Two runs used: the threshold (3 × 50% = 1.5) has not been reached yet.
    expect(await notificationsForPolicy()).toHaveLength(0);

    const third = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, ctx.adminToken, {
      input: { text: 'Say hello 3.' },
    });
    // The soft limit is a warning: the run is created and works.
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    runIds.push(String(third.body['id']));
    const executed = await call('POST', `/api/v1/AIAgents/action/runs/${String(third.body['id'])}/execute`, ctx.adminToken, {});
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);

    const warnings = await notificationsForPolicy();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.data.severity).toBe('warning');
  });

  it('still refuses the run once the hard limit is reached', async () => {
    const refused = await call('POST', `/api/v1/AIAgents/action/agents/${agentId}/runs`, ctx.adminToken, {
      input: { text: 'Say hello 4.' },
    });
    expect(refused.status).toBe(422);
    const error = refused.body['error'] as { code?: string; message?: string };
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('quota');

    // The refusal is announced too, so the operator learns why the run stopped.
    const notices = await notificationsForPolicy();
    expect(notices.some((notice) => notice.data.severity === 'critical')).toBe(true);
  });

  it('warns once per period instead of once per run', async () => {
    const notices = await notificationsForPolicy();
    const warnings = notices.filter((notice) => notice.data.dedupKey?.includes(':warning:'));
    const exhausted = notices.filter((notice) => notice.data.dedupKey?.includes(':exhausted:'));
    // The third run crossed the threshold once, and the fourth run was stopped once: the warning
    // is not repeated per run, so a busy installation cannot turn it into a storm.
    expect(warnings).toHaveLength(1);
    expect(exhausted).toHaveLength(1);
  });
});

describe('the report and its export carry no credential (25.10)', () => {
  it('answers which agent/model spent what, over a window', async () => {
    const report = await call('GET', '/api/v1/AIAgents/action/usage?period=this_month', ctx.adminToken);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const view = report.body as {
      window?: { token?: string; from?: string | null };
      totals?: { runs?: number };
      byAgent?: { agentId?: string }[];
      byTrigger?: { trigger?: string }[];
      byProvider?: { providerKey?: string }[];
      warnings?: unknown[];
    };
    expect(view.window?.token).toBe('this_month');
    expect(view.totals?.runs).toBeGreaterThan(0);
    expect((view.byAgent ?? []).some((row) => row.agentId === agentId)).toBe(true);
    expect((view.byTrigger ?? []).some((row) => row.trigger === 'manual')).toBe(true);
    expect((view.byProvider ?? []).some((row) => row.providerKey === PROVIDER_KEY)).toBe(true);
    expect(Array.isArray(view.warnings)).toBe(true);

    // The credential of the provider connection is nowhere in the report.
    const serialized = JSON.stringify(report.body);
    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toMatch(/api[_-]?key/i);
  });

  it('exports the same numbers as a CSV file, without the credential', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/AIAgents/action/usage/export?period=this_month',
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const csv = res.body;
    expect(csv).toContain('dimension,key,label');
    expect(csv).toContain(PROVIDER_KEY);
    expect(csv).not.toContain(CREDENTIAL);
  });

  it('refuses a caller without the usage capability', async () => {
    const denied = await call('GET', '/api/v1/AIAgents/action/usage', 'not-a-token');
    expect(denied.status).toBe(401);
  });
});
