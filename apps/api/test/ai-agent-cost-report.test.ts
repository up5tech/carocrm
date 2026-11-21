import { describe, expect, it } from 'vitest';

import {
  aggregateCostReport,
  costReportCsv,
  type CostReportInput,
} from '../src/ai-agents/ai-agent-cost-report.js';
import { quotaLimitState, quotaPeriodStart } from '../src/ai-agents/ai-agent-quota-limits.js';

/**
 * Phase 25.10 — the cost and usage read-out, tested without a database
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §16 task 4).
 *
 * The aggregation is a pure function, so the rules that matter can be pinned down as literals:
 *
 *  - **which source owns which dimension** — runs and tokens come from the run counters, cost from
 *    the priced provider ledger, so a call is never counted twice;
 *  - **attribution** — a ledger row belongs to an agent and to a trigger; a row that belongs to
 *    neither still counts towards the installation total and never inflates a row;
 *  - **cost labels** — `estimate` (priced), `none` (no price data, an exact zero) and `unknown`
 *    (a dropped ledger write may understate the figure);
 *  - **redaction** — the report carries provider keys and model ids, never credentials;
 *  - **soft-warning timing** — the warning fires at the threshold and never before it, and the
 *    hard limit still refuses the work.
 *
 * No database, no clock and no provider call: the rows are literals and the expectations are
 * literals.
 */

const WINDOW = {
  token: 'this_month',
  label: '2026-11',
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-12-01T00:00:00.000Z',
  timezone: 'UTC',
};

function input(overrides: Partial<CostReportInput> = {}): CostReportInput {
  return {
    window: WINDOW,
    runs: [],
    ledger: [],
    droppedWrites: [],
    agents: [],
    ...overrides,
  };
}

