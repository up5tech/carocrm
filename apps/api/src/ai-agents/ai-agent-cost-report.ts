/**
 * Phase 25.10 — installation-level cost and usage visibility
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §16 "Installation-Level Cost and Usage Visibility").
 *
 * ## What this is
 *
 * The useful half of a billing breakdown without a billing product: **which agent, which trigger,
 * which model spent what, over which window** — for one installation, in the currency the operator
 * already maintains price cards in. There is no credit balance, no per-seat allowance and no
 * payment flow anywhere near it (plan §0.1: "Phase 25 makes those visible, it does not invent a
 * currency").
 *
 * ## The one ledger
 *
 * The numbers come from the two tables the module has always owned — `ai_agent_runs` (run counters,
 * trigger) and `ai_agent_provider_requests` (the priced provider ledger). This module is a **read
 * model over them**, not a second store: nothing here is written, and no new table is introduced.
 *
 * Each dimension is counted from exactly one source, so a call is never double-counted (the same
 * rule the quota service uses, §12.3):
 *
 *  - runs, model calls, tool calls and tokens come from the run counters;
 *  - cost comes from the provider ledger, which is the only place a **priced** figure exists — the
 *    run counter mirrors it after reconciliation, but the ledger is the source of record;
 *  - requests, failures and latency come from the provider ledger.
 *
 * A ledger row is attributed to an agent through its `agent_id` and to a trigger through its
 * `run_id`. A row the gateway could not attribute (a connectivity check has no run, an older row
 * has no agent) still counts towards the **installation total** — it is never silently dropped, and
 * it never inflates an agent's or a trigger's row. A request whose run lies outside the window
 * (a run that crossed a month boundary) has no trigger in that window either; its agent is still
 * known, because the ledger carries the agent id.
 *
 * ## Cost labels
 *
 * The label says what the money is, exactly as the ledger-honest read-out always has (§12.1):
 *
 *  - `estimate` — at least one row was priced from an admin-maintained price card;
 *  - `none` — the group has traffic but no price data, so the figure is an exact `0`, not a guess;
 *  - `unknown` — a provider-ledger write was dropped in this group (§19-AI.24), so the total may
 *    understate what was really spent. The label never claims a confident number it does not have.
 */

export type CostLabel = 'estimate' | 'none' | 'unknown';

