import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '../database/database.service.js';

import { DatabaseService } from '../database/database.service.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';

/**
 * Phase 19-AI.13 — scoped quotas and atomic enforcement
 * (PLAN_Phase_19_AI_Agents.md §12.2 "quota scopes", §12.3 "budget enforcement", §20 `19-AI.13`).
 *
 * The `ai_agent_budget_policies` table ships with migration 045; this service is what makes it
 * mean something:
 *
 *  - `list`/`create`/`remove` administer policies (global, per-user, per-agent, per-provider);
 *  - `assertRunAllowed` runs **inside the run-creation transaction**, locks the matching policy
 *    rows `FOR UPDATE`, re-aggregates usage and refuses before the run row is inserted. Concurrent
 *    creations that share a policy serialize on that lock, so a last available slot cannot be
 *    handed to two runs at once — the §12.3 "enforce limits atomically" requirement;
 *  - per-run limits (steps, tokens, cost, elapsed) are the agent's own §8.3 ceilings and are
 *    enforced inside the run loop, so a `period = 'run'` policy is refused at creation: it would
 *    duplicate a limit the run loop already owns;
 *  - a soft limit (`warnPercent`) never refuses work; it is reported by `status()` so a warning
 *    can surface long before the hard limit stops a run (§12.3).
 *
 * Aggregation reads only module-owned counters (`ai_agent_runs`, `ai_agent_provider_requests`);
 * it never touches another module's tables.
 */
export interface BudgetPolicyView {
  readonly id: string;
  readonly scope: 'global' | 'user' | 'team' | 'agent' | 'provider';
  readonly scopeRef: string | null;
  readonly providerKey: string | null;
  readonly agentId: string | null;
  readonly period: 'day' | 'month';
  readonly maxRequests: number | null;
  readonly maxTokens: string | null;
  readonly maxCostUsd: string | null;
  readonly maxRuns: number | null;
  readonly maxConcurrentRuns: number | null;
  readonly warnPercent: number | null;
  readonly enabled: boolean;
}

export interface BudgetPolicyCreateInput {
  readonly scope: 'global' | 'user' | 'team' | 'agent' | 'provider';
  readonly scopeRef?: string | undefined;
  readonly providerKey?: string | undefined;
  readonly agentId?: string | undefined;
  readonly period: 'day' | 'month';
  readonly maxRequests?: number | null | undefined;
  readonly maxTokens?: number | null | undefined;
  readonly maxCostUsd?: number | null | undefined;
  readonly maxRuns?: number | null | undefined;
  readonly maxConcurrentRuns?: number | null | undefined;
  readonly warnPercent?: number | null | undefined;
  readonly enabled?: boolean | undefined;
}

export interface BudgetPolicyStatus extends BudgetPolicyView {
  readonly usage: {
    readonly runs: number;
    readonly requests: number;
    readonly tokens: number;
    readonly costUsd: number;
    readonly concurrentRuns: number;
  };
  /** Usage has reached the soft threshold; the run loop still works. */
  readonly warning: boolean;
  /** A hard limit is reached; new runs in this scope are refused. */
  readonly exhausted: boolean;
}

export interface QuotaCheckInput {
  readonly userId: string;
  readonly agentId: string;
  readonly providerKey: string;
}

