import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import {
  aggregateCostReport,
  type CostReport,
  type CostReportAgentInfo,
  costReportCsv,
  type CostReportDroppedWrite,
  type CostReportLedgerRow,
  type CostReportPriceCard,
  type CostReportRunRow,
  type CostReportWindow,
} from './ai-agent-cost-report.js';
import { resolvePeriod } from './ai-agent-periods.js';
import { AIAgentPricingService } from './ai-agent-pricing.service.js';
import { AIAgentQuotaService } from './ai-agent-quota.service.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';

/**
 * Phase 25.10 — the installation-level cost and usage read-out
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §16).
 *
 * One admin answer to "which agent/model spent what this month", assembled from the two ledgers the
 * module already owns. There is **no second ledger and no billing table**: this service only reads
 * `ai_agent_runs`, `ai_agent_provider_requests` and `ai_agent_run_events`, and it reuses
 * {@link AIAgentPricingService} for the price cards and {@link AIAgentQuotaService} for the
 * soft-limit warnings, so the numbers agree with the rest of the module by construction.
 *
 * The time window is the module's own period grammar (`ai-agent-periods.ts`): the operator asks for
 * `this_month`, `rolling:30d` or `all`, and the range is calendar arithmetic in **their** zone —
 * the same rule the chat tools follow (§19-CHAT.21), so "this month" means the same thing in the
 * report and in an answer.
 *
 * Nothing here can reveal a credential: only provider **keys** and **model ids** are read, and the
 * provider connection table is never joined.
 */

export interface CostReportQuery {
  /** A period token (`this_month`, `rolling:30d`, …) or `all` for the unbounded window. */
  readonly period?: string | undefined;
  /** IANA zone; defaults to the caller's own zone. */
  readonly timezone?: string | undefined;
  /** Narrow the report to one agent. */
  readonly agentId?: string | undefined;
  /** Narrow the report to one trigger type. */
  readonly trigger?: string | undefined;
}

/** A soft-limit warning, as the quota service derives it (never as the report invents it). */
export interface CostReportWarning {
  readonly policyId: string;
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly providerKey: string | null;
  readonly agentId: string | null;
  /** The policy's own period (`day` / `month`) — a soft limit is defined over its own window. */
  readonly period: string;
  readonly warnPercent: number | null;
  /** Which limit crossed the soft threshold, with its numbers. */
  readonly dimension: string | null;
  readonly used: number | null;
  readonly limit: number | null;
  /** A hard limit is reached: new runs in this scope are refused. */
  readonly exhausted: boolean;
}

export interface CostReportView extends CostReport {
  readonly warnings: readonly CostReportWarning[];
}