describe('aggregateCostReport — the installation total (25.10)', () => {
  it('counts runs and tokens from the run counters and cost from the priced ledger', () => {
    const report = aggregateCostReport(
      input({
        runs: [
          { id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 2, toolCalls: 1, inputTokens: 100, outputTokens: 50 },
          { id: 'run-2', agentId: 'agent-1', trigger: 'schedule', modelCalls: 1, toolCalls: 0, inputTokens: 20, outputTokens: 10 },
        ],
        ledger: [
          { runId: 'run-1', agentId: 'agent-1', providerKey: 'fake', model: 'fake-1', outcome: 'succeeded', inputTokens: 100, outputTokens: 50, latencyMs: 10, costUsd: 0.002 },
          { runId: 'run-2', agentId: 'agent-1', providerKey: 'fake', model: 'fake-1', outcome: 'failed', inputTokens: 20, outputTokens: 10, latencyMs: 20, costUsd: 0.001 },
        ],
        agents: [{ id: 'agent-1', key: 'helper', name: 'Helper' }],
      }),
    );

    expect(report.totals.runs).toBe(2);
    expect(report.totals.modelCalls).toBe(3);
    expect(report.totals.toolCalls).toBe(1);
    expect(report.totals.tokens).toBe(180);
    expect(report.totals.requests).toBe(2);
    expect(report.totals.failures).toBe(1);
    expect(report.totals.estimatedCostUsd).toBe(0.003);
    expect(report.totals.costLabel).toBe('estimate');
  });

  it('keeps an unattributed ledger row in the installation total but out of every agent row', () => {
    const report = aggregateCostReport(
      input({
        runs: [{ id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 }],
        // A connectivity check: it has no run and no agent, but the tokens were really spent.
        ledger: [
          { runId: 'run-1', agentId: 'agent-1', providerKey: 'fake', model: 'fake-1', outcome: 'succeeded', inputTokens: 10, outputTokens: 5, latencyMs: 5, costUsd: 0.001 },
          { runId: null, agentId: null, providerKey: 'fake', model: 'fake-1', outcome: 'succeeded', inputTokens: 3, outputTokens: 2, latencyMs: 5, costUsd: 0.0005 },
        ],
        agents: [{ id: 'agent-1', key: 'helper', name: 'Helper' }],
      }),
    );

    expect(report.totals.requests).toBe(2);
    expect(report.totals.estimatedCostUsd).toBe(0.0015);
    const agent = report.byAgent.find((row) => row.agentId === 'agent-1');
    expect(agent?.requests).toBe(1);
    expect(agent?.estimatedCostUsd).toBe(0.001);
  });

  it('breaks the cost down by agent, by trigger and by provider/model', () => {
    const report = aggregateCostReport(
      input({
        runs: [
          { id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 },
          { id: 'run-2', agentId: 'agent-2', trigger: 'schedule', modelCalls: 1, toolCalls: 0, inputTokens: 20, outputTokens: 10 },
        ],
        ledger: [
          { runId: 'run-1', agentId: 'agent-1', providerKey: 'fake', model: 'fake-1', outcome: 'succeeded', inputTokens: 10, outputTokens: 5, latencyMs: 10, costUsd: 0.001 },
          { runId: 'run-2', agentId: 'agent-2', providerKey: 'openai', model: 'gpt-4o-mini', outcome: 'succeeded', inputTokens: 20, outputTokens: 10, latencyMs: 30, costUsd: 0.004 },
        ],
        agents: [
          { id: 'agent-1', key: 'helper', name: 'Helper' },
          { id: 'agent-2', key: 'digest', name: 'Digest' },
        ],
      }),
    );

    expect(report.byAgent.map((row) => row.agentName)).toEqual(['Digest', 'Helper']);
    expect(report.byAgent.find((row) => row.agentId === 'agent-2')?.estimatedCostUsd).toBe(0.004);
    expect(report.byTrigger.find((row) => row.trigger === 'schedule')?.estimatedCostUsd).toBe(0.004);
    expect(report.byTrigger.find((row) => row.trigger === 'manual')?.estimatedCostUsd).toBe(0.001);
    expect(report.byProvider.map((row) => `${row.providerKey}/${row.model}`)).toEqual(['openai/gpt-4o-mini', 'fake/fake-1']);
    expect(report.byProvider[0]?.averageLatencyMs).toBe(30);
  });

  it('labels a group without price data `none` instead of inventing a zero', () => {
    const report = aggregateCostReport(
      input({
        runs: [{ id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 }],
        ledger: [{ runId: 'run-1', agentId: 'agent-1', providerKey: 'fake', model: 'fake-1', outcome: 'succeeded', inputTokens: 10, outputTokens: 5, latencyMs: 5, costUsd: null }],
        agents: [{ id: 'agent-1', key: 'helper', name: 'Helper' }],
      }),
    );

    expect(report.totals.estimatedCostUsd).toBe(0);
    expect(report.totals.costLabel).toBe('none');
    expect(report.byProvider[0]?.costLabel).toBe('none');
  });

  it('marks the affected agent and trigger `unknown` when a ledger write was dropped', () => {
    const report = aggregateCostReport(
      input({
        runs: [
          { id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 },
          { id: 'run-2', agentId: 'agent-2', trigger: 'schedule', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 },
        ],
        ledger: [
          { runId: 'run-1', agentId: 'agent-1', providerKey: 'fake', model: 'fake-1', outcome: 'succeeded', inputTokens: 10, outputTokens: 5, latencyMs: 5, costUsd: 0.001 },
        ],
        // 19-AI.24 — the gateway had to drop this ledger write; the money it carried is unknown.
        droppedWrites: [{ runId: 'run-2' }],
        agents: [
          { id: 'agent-1', key: 'helper', name: 'Helper' },
          { id: 'agent-2', key: 'digest', name: 'Digest' },
        ],
      }),
    );

    expect(report.totals.ledgerWriteFailures).toBe(1);
    expect(report.totals.costLabel).toBe('unknown');
    expect(report.byAgent.find((row) => row.agentId === 'agent-2')?.costLabel).toBe('unknown');
    expect(report.byAgent.find((row) => row.agentId === 'agent-1')?.costLabel).toBe('estimate');
    expect(report.byTrigger.find((row) => row.trigger === 'schedule')?.costLabel).toBe('unknown');
  });

  it('attaches the price card in force, preferring the exact model over the wildcard', () => {
    const report = aggregateCostReport(
      input({
        runs: [{ id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 }],
        ledger: [{ runId: 'run-1', agentId: 'agent-1', providerKey: 'openai', model: 'gpt-4o-mini', outcome: 'succeeded', inputTokens: 10, outputTokens: 5, latencyMs: 5, costUsd: 0.001 }],
        agents: [{ id: 'agent-1', key: 'helper', name: 'Helper' }],
        priceCards: [
          { id: 'card-wildcard', providerKey: 'openai', model: '*', currency: 'USD', inputPricePerMillion: 1, outputPricePerMillion: 2, cachedInputPricePerMillion: 0 },
          { id: 'card-exact', providerKey: 'openai', model: 'gpt-4o-mini', currency: 'USD', inputPricePerMillion: 0.15, outputPricePerMillion: 0.6, cachedInputPricePerMillion: 0.075 },
        ],
      }),
    );

    expect(report.byProvider[0]?.priceCard?.id).toBe('card-exact');
    expect(report.byProvider[0]?.priceCard?.inputPricePerMillion).toBe(0.15);
  });

  it('never carries credential material into the report', () => {
    const report = aggregateCostReport(
      input({
        runs: [{ id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 }],
        ledger: [{ runId: 'run-1', agentId: 'agent-1', providerKey: 'openai', model: 'gpt-4o-mini', outcome: 'succeeded', inputTokens: 10, outputTokens: 5, latencyMs: 5, costUsd: 0.001 }],
        agents: [{ id: 'agent-1', key: 'helper', name: 'Helper' }],
        priceCards: [{ id: 'card-1', providerKey: 'openai', model: 'gpt-4o-mini', currency: 'USD', inputPricePerMillion: 0.15, outputPricePerMillion: 0.6, cachedInputPricePerMillion: 0.075 }],
      }),
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/secret|credential|authorization|bearer/i);
    // The identifiers an operator needs are still there.
    expect(report.byProvider[0]?.providerKey).toBe('openai');
    expect(report.byProvider[0]?.model).toBe('gpt-4o-mini');
  });
});