@Injectable()
export class AIAgentQuotaService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
  ) {}

  async list(): Promise<{ list: BudgetPolicyView[] }> {
    await this.permissions.assert('usage');
    const rows = await this.database.db
      .selectFrom('ai_agent_budget_policies')
      .selectAll()
      .orderBy('scope', 'asc')
      .orderBy('period', 'asc')
      .execute();
    return { list: rows.map((row) => this.toView(row)) };
  }

  async create(input: BudgetPolicyCreateInput): Promise<BudgetPolicyView> {
    await this.permissions.assert('policyAdmin');
    if (input.scope === 'global' && (input.scopeRef ?? '') !== '') {
      throw new ValidationError('A global policy has no scope reference.');
    }
    if ((input.scope === 'user' || input.scope === 'team') && (input.scopeRef ?? '') === '') {
      throw new ValidationError(`A ${input.scope} policy must name its ${input.scope === 'user' ? 'user' : 'team'} id.`);
    }
    if (input.scope === 'agent' && (input.agentId ?? '') === '') {
      throw new ValidationError('An agent policy must name its agent.');
    }
    if (input.scope === 'provider' && (input.providerKey ?? '') === '') {
      throw new ValidationError('A provider policy must name its provider connection.');
    }
    if (
      [input.maxRequests, input.maxTokens, input.maxCostUsd, input.maxRuns, input.maxConcurrentRuns].every(
        (value) => value === undefined || value === null,
      )
    ) {
      throw new ValidationError('A policy must set at least one limit.');
    }
    if (input.warnPercent !== undefined && input.warnPercent !== null && (input.warnPercent < 1 || input.warnPercent > 100)) {
      throw new ValidationError('The soft limit percentage must be between 1 and 100.');
    }
    const row = {
      id: randomUUID(),
      scope: input.scope,
      scope_ref: input.scopeRef ?? null,
      provider_key: input.providerKey ?? null,
      agent_id: input.agentId ?? null,
      period: input.period,
      max_requests: input.maxRequests ?? null,
      max_tokens: input.maxTokens === undefined || input.maxTokens === null ? null : String(input.maxTokens),
      max_cost_usd: input.maxCostUsd === undefined || input.maxCostUsd === null ? null : String(input.maxCostUsd),
      max_runs: input.maxRuns ?? null,
      max_concurrent_runs: input.maxConcurrentRuns ?? null,
      warn_percent: input.warnPercent ?? null,
      enabled: input.enabled ?? true,
      created_at: new Date(),
      modified_at: new Date(),
    };
    try {
      await this.database.db.insertInto('ai_agent_budget_policies').values(row).execute();
    } catch (error) {
      // The COALESCE unique index is the real guarantee under a concurrent double-submit.
      if (isUniqueViolation(error)) {
        throw new ValidationError('A policy for this scope, target, provider, agent and period already exists.');
      }
      throw error;
    }
    const created = await this.database.db
      .selectFrom('ai_agent_budget_policies')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    return this.toView(created);
  }

  async remove(id: string): Promise<void> {
    await this.permissions.assert('policyAdmin');
    const result = await this.database.db
      .deleteFrom('ai_agent_budget_policies')
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(result.numDeletedRows ?? 0) === 0) throw new NotFoundError(`Budget policy "${id}" does not exist.`);
  }

  /**
   * Current consumption against every applicable enabled policy — the §12.4 admin read-out.
   * Warnings are derived, never stored, so the answer always reflects the ledger.
   */
  async status(): Promise<{ list: BudgetPolicyStatus[] }> {
    await this.permissions.assert('usage');
    const rows = await this.database.db
      .selectFrom('ai_agent_budget_policies')
      .selectAll()
      .where('enabled', '=', true)
      .orderBy('scope', 'asc')
      .orderBy('period', 'asc')
      .execute();
    const list: BudgetPolicyStatus[] = [];
    for (const row of rows) {
      const usage = await this.usageFor(row);
      list.push({
        ...this.toView(row),
        usage,
        warning: this.overThreshold(row, usage),
        exhausted: this.exhausted(row, usage),
      });
    }
    return { list };
  }

  /**
   * Cheap unlocked pre-check. The run service calls it **before** resolving a conversation so a
   * refused run never leaves an empty thread behind; it is a fast path, not the guarantee.
   */
  async assertRunAllowedUnlocked(input: QuotaCheckInput): Promise<void> {
    const policies = await this.matchingPolicies(this.database.db, input, false);
    await this.checkAll(policies, input, this.database.db);
  }

  /**
   * The atomic gate. Called by the run service inside the run-creation transaction with the same
   * transaction handle, so the lock, the aggregate and the insert commit together: two concurrent
   * creations sharing a policy row cannot both observe "one slot left" (§12.3).
   */
  async assertRunAllowed(trx: Db, input: QuotaCheckInput): Promise<void> {
    const policies = await this.matchingPolicies(trx, input, true);
    await this.checkAll(policies, input, trx);
  }

  private async matchingPolicies(db: Db, input: QuotaCheckInput, lock: boolean) {
    let query = db
      .selectFrom('ai_agent_budget_policies')
      .selectAll()
      .where('enabled', '=', true)
      .where('period', 'in', ['day', 'month'])
      .where((eb) =>
        eb.or([
          eb('scope', '=', 'global'),
          eb.and([eb('scope', '=', 'user'), eb('scope_ref', '=', input.userId)]),
          eb.and([eb('scope', '=', 'agent'), eb('agent_id', '=', input.agentId)]),
          eb.and([eb('scope', '=', 'provider'), eb('provider_key', '=', input.providerKey)]),
        ]),
      );
    // Serialize every creation that shares a policy: the aggregate is only meaningful if no
    // concurrent creator can commit between it and the run insert (§12.3).
    if (lock) query = query.forUpdate();
    return query.execute();
  }

  private async checkAll(
    policies: readonly {
      id: string;
      scope: string;
      period: string;
      max_requests: number | null;
      max_tokens: string | null;
      max_cost_usd: string | null;
      max_runs: number | null;
      max_concurrent_runs: number | null;
      scope_ref: string | null;
      provider_key: string | null;
      agent_id: string | null;
    }[],
    input: QuotaCheckInput,
    db: Db,
  ): Promise<void> {
    for (const policy of policies) {
      const usage = await this.usageFor(policy, db);
      const concurrent = await this.concurrentFor(policy, input, db);
      const merged = { ...usage, concurrentRuns: concurrent };
      if (this.exhausted(policy, merged)) {
        throw new ValidationError(
          `A ${policy.scope} quota stops this run: ${this.describe(policy)} already used ${this.describeUsage(policy, merged)}.`,
          { policyId: policy.id, scope: policy.scope, period: policy.period },
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private periodStart(period: 'run' | 'day' | 'month', now: Date): Date | null {
    if (period === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (period === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return null;
  }

  private async usageFor(
    policy: {
      scope: string;
      scope_ref: string | null;
      provider_key: string | null;
      agent_id: string | null;
      period: string;
    },
    maybeTrx?: Db,
  ): Promise<{ runs: number; requests: number; tokens: number; costUsd: number; concurrentRuns: number }> {
    const db = maybeTrx ?? this.database.db;
    const start = this.periodStart(policy.period as 'run' | 'day' | 'month', new Date());
    const usage = { runs: 0, requests: 0, tokens: 0, costUsd: 0, concurrentRuns: 0 };
    if (start === null) return usage;

    // Each dimension is counted from exactly one source so a call is never double-counted:
    // runs/tokens/cost from the run counters, request count from the provider ledger. A
    // provider-scoped policy has no run rows to filter on (runs carry no provider key), so for
    // that scope the ledger is the single source for every dimension it reports.
    if (policy.scope === 'provider') {
      const ledger = await db
        .selectFrom('ai_agent_provider_requests')
        .select((eb) => [
          eb.fn.countAll<string>().as('requests'),
          eb.fn.sum<number>('input_tokens').as('inputTokens'),
          eb.fn.sum<number>('output_tokens').as('outputTokens'),
          eb.fn.sum<number>('estimated_cost_usd').as('costUsd'),
        ])
        .where('created_at', '>=', start)
        .where('provider_key', '=', policy.provider_key ?? '')
        .executeTakeFirst();
      usage.requests = Number(ledger?.requests ?? 0);
      usage.tokens = Number(ledger?.inputTokens ?? 0) + Number(ledger?.outputTokens ?? 0);
      usage.costUsd = Number(ledger?.costUsd ?? 0);
      usage.concurrentRuns = await this.concurrentFor(policy, undefined, db);
      return usage;
    }

    let runsQuery = db
      .selectFrom('ai_agent_runs')
      .select((eb) => [
        eb.fn.countAll<string>().as('runs'),
        eb.fn.sum<number>('input_tokens').as('inputTokens'),
        eb.fn.sum<number>('output_tokens').as('outputTokens'),
        eb.fn.sum<number>('estimated_cost_usd').as('costUsd'),
      ])
      .where('created_at', '>=', start);
    if (policy.scope === 'user') runsQuery = runsQuery.where('initiated_by_user_id', '=', policy.scope_ref ?? '');
    if (policy.scope === 'agent') runsQuery = runsQuery.where('agent_id', '=', policy.agent_id ?? '');
    if (policy.scope === 'team') {
      runsQuery = runsQuery.where('initiated_by_user_id', 'in', (eb) =>
        eb
          .selectFrom('users_teams')
          .select('user_id')
          .where('team_id', '=', policy.scope_ref ?? ''),
      );
    }
    const runTotals = await runsQuery.executeTakeFirst();
    usage.runs = Number(runTotals?.runs ?? 0);
    usage.tokens = Number(runTotals?.inputTokens ?? 0) + Number(runTotals?.outputTokens ?? 0);
    usage.costUsd = Number(runTotals?.costUsd ?? 0);

    let ledgerQuery = db
      .selectFrom('ai_agent_provider_requests')
      .select((eb) => eb.fn.countAll<string>().as('requests'))
      .where('created_at', '>=', start);
    if (policy.scope === 'agent') {
      ledgerQuery = ledgerQuery.where('agent_id', '=', policy.agent_id ?? '');
      const ledger = await ledgerQuery.executeTakeFirst();
      usage.requests = Number(ledger?.requests ?? 0);
    } else {
      // Ids come from their own query: mixing `id` into the aggregate above would need a GROUP BY.
      let idQuery = db.selectFrom('ai_agent_runs').select(['id']).where('created_at', '>=', start);
      if (policy.scope === 'user') idQuery = idQuery.where('initiated_by_user_id', '=', policy.scope_ref ?? '');
      if (policy.scope === 'agent') idQuery = idQuery.where('agent_id', '=', policy.agent_id ?? '');
      if (policy.scope === 'team') {
        idQuery = idQuery.where('initiated_by_user_id', 'in', (eb) =>
          eb
            .selectFrom('users_teams')
            .select('user_id')
            .where('team_id', '=', policy.scope_ref ?? ''),
        );
      }
      const runIds = await idQuery.execute();
      // An empty `in ()` is invalid SQL; zero runs means zero ledger rows by definition.
      if (runIds.length === 0) {
        usage.requests = 0;
      } else {
        const ledger = await ledgerQuery
          .where(
            'run_id',
            'in',
            runIds.map((row) => row.id),
          )
          .executeTakeFirst();
        usage.requests = Number(ledger?.requests ?? 0);
      }
    }
    usage.concurrentRuns = await this.concurrentFor(policy, undefined, db);
    return usage;
  }

  /** Active (non-terminal, non-waiting) runs matching a policy's scope. */
  private async concurrentFor(
    policy: { scope: string; scope_ref: string | null; provider_key: string | null; agent_id: string | null },
    input: QuotaCheckInput | undefined,
    db: Db,
  ): Promise<number> {
    let query = db
      .selectFrom('ai_agent_runs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', 'in', ['queued', 'running', 'retry_wait', 'cancel_requested']);
    if (policy.scope === 'user') query = query.where('initiated_by_user_id', '=', policy.scope_ref ?? '');
    if (policy.scope === 'agent') query = query.where('agent_id', '=', policy.agent_id ?? '');
    if (policy.scope === 'provider') {
      const runIds = await db
        .selectFrom('ai_agent_provider_requests')
        .select(['run_id'])
        .where('provider_key', '=', policy.provider_key ?? '')
        .where('run_id', 'is not', null)
        .execute();
      const ids = [...new Set(runIds.map((row) => row.run_id as string))];
      // An empty `in ()` is invalid SQL; no ledger row means no active run to count.
      if (ids.length === 0) return 0;
      query = query.where('id', 'in', ids);
    }
    if (policy.scope === 'team' && input !== undefined) {
      query = query.where('initiated_by_user_id', '=', input.userId);
    }
    const row = await query.executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Every configured hard limit paired with its current usage; null limits are unbounded. */
  private limitsWithUsage(
    row: {
      max_requests: number | null;
      max_tokens: string | null;
      max_cost_usd: string | null;
      max_runs: number | null;
      max_concurrent_runs: number | null;
    },
    usage: { runs: number; requests: number; tokens: number; costUsd: number; concurrentRuns: number },
  ): { name: string; limit: number; used: number }[] {
    const pairs = [
      { name: 'runs', limit: row.max_runs, used: usage.runs },
      { name: 'requests', limit: row.max_requests, used: usage.requests },
      { name: 'tokens', limit: row.max_tokens, used: usage.tokens },
      { name: 'costUsd', limit: row.max_cost_usd, used: usage.costUsd },
      { name: 'concurrentRuns', limit: row.max_concurrent_runs, used: usage.concurrentRuns },
    ] as const;
    return pairs.map((pair) => ({
      name: pair.name,
      limit: pair.limit === null ? Number.POSITIVE_INFINITY : Number(pair.limit),
      used: pair.used,
    }));
  }

  private exhausted(
    row: {
      max_requests: number | null;
      max_tokens: string | null;
      max_cost_usd: string | null;
      max_runs: number | null;
      max_concurrent_runs: number | null;
    },
    usage: { runs: number; requests: number; tokens: number; costUsd: number; concurrentRuns: number },
  ): boolean {
    return this.limitsWithUsage(row, usage).some((pair) => pair.used >= pair.limit);
  }

  private overThreshold(
    row: {
      max_requests: number | null;
      max_tokens: string | null;
      max_cost_usd: string | null;
      max_runs: number | null;
      max_concurrent_runs: number | null;
      warn_percent: number | null;
    },
    usage: { runs: number; requests: number; tokens: number; costUsd: number; concurrentRuns: number },
  ): boolean {
    if (row.warn_percent === null) return false;
    const factor = row.warn_percent / 100;
    return this.limitsWithUsage(row, usage).some(
      (pair) => pair.used >= pair.limit * factor && pair.used < pair.limit,
    );
  }

  private describe(row: { scope: string; period: string }): string {
    return `${row.scope} ${row.period}`;
  }

  private describeUsage(
    row: {
      max_requests: number | null;
      max_tokens: string | null;
      max_cost_usd: string | null;
      max_runs: number | null;
      max_concurrent_runs: number | null;
    },
    usage: { runs: number; requests: number; tokens: number; costUsd: number; concurrentRuns: number },
  ): string {
    const hit = this.limitsWithUsage(row, usage).find((pair) => pair.used >= pair.limit);
    if (hit === undefined) return '';
    const money = hit.name === 'costUsd';
    const used = money ? `$${hit.used.toFixed(4)}` : String(hit.used);
    const limit = money ? `$${hit.limit.toFixed(4)}` : String(hit.limit);
    return `${hit.name} ${used} of ${limit}`;
  }

  private toView(row: {
    id: string;
    scope: string;
    scope_ref: string | null;
    provider_key: string | null;
    agent_id: string | null;
    period: string;
    max_requests: number | null;
    max_tokens: string | null;
    max_cost_usd: string | null;
    max_runs: number | null;
    max_concurrent_runs: number | null;
    warn_percent: number | null;
    enabled: boolean;
  }): BudgetPolicyView {
    return {
      id: row.id,
      scope: row.scope as BudgetPolicyView['scope'],
      scopeRef: row.scope_ref,
      providerKey: row.provider_key,
      agentId: row.agent_id,
      period: row.period as BudgetPolicyView['period'],
      maxRequests: row.max_requests,
      maxTokens: row.max_tokens,
      maxCostUsd: row.max_cost_usd,
      maxRuns: row.max_runs,
      maxConcurrentRuns: row.max_concurrent_runs,
      warnPercent: row.warn_percent,
      enabled: row.enabled,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