/** One run row, already narrowed to the report window. */
export interface CostReportRunRow {
  readonly id: string;
  readonly agentId: string;
  readonly trigger: string;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One provider-ledger row, already narrowed to the report window. */
export interface CostReportLedgerRow {
  readonly runId: string | null;
  readonly agentId: string | null;
  readonly providerKey: string;
  readonly model: string;
  readonly outcome: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly costUsd: number | null;
}

/** A dropped ledger write (§19-AI.24) — the run it belongs to, so it can be attributed. */
export interface CostReportDroppedWrite {
  readonly runId: string | null;
}

/** The agent identity behind a row: identifiers and a display name, never credentials. */
export interface CostReportAgentInfo {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** The price card in force for a (provider, model) pair, from the admin-maintained snapshots. */
export interface CostReportPriceCard {
  readonly id: string;
  readonly providerKey: string;
  readonly model: string;
  readonly currency: string;
  readonly inputPricePerMillion: number;
  readonly outputPricePerMillion: number;
  readonly cachedInputPricePerMillion: number;
}

export interface CostReportWindow {
  /** The period token as asked for (`this_month`, `rolling:30d`, `all`). */
  readonly token: string;
  /** A short stable label (`2026-11`, `last 30 days`, `all time`). */
  readonly label: string;
  /** Inclusive start, ISO-8601 UTC; `null` for the unbounded `all` window. */
  readonly from: string | null;
  /** Exclusive end, ISO-8601 UTC; `null` for the unbounded `all` window. */
  readonly to: string | null;
  /** The zone the calendar arithmetic ran in. */
  readonly timezone: string;
}

export interface CostReportTotals {
  readonly runs: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tokens: number;
  readonly requests: number;
  readonly failures: number;
  readonly estimatedCostUsd: number;
  readonly costLabel: CostLabel;
  /** Provider-ledger writes the gateway had to drop; each one may understate the cost. */
  readonly ledgerWriteFailures: number;
}

export interface CostReportAgentRow {
  readonly agentId: string;
  readonly agentKey: string;
  readonly agentName: string;
  readonly runs: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly requests: number;
  readonly failures: number;
  readonly estimatedCostUsd: number;
  readonly costLabel: CostLabel;
}

export interface CostReportTriggerRow {
  readonly trigger: string;
  readonly runs: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly estimatedCostUsd: number;
  readonly costLabel: CostLabel;
}

/** One provider/model pair — the "which model" half of the breakdown. */
export interface CostReportModelRow {
  readonly providerKey: string;
  readonly model: string;
  readonly requests: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tokens: number;
  readonly averageLatencyMs: number;
  readonly estimatedCostUsd: number;
  readonly costLabel: CostLabel;
  /** The price card the estimate came from, when one is configured. */
  readonly priceCard: CostReportPriceCard | null;
}

export interface CostReport {
  readonly window: CostReportWindow;
  readonly totals: CostReportTotals;
  readonly byAgent: readonly CostReportAgentRow[];
  readonly byTrigger: readonly CostReportTriggerRow[];
  readonly byProvider: readonly CostReportModelRow[];
}

export interface CostReportInput {
  readonly window: CostReportWindow;
  readonly runs: readonly CostReportRunRow[];
  readonly ledger: readonly CostReportLedgerRow[];
  readonly droppedWrites: readonly CostReportDroppedWrite[];
  readonly agents: readonly CostReportAgentInfo[];
  readonly priceCards?: readonly CostReportPriceCard[] | undefined;
}

interface MutableAgentRow {
  agentId: string;
  agentKey: string;
  agentName: string;
  runs: number;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  requests: number;
  failures: number;
  estimatedCostUsd: number;
  pricedRequests: number;
  droppedWrites: number;
}

interface MutableTriggerRow {
  trigger: string;
  runs: number;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  estimatedCostUsd: number;
  pricedRequests: number;
  droppedWrites: number;
}

interface MutableModelRow {
  providerKey: string;
  model: string;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  latencyTotal: number;
  estimatedCostUsd: number;
  pricedRequests: number;
  droppedWrites: number;
}

/**
 * The whole read model as one pure function: rows in, report out.
 *
 * It is pure on purpose — the aggregation rules (which source owns which dimension, how a cost is
 * attributed, when a label is `unknown`) are the part worth testing without a database.
 */
export function aggregateCostReport(input: CostReportInput): CostReport {
  const agentNames = new Map(input.agents.map((agent) => [agent.id, agent]));
  const runTrigger = new Map(input.runs.map((run) => [run.id, run.trigger]));
  const runAgent = new Map(input.runs.map((run) => [run.id, run.agentId]));

  const byAgent = new Map<string, MutableAgentRow>();
  const byTrigger = new Map<string, MutableTriggerRow>();
  const byModel = new Map<string, MutableModelRow>();

  const agentRow = (agentId: string): MutableAgentRow => {
    const existing = byAgent.get(agentId);
    if (existing !== undefined) return existing;
    const info = agentNames.get(agentId);
    const created: MutableAgentRow = {
      agentId,
      agentKey: info?.key ?? '',
      agentName: info?.name ?? '',
      runs: 0,
      modelCalls: 0,
      toolCalls: 0,
      tokens: 0,
      requests: 0,
      failures: 0,
      estimatedCostUsd: 0,
      pricedRequests: 0,
      droppedWrites: 0,
    };
    byAgent.set(agentId, created);
    return created;
  };

  const triggerRow = (trigger: string): MutableTriggerRow => {
    const existing = byTrigger.get(trigger);
    if (existing !== undefined) return existing;
    const created: MutableTriggerRow = {
      trigger,
      runs: 0,
      modelCalls: 0,
      toolCalls: 0,
      tokens: 0,
      estimatedCostUsd: 0,
      pricedRequests: 0,
      droppedWrites: 0,
    };
    byTrigger.set(trigger, created);
    return created;
  };

  const modelRow = (providerKey: string, model: string): MutableModelRow => {
    const key = `${providerKey} ${model}`;
    const existing = byModel.get(key);
    if (existing !== undefined) return existing;
    const created: MutableModelRow = {
      providerKey,
      model,
      requests: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyTotal: 0,
      estimatedCostUsd: 0,
      pricedRequests: 0,
      droppedWrites: 0,
    };
    byModel.set(key, created);
    return created;
  };

  let modelCalls = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const run of input.runs) {
    const agent = agentRow(run.agentId);
    agent.runs += 1;
    agent.modelCalls += run.modelCalls;
    agent.toolCalls += run.toolCalls;
    agent.tokens += run.inputTokens + run.outputTokens;

    const trigger = triggerRow(run.trigger);
    trigger.runs += 1;
    trigger.modelCalls += run.modelCalls;
    trigger.toolCalls += run.toolCalls;
    trigger.tokens += run.inputTokens + run.outputTokens;

    modelCalls += run.modelCalls;
    toolCalls += run.toolCalls;
    inputTokens += run.inputTokens;
    outputTokens += run.outputTokens;
  }

