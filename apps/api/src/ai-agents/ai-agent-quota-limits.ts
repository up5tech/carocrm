/**
 * Phase 25.10 — the pure quota-limit rules
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §16 task 2; §12.2/§12.3 of the Phase 19 plan).
 *
 * These are the rules that decide **which** limit a policy is near and **which** one has stopped
 * the work. They live in their own module for two reasons:
 *
 *  - they are pure, so the soft-warning *timing* can be tested without a database and without a
 *    clock (the caller passes the usage in);
 *  - the quota service and the notification writer both need them, and a module that imports its
 *    own notifier must not create an import cycle.
 */

/** The five limit dimensions a policy can bound (§12.2). */
export type QuotaLimitDimension = 'runs' | 'requests' | 'tokens' | 'costUsd' | 'concurrentRuns';

/** One dimension paired with its configured hard limit and the current consumption. */
export interface QuotaLimitPair {
  readonly name: QuotaLimitDimension;
  readonly limit: number;
  readonly used: number;
}

/** The soft/hard state of a policy, derived from the ledger — never stored. */
export interface QuotaLimitState {
  readonly warningDimension: QuotaLimitDimension | null;
  readonly warningUsed: number | null;
  readonly warningLimit: number | null;
  readonly exhaustedDimension: QuotaLimitDimension | null;
  readonly exhaustedUsed: number | null;
  readonly exhaustedLimit: number | null;
}

export interface QuotaPolicyLimits {
  readonly max_requests: number | null;
  readonly max_tokens: string | null;
  readonly max_cost_usd: string | null;
  readonly max_runs: number | null;
  readonly max_concurrent_runs: number | null;
}

export interface QuotaUsageTotals {
  readonly runs: number;
  readonly requests: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly concurrentRuns: number;
}

/**
 * Every configured hard limit paired with its current usage; a null limit is unbounded.
 *
 * Pure and exported so the soft-limit rule can be tested — and reasoned about — without a
 * database: the same function decides the warning an operator sees and the warning a notification
 * carries (§25.10).
 */
export function quotaLimitPairs(row: QuotaPolicyLimits, usage: QuotaUsageTotals): QuotaLimitPair[] {
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

/**
 * The soft-limit and hard-limit state of one policy.
 *
 * A soft limit (`warnPercent`) never refuses work: it marks the first dimension that reached the
 * threshold, so the operator is warned **before** the hard limit stops the run. The hard limit is
 * the first dimension that is fully used.
 */
export function quotaLimitState(
  row: QuotaPolicyLimits & { readonly warn_percent: number | null },
  usage: QuotaUsageTotals,
): QuotaLimitState {
  const pairs = quotaLimitPairs(row, usage);
  const exhausted = pairs.find((pair) => pair.used >= pair.limit);
  const factor = row.warn_percent === null ? null : row.warn_percent / 100;
  const warning =
    factor === null ? undefined : pairs.find((pair) => pair.used >= pair.limit * factor && pair.used < pair.limit);
  return {
    warningDimension: warning?.name ?? null,
    warningUsed: warning?.used ?? null,
    warningLimit: warning === undefined || !Number.isFinite(warning.limit) ? null : warning.limit,
    exhaustedDimension: exhausted?.name ?? null,
    exhaustedUsed: exhausted?.used ?? null,
    exhaustedLimit: exhausted === undefined || !Number.isFinite(exhausted.limit) ? null : exhausted.limit,
  };
}

/**
 * The start of a quota period, in UTC. A `day` starts at UTC midnight, a `month` on the 1st — the
 * same rule the policy period has always used, exported so a notification can name the window it
 * belongs to.
 */
export function quotaPeriodStart(period: 'run' | 'day' | 'month', now: Date): Date | null {
  if (period === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return null;
}
