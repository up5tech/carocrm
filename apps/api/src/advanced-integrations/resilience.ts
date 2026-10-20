import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { ProviderError } from './provider-error.js';

/**
 * Phase 19-INT.11 — retry policy, rate limiting and the circuit breaker
 * (`PLAN_Phase_19_Advanced_Integrations.md` §11.2; `19-INT.11`).
 *
 * The three mechanisms live together because they answer the same question from different angles:
 * **how often may we call this provider right now?**
 *
 *  - The **retry policy** decides how long to wait before the next attempt of the *same* operation.
 *  - The **rate limiter** decides whether an attempt may be made at all, against the provider's
 *    own quota.
 *  - The **circuit breaker** stops calling a provider that is failing, so a provider outage does
 *    not turn into a queue of doomed requests.
 *
 * The limiter and the breaker keep their state in the **database**, not in memory. The API and the
 * worker are separate processes; a per-process limiter would let the two of them together exceed
 * the provider's quota, and a per-process breaker would let one of them keep hammering a provider
 * the other has already given up on.
 */

// ---------------------------------------------------------------------------
// retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicyOptions {
  /** The delay before the first retry. */
  readonly baseDelayMs: number;
  /** The ceiling of the computed delay. */
  readonly maxDelayMs: number;
  /** The maximum number of attempts, including the first one. */
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicyOptions = {
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  maxAttempts: 5,
};

export interface RetryDecision {
  /** The attempt number the operation is about to make, starting at 1. */
  readonly attempt: number;
  /** Whether another attempt is allowed. */
  readonly retryable: boolean;
  /** How long to wait before it. Zero when the operation must not be retried. */
  readonly delayMs: number;
  /** The provider's own guidance, when it sent one. It wins over the computed delay. */
  readonly retryAfterMs: number | null;
}

/**
 * The computed delay for an attempt.
 *
 * Exponential, **capped**, and **jittered**: the delay is the computed value halved plus a random
 * part of the other half ("equal jitter"). The jitter matters because many connections that fail
 * together would otherwise retry together, in lockstep, and keep the provider down.
 */
export function computeRetryDelay(
  attempt: number,
  options: RetryPolicyOptions = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(options.baseDelayMs * 2 ** Math.max(0, attempt - 1), options.maxDelayMs);
  const half = Math.floor(exponential / 2);
  return half + Math.floor(random() * (exponential - half));
}

/**
 * Decide whether an operation may be retried, and when.
 *
 * A provider that asked for a specific delay is obeyed, within a ceiling — the provider knows
 * something about its own quota that the platform does not.
 */
export function decideRetry(
  attempt: number,
  error: unknown,
  options: RetryPolicyOptions = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryDecision {
  const retryAfterMs = error instanceof ProviderError ? error.retryAfterMs : null;
  if (error instanceof ProviderError && !error.retryable) {
    return { attempt, retryable: false, delayMs: 0, retryAfterMs };
  }
  if (attempt >= options.maxAttempts) {
    return { attempt, retryable: false, delayMs: 0, retryAfterMs };
  }
  const computed = computeRetryDelay(attempt, options, random);
  const delayMs = retryAfterMs !== null && retryAfterMs > computed ? retryAfterMs : computed;
  return { attempt: attempt + 1, retryable: true, delayMs, retryAfterMs };
}

// ---------------------------------------------------------------------------
// rate limiter
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** How many tokens the bucket holds. */
  readonly capacity: number;
  /** How many tokens are restored per second. */
  readonly refillPerSecond: number;
  /** How many tokens one request costs. */
  readonly cost: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** The tokens left in the bucket. */
  readonly remaining: number;
  /** How long to wait before a request would be allowed. */
  readonly retryAfterMs: number;
}

/**
 * A shared token bucket.
 *
 * The bucket is refilled lazily: the tokens are computed from the time since the row was last
 * touched, so no background job is needed to keep it accurate.
 */