  let requests = 0;
  let failures = 0;
  let estimatedCostUsd = 0;
  let pricedRequests = 0;
  for (const row of input.ledger) {
    const model = modelRow(row.providerKey, row.model);
    model.requests += 1;
    if (row.outcome === 'failed') {
      model.failures += 1;
      failures += 1;
    }
    model.inputTokens += row.inputTokens;
    model.outputTokens += row.outputTokens;
    model.latencyTotal += row.latencyMs;
    if (row.costUsd !== null) {
      model.estimatedCostUsd += row.costUsd;
      model.pricedRequests += 1;
      estimatedCostUsd += row.costUsd;
      pricedRequests += 1;
    }

    requests += 1;
    if (row.agentId !== null) {
      const agent = agentRow(row.agentId);
      agent.requests += 1;
      if (row.outcome === 'failed') agent.failures += 1;
      if (row.costUsd !== null) {
        agent.estimatedCostUsd += row.costUsd;
        agent.pricedRequests += 1;
      }
    }

    const triggerName = row.runId === null ? undefined : runTrigger.get(row.runId);
    if (triggerName !== undefined) {
      const trigger = triggerRow(triggerName);
      if (row.costUsd !== null) {
        trigger.estimatedCostUsd += row.costUsd;
        trigger.pricedRequests += 1;
      }
    }
  }

  // A dropped ledger write belongs to a run, so it can be attributed to that run's agent and
  // trigger. The money it would have carried is unknown — which is exactly what `unknown` says.
  for (const dropped of input.droppedWrites) {
    const agentId = dropped.runId === null ? undefined : runAgent.get(dropped.runId);
    if (agentId !== undefined) agentRow(agentId).droppedWrites += 1;
    const triggerName = dropped.runId === null ? undefined : runTrigger.get(dropped.runId);
    if (triggerName !== undefined) triggerRow(triggerName).droppedWrites += 1;
  }

  const droppedWrites = input.droppedWrites.length;
  const totals: CostReportTotals = {
    runs: input.runs.length,
    modelCalls,
    toolCalls,
    inputTokens,
    outputTokens,
    tokens: inputTokens + outputTokens,
    requests,
    failures,
    estimatedCostUsd: roundCost(estimatedCostUsd),
    costLabel: costLabel(pricedRequests, droppedWrites),
    ledgerWriteFailures: droppedWrites,
  };

  const agentRows: CostReportAgentRow[] = [...byAgent.values()]
    .map((row) => ({
      agentId: row.agentId,
      agentKey: row.agentKey,
      agentName: row.agentName,
      runs: row.runs,
      modelCalls: row.modelCalls,
      toolCalls: row.toolCalls,
      tokens: row.tokens,
      requests: row.requests,
      failures: row.failures,
      estimatedCostUsd: roundCost(row.estimatedCostUsd),
      costLabel: costLabel(row.pricedRequests, row.droppedWrites),
    }))
    .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd || right.runs - left.runs);