@Injectable()
export class AIAgentCostReportService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
    @Inject(AIAgentQuotaService) private readonly quotas: AIAgentQuotaService,
    @Inject(AIAgentPricingService) private readonly pricing: AIAgentPricingService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * The report for one window. Read-only: no row is written, no quota is touched, and the hard
   * limits are not re-evaluated here — the quota service owns enforcement (§12.3).
   */
  async report(query: CostReportQuery): Promise<CostReportView> {
    await this.permissions.assert('usage');
    const window = this.window(query);
    const [runs, ledger, droppedWrites, agents, priceCards, quotaStatus] = await Promise.all([
      this.runsIn(window, query),
      this.ledgerIn(window, query),
      this.droppedWritesIn(window),
      this.agents(),
      this.priceCards(),
      this.quotas.status(),
    ]);
    const report = aggregateCostReport({
      window,
      runs,
      ledger,
      droppedWrites,
      agents,
      priceCards,
    });
    return { ...report, warnings: warningsFrom(quotaStatus.list) };
  }

  /**
   * The exported view of the same report (plan §16 acceptance: "and from an exported view").
   * The file carries the same numbers as the screen — one implementation, two renderings.
   */
  async exportCsv(query: CostReportQuery): Promise<{ filename: string; csv: string }> {
    const report = await this.report(query);
    return { filename: exportFilename(report.window), csv: costReportCsv(report) };
  }

  /**
   * The report window. `all` is the unbounded window (the whole installation so far); every other
   * token is resolved by the module's period grammar, which rejects an unknown token or an unknown
   * zone before any query runs.
   */
  private window(query: CostReportQuery): CostReportWindow {
    const token = (query.period ?? 'this_month').trim();
    const requestedZone = (query.timezone ?? this.scope.timezone ?? 'UTC').trim();
    const zone = requestedZone === '' ? 'UTC' : requestedZone;
    if (token === 'all') {
      return { token: 'all', label: 'all time', from: null, to: null, timezone: zone };
    }
    const resolved = resolvePeriod(token, zone, new Date());
    return {
      token: resolved.token,
      label: resolved.label,
      from: resolved.from,
      to: resolved.to,
      timezone: resolved.timezone,
    };
  }

  private async runsIn(window: CostReportWindow, query: CostReportQuery): Promise<CostReportRunRow[]> {
    let builder = this.database.db
      .selectFrom('ai_agent_runs')
      .select(['id', 'agent_id', 'trigger', 'model_call_count', 'tool_call_count', 'input_tokens', 'output_tokens']);
    if (window.from !== null) builder = builder.where('created_at', '>=', new Date(window.from));
    if (window.to !== null) builder = builder.where('created_at', '<', new Date(window.to));
    if (query.agentId !== undefined) builder = builder.where('agent_id', '=', query.agentId);
    if (query.trigger !== undefined) builder = builder.where('trigger', '=', query.trigger);
    const rows = await builder.execute();
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      trigger: row.trigger,
      modelCalls: row.model_call_count,
      toolCalls: row.tool_call_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    }));
  }

  private async ledgerIn(window: CostReportWindow, query: CostReportQuery): Promise<CostReportLedgerRow[]> {
    let builder = this.database.db
      .selectFrom('ai_agent_provider_requests')
      .select([
        'run_id',
        'agent_id',
        'provider_key',
        'model',
        'outcome',
        'input_tokens',
        'output_tokens',
        'latency_ms',
        'estimated_cost_usd',
      ]);
    if (window.from !== null) builder = builder.where('created_at', '>=', new Date(window.from));
    if (window.to !== null) builder = builder.where('created_at', '<', new Date(window.to));
    if (query.agentId !== undefined) {
      builder = builder.where('agent_id', '=', query.agentId);
    }
    if (query.trigger !== undefined) {
      // The trigger lives on the run, so the ledger is narrowed through the runs that carry it. A
      // request with no run (a connectivity check) belongs to no trigger and is left out of a
      // trigger-scoped report — it still counts towards the installation total.
      builder = builder.where('run_id', 'in', (eb) =>
        eb.selectFrom('ai_agent_runs').select('id').where('trigger', '=', query.trigger ?? ''),
      );
    }
    const rows = await builder.execute();
    return rows.map((row) => ({
      runId: row.run_id,
      agentId: row.agent_id,
      providerKey: row.provider_key,
      model: row.model,
      outcome: row.outcome,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      latencyMs: row.latency_ms,
      costUsd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
    }));
  }

  /**
   * The dropped-ledger-write markers of the window (§19-AI.24). Each one names the run it belongs
   * to, so the report can attribute the gap to an agent and a trigger instead of only to the
   * installation.
   */
  private async droppedWritesIn(window: CostReportWindow): Promise<CostReportDroppedWrite[]> {
    let builder = this.database.db
      .selectFrom('ai_agent_run_events')
      .select(['run_id'])
      .where('event_type', '=', 'run.ledger_write_failed');
    if (window.from !== null) builder = builder.where('created_at', '>=', new Date(window.from));
    if (window.to !== null) builder = builder.where('created_at', '<', new Date(window.to));
    const rows = await builder.execute();
    return rows.map((row) => ({ runId: row.run_id }));
  }

  private async agents(): Promise<CostReportAgentInfo[]> {
    const rows = await this.database.db.selectFrom('ai_agents').select(['id', 'agent_key', 'name']).execute();
    return rows.map((row) => ({ id: row.id, key: row.agent_key, name: row.name }));
  }

  private async priceCards(): Promise<CostReportPriceCard[]> {
    const { list } = await this.pricing.list();
    return list.map((card) => ({
      id: card.id,
      providerKey: card.providerKey,
      model: card.model,
      currency: card.currency,
      inputPricePerMillion: card.inputPricePerMillion,
      outputPricePerMillion: card.outputPricePerMillion,
      cachedInputPricePerMillion: card.cachedInputPricePerMillion,
    }));
  }
}

/**
 * The quota service already derives the soft-limit state from the ledger; the report only
 * restates it. A warning names the dimension that crossed the threshold, so the operator sees
 * "tokens 8,000 of 10,000" rather than "something is near a limit".
 */
function warningsFrom(
  policies: readonly {
    id: string;
    scope: string;
    scopeRef: string | null;
    providerKey: string | null;
    agentId: string | null;
    period: string;
    warnPercent: number | null;
    warning: boolean;
    warningDimension: string | null;
    warningUsed: number | null;
    warningLimit: number | null;
    exhausted: boolean;
    exhaustedDimension: string | null;
    exhaustedUsed: number | null;
    exhaustedLimit: number | null;
  }[],
): CostReportWarning[] {
  const out: CostReportWarning[] = [];
  for (const policy of policies) {
    if (!policy.warning && !policy.exhausted) continue;
    const dimension = policy.exhausted ? policy.exhaustedDimension : policy.warningDimension;
    const used = policy.exhausted ? policy.exhaustedUsed : policy.warningUsed;
    const limit = policy.exhausted ? policy.exhaustedLimit : policy.warningLimit;
    out.push({
      policyId: policy.id,
      scope: policy.scope,
      scopeRef: policy.scopeRef,
      providerKey: policy.providerKey,
      agentId: policy.agentId,
      period: policy.period,
      warnPercent: policy.warnPercent,
      dimension,
      used,
      limit,
      exhausted: policy.exhausted,
    });
  }
  return out;
}

/** A file name that says which window it covers: `ai-usage-2026-11.csv`, `ai-usage-all.csv`. */
function exportFilename(window: CostReportWindow): string {
  const label = window.token === 'all' ? 'all' : window.label.replace(/[^0-9A-Za-z-]+/g, '-');
  return `ai-usage-${label}.csv`;
}