@Injectable()
export class ProviderRateLimiter {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Take `cost` tokens from the bucket, or refuse.
   *
   * The whole check happens in one transaction with the row locked, so two processes cannot both
   * see the last token and both take it.
   */
  async consume(key: string, options: RateLimitOptions): Promise<RateLimitDecision> {
    const now = Date.now();
    return this.database.db.transaction().execute(async (tx) => {
      const rows = await sql<{ tokens: number; updated_at: Date }>`
        select tokens, updated_at from integration_rate_limit_buckets where key = ${key} for update
      `.execute(tx);
      const existing = rows.rows[0];

      const lastRefill = existing ? existing.updated_at.getTime() : now;
      const elapsedSeconds = Math.max(0, (now - lastRefill) / 1000);
      const refill = Math.min(options.capacity, existing ? existing.tokens + elapsedSeconds * options.refillPerSecond : options.capacity);
      const available = Math.floor(refill);

      if (available < options.cost) {
        const deficit = options.cost - available;
        const retryAfterMs = Math.ceil((deficit / Math.max(options.refillPerSecond, 0.0001)) * 1000);
        await sql`
          insert into integration_rate_limit_buckets (key, tokens, updated_at)
          values (${key}, ${refill}, ${new Date(now)})
          on conflict (key) do update set tokens = excluded.tokens, updated_at = excluded.updated_at
        `.execute(tx);
        return { allowed: false, remaining: available, retryAfterMs };
      }

      const remaining = available - options.cost;
      await sql`
        insert into integration_rate_limit_buckets (key, tokens, updated_at)
        values (${key}, ${remaining}, ${new Date(now)})
        on conflict (key) do update set tokens = excluded.tokens, updated_at = excluded.updated_at
      `.execute(tx);
      return { allowed: true, remaining, retryAfterMs: 0 };
    });
  }

  /** Refill a bucket completely. Used after a long idle period or by an operator. */
  async reset(key: string, capacity: number): Promise<void> {
    await sql`
      insert into integration_rate_limit_buckets (key, tokens, updated_at)
      values (${key}, ${capacity}, ${new Date()})
      on conflict (key) do update set tokens = excluded.tokens, updated_at = excluded.updated_at
    `.execute(this.database.db);
  }
}

// ---------------------------------------------------------------------------
// circuit breaker
// ---------------------------------------------------------------------------