describe('costReportCsv — the exported view (25.10)', () => {
  it('writes one flat table with a dimension column and the window on every row', () => {
    const report = aggregateCostReport(
      input({
        runs: [{ id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 }],
        ledger: [{ runId: 'run-1', agentId: 'agent-1', providerKey: 'fake', model: 'fake-1', outcome: 'succeeded', inputTokens: 10, outputTokens: 5, latencyMs: 5, costUsd: 0.001 }],
        agents: [{ id: 'agent-1', key: 'helper', name: 'Helper' }],
      }),
    );
    const csv = costReportCsv(report);
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe(
      'dimension,key,label,windowFrom,windowTo,runs,modelCalls,toolCalls,tokens,requests,failures,estimatedCostUsd,costLabel',
    );
    expect(lines[1]).toContain('total,installation');
    expect(lines.some((line) => line.startsWith('agent,agent-1'))).toBe(true);
    expect(lines.some((line) => line.startsWith('trigger,manual'))).toBe(true);
    expect(lines.some((line) => line.startsWith('model,fake/fake-1'))).toBe(true);
    // The window travels with every row, so a concatenated export still says what it covers.
    expect(lines[1]).toContain('2026-11-01T00:00:00.000Z');
  });

  it('quotes a label that carries a separator or a quote', () => {
    const report = aggregateCostReport(
      input({
        runs: [{ id: 'run-1', agentId: 'agent-1', trigger: 'manual', modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 }],
        agents: [{ id: 'agent-1', key: 'helper', name: 'Sales, "north"' }],
      }),
    );
    const csv = costReportCsv(report);
    expect(csv).toContain('"Sales, ""north"""');
  });
});

describe('quotaLimitState — the soft-warning timing (25.10)', () => {
  const policy = {
    max_requests: null,
    max_tokens: null,
    max_cost_usd: null,
    max_runs: 3,
    max_concurrent_runs: null,
    warn_percent: 50,
  };
  const usage = (runs: number) => ({ runs, requests: 0, tokens: 0, costUsd: 0, concurrentRuns: 0 });

  it('says nothing before the threshold', () => {
    const state = quotaLimitState(policy, usage(1));
    expect(state.warningDimension).toBeNull();
    expect(state.exhaustedDimension).toBeNull();
  });

  it('warns at the threshold, while the work still runs', () => {
    const state = quotaLimitState(policy, usage(2));
    expect(state.warningDimension).toBe('runs');
    expect(state.warningUsed).toBe(2);
    expect(state.warningLimit).toBe(3);
    // The hard limit is not reached: the warning never refuses work by itself.
    expect(state.exhaustedDimension).toBeNull();
  });

  it('reports the hard limit as reached once the limit is used up', () => {
    const state = quotaLimitState(policy, usage(3));
    expect(state.exhaustedDimension).toBe('runs');
    expect(state.exhaustedUsed).toBe(3);
    expect(state.exhaustedLimit).toBe(3);
    // A fully used limit is no longer a warning: it is a stop.
    expect(state.warningDimension).toBeNull();
  });

  it('never warns when the policy has no soft limit', () => {
    const state = quotaLimitState({ ...policy, warn_percent: null }, usage(2));
    expect(state.warningDimension).toBeNull();
    expect(state.exhaustedDimension).toBeNull();
  });

  it('treats an unbounded dimension as never reached', () => {
    const state = quotaLimitState({ ...policy, max_runs: null, warn_percent: 80 }, usage(9_999));
    expect(state.warningDimension).toBeNull();
    expect(state.exhaustedDimension).toBeNull();
  });

  it('names the cost dimension with its money limit', () => {
    const state = quotaLimitState(
      { ...policy, max_runs: null, max_cost_usd: '1.5', warn_percent: 50 },
      { runs: 0, requests: 0, tokens: 0, costUsd: 0.9, concurrentRuns: 0 },
    );
    expect(state.warningDimension).toBe('costUsd');
    expect(state.warningLimit).toBe(1.5);
  });
});

describe('quotaPeriodStart — the window a warning belongs to', () => {
  it('starts a day at UTC midnight and a month on the 1st', () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    expect(quotaPeriodStart('day', now)?.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(quotaPeriodStart('month', now)?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(quotaPeriodStart('run', now)).toBeNull();
  });
});