  const triggerRows: CostReportTriggerRow[] = [...byTrigger.values()]
    .map((row) => ({
      trigger: row.trigger,
      runs: row.runs,
      modelCalls: row.modelCalls,
      toolCalls: row.toolCalls,
      tokens: row.tokens,
      estimatedCostUsd: roundCost(row.estimatedCostUsd),
      costLabel: costLabel(row.pricedRequests, row.droppedWrites),
    }))
    .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd || right.runs - left.runs);

  const modelRows: CostReportModelRow[] = [...byModel.values()]
    .map((row) => ({
      providerKey: row.providerKey,
      model: row.model,
      requests: row.requests,
      failures: row.failures,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      tokens: row.inputTokens + row.outputTokens,
      averageLatencyMs: row.requests === 0 ? 0 : Math.round(row.latencyTotal / row.requests),
      estimatedCostUsd: roundCost(row.estimatedCostUsd),
      costLabel: costLabel(row.pricedRequests, row.droppedWrites),
      priceCard: priceCardFor(input.priceCards ?? [], row.providerKey, row.model),
    }))
    .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd || right.requests - left.requests);

  return {
    window: input.window,
    totals,
    byAgent: agentRows,
    byTrigger: triggerRows,
    byProvider: modelRows,
  };
}

/** `estimate` when something was priced, `unknown` when a ledger write was dropped, else `none`. */
function costLabel(pricedRequests: number, droppedWrites: number): CostLabel {
  if (droppedWrites > 0) return 'unknown';
  return pricedRequests > 0 ? 'estimate' : 'none';
}

/** The exact price card for a model: the exact match wins over the provider wildcard (§12.1). */
function priceCardFor(
  cards: readonly CostReportPriceCard[],
  providerKey: string,
  model: string,
): CostReportPriceCard | null {
  return (
    cards.find((card) => card.providerKey === providerKey && card.model === model) ??
    cards.find((card) => card.providerKey === providerKey && card.model === '*') ??
    null
  );
}

/** Sub-cent noise is rounded away, but the figure is never rounded up into a different number. */
function roundCost(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * The exported view (plan §16 acceptance: "from an exported view").
 *
 * One flat table with a `dimension` column — `total`, `agent`, `trigger`, `model` — so the file
 * opens in any spreadsheet and answers "which agent/model spent what" without a pivot. The window
 * travels on every row, so a concatenated export still says which period it covers.
 */
export function costReportCsv(report: CostReport): string {
  const header = [
    'dimension',
    'key',
    'label',
    'windowFrom',
    'windowTo',
    'runs',
    'modelCalls',
    'toolCalls',
    'tokens',
    'requests',
    'failures',
    'estimatedCostUsd',
    'costLabel',
  ];
  const rows: string[][] = [
    [
      'total',
      'installation',
      'Installation total',
      report.window.from ?? '',
      report.window.to ?? '',
      String(report.totals.runs),
      String(report.totals.modelCalls),
      String(report.totals.toolCalls),
      String(report.totals.tokens),
      String(report.totals.requests),
      String(report.totals.failures),
      formatCost(report.totals.estimatedCostUsd),
      report.totals.costLabel,
    ],
  ];
  for (const row of report.byAgent) {
    rows.push([
      'agent',
      row.agentId,
      row.agentName,
      report.window.from ?? '',
      report.window.to ?? '',
      String(row.runs),
      String(row.modelCalls),
      String(row.toolCalls),
      String(row.tokens),
      String(row.requests),
      String(row.failures),
      formatCost(row.estimatedCostUsd),
      row.costLabel,
    ]);
  }
  for (const row of report.byTrigger) {
    rows.push([
      'trigger',
      row.trigger,
      row.trigger,
      report.window.from ?? '',
      report.window.to ?? '',
      String(row.runs),
      String(row.modelCalls),
      String(row.toolCalls),
      String(row.tokens),
      '',
      '',
      formatCost(row.estimatedCostUsd),
      row.costLabel,
    ]);
  }
  for (const row of report.byProvider) {
    rows.push([
      'model',
      `${row.providerKey}/${row.model}`,
      row.model,
      report.window.from ?? '',
      report.window.to ?? '',
      '',
      '',
      '',
      String(row.tokens),
      String(row.requests),
      String(row.failures),
      formatCost(row.estimatedCostUsd),
      row.costLabel,
    ]);
  }
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** A CSV cell: quoted when it carries a separator, a quote or a line break. */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Money in the export: at most eight decimals, trailing zeros removed, never an exponent. */
function formatCost(value: number): string {
  return roundCost(value)
    .toFixed(8)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}