export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export interface CircuitOptions {
  /** How many consecutive failures open the circuit. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before a probe is allowed. */
  readonly openDurationMs: number;
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitOptions = {
  failureThreshold: 5,
  openDurationMs: 60_000,
};

export interface CircuitSnapshot {
  readonly key: string;
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly openedAt: string | null;
  readonly nextProbeAt: string | null;
}

/**
 * A shared circuit breaker.
 *
 * `closed` → calls pass. After `failureThreshold` consecutive failures the circuit **opens** and
 * calls are refused without touching the provider. After `openDurationMs` it becomes
 * **half_open**: one probe is allowed through, and its outcome decides whether the circuit closes
 * again or re-opens.
 */
@Injectable()
export class ProviderCircuitBreaker {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async snapshot(key: string): Promise<CircuitSnapshot> {
    const rows = await sql<{
      key: string;
      state: string;
      failure_count: number;
      opened_at: Date | null;
      next_probe_at: Date | null;
    }>`
      select * from integration_circuit_states where key = ${key} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) {
      return { key, state: 'closed', failureCount: 0, openedAt: null, nextProbeAt: null };
    }
    return {
      key: row.key,
      state: row.state as CircuitState,
      failureCount: row.failure_count,
      openedAt: row.opened_at ? row.opened_at.toISOString() : null,
      nextProbeAt: row.next_probe_at ? row.next_probe_at.toISOString() : null,
    };
  }

  /**
   * Refuse the call when the circuit is open.
   *
   * A half-open circuit lets exactly one probe through: the transition is taken under a row lock,
   * so two concurrent callers cannot both become the probe.
   */
  async beforeRequest(key: string): Promise<void> {
    const now = new Date();
    await this.database.db.transaction().execute(async (tx) => {
      const rows = await sql<{
        key: string;
        state: string;
        failure_count: number;
        opened_at: Date | null;
        next_probe_at: Date | null;
      }>`
        select * from integration_circuit_states where key = ${key} for update
      `.execute(tx);
      const row = rows.rows[0];
      const state: CircuitState = row ? (row.state as CircuitState) : 'closed';

      if (state === 'open') {
        const nextProbe = row?.next_probe_at ? row.next_probe_at.getTime() : 0;
        if (nextProbe > now.getTime()) {
          throw new ProviderError('PROVIDER_UNAVAILABLE', 'The provider is temporarily disabled for this connection.', {
            category: 'provider_outage',
            retryable: true,
            retryAfterMs: nextProbe - now.getTime(),
            detail: 'circuit_open',
          });
        }
        // The open period elapsed: allow one probe.
        await sql`
          update integration_circuit_states set state = 'half_open', updated_at = ${now} where key = ${key}
        `.execute(tx);
        return;
      }
      if (state === 'half_open') {
        // Another caller already took the probe slot.
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'The provider is being probed; try again shortly.', {
          category: 'provider_outage',
          retryable: true,
          retryAfterMs: 1000,
          detail: 'circuit_half_open',
        });
      }
    });
  }

  /** A successful call closes a half-open circuit and clears the failure count. */
  async recordSuccess(key: string): Promise<void> {
    await sql`
      insert into integration_circuit_states (key, state, failure_count, updated_at)
      values (${key}, 'closed', 0, ${new Date()})
      on conflict (key) do update set
        state = 'closed', failure_count = 0, opened_at = null, next_probe_at = null, updated_at = excluded.updated_at
    `.execute(this.database.db);
  }

  /**
   * A failed call counts towards the threshold.
   *
   * Only a failure that says the *provider* is at fault counts. A validation error is the
   * platform's mistake, not the provider's, and must not open a circuit that would block every
   * other operation on the same connection.
   */
  async recordFailure(
    key: string,
    error: unknown,
    options: CircuitOptions = DEFAULT_CIRCUIT_OPTIONS,
  ): Promise<void> {
    const counts =
      error instanceof ProviderError &&
      (error.category === 'transient' || error.category === 'provider_outage' || error.category === 'rate_limited');
    if (!counts) return;

    const now = new Date();
    await this.database.db.transaction().execute(async (tx) => {
      const rows = await sql<{ state: string; failure_count: number }>`
        select state, failure_count from integration_circuit_states where key = ${key} for update
      `.execute(tx);
      const row = rows.rows[0];
      const state: CircuitState = row ? (row.state as CircuitState) : 'closed';
      const failureCount = (row?.failure_count ?? 0) + 1;

      if (state === 'half_open' || failureCount >= options.failureThreshold) {
        await sql`
          insert into integration_circuit_states (key, state, failure_count, opened_at, next_probe_at, updated_at)
          values (${key}, 'open', ${failureCount}, ${now}, ${new Date(now.getTime() + options.openDurationMs)}, ${now})
          on conflict (key) do update set
            state = 'open', failure_count = excluded.failure_count,
            opened_at = excluded.opened_at, next_probe_at = excluded.next_probe_at, updated_at = excluded.updated_at
        `.execute(tx);
        return;
      }
      await sql`
        insert into integration_circuit_states (key, state, failure_count, updated_at)
        values (${key}, 'closed', ${failureCount}, ${now})
        on conflict (key) do update set
          state = 'closed', failure_count = excluded.failure_count, updated_at = excluded.updated_at
      `.execute(tx);
    });
  }

  /** Close a circuit by hand. An operator uses this after fixing a configuration problem. */
  async reset(key: string): Promise<void> {
    await sql`
      insert into integration_circuit_states (key, state, failure_count, updated_at)
      values (${key}, 'closed', 0, ${new Date()})
      on conflict (key) do update set
        state = 'closed', failure_count = 0, opened_at = null, next_probe_at = null, updated_at = excluded.updated_at
    `.execute(this.database.db);
  }
}
