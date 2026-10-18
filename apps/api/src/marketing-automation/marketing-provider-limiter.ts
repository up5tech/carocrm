import { RateLimitError } from "@carocrm/core/errors/index.js";
import { Injectable } from "@nestjs/common";

/**
 * Phase 19-MA.7 — the provider rate-limit and concurrency interface (§5.8, §11.2, §15 `19-MA.7` task 5).
 *
 * §5.8 requires the pipeline to "use bounded batch sizes and a global/per-provider/per-sender rate limiter"
 * and to "respect provider daily/hourly quotas and `Retry-After` responses". This file is the *interface*
 * half of that: one place that answers "may this adapter be called now", by provider key, for both the
 * message rate and simultaneous calls. MA.9's worker drives it from the queue; MA.7's test send drives it
 * from the command, so the same ceiling applies to a test as to a campaign (§13: "do not let a campaign
 * author exceed global rate/volume limits").
 *
 * Deliberately in-process. The authoritative, multi-worker limits need a shared store (Redis) and belong to
 * the delivery phase; pretending a `Map` is a distributed limiter would be worse than saying so. What this
 * class *does* guarantee is that one process never exceeds the configured rate/concurrency, and that the
 * refusal is the platform's own 429 (`RateLimitError`) with a retry hint rather than a vendor error.
 *
 * The clock is a property, not a constructor argument, so a unit test can advance time without a fake timer
 * and without Nest having to resolve a `Function` dependency.
 */
export interface ProviderLimitOptions {
  /** How many provider messages this call will consume. */
  readonly messages: number;
  /** Messages per minute; `0` means no configured ceiling. */
  readonly ratePerMinute: number;
  /** Simultaneous calls allowed for this provider; `0` means no configured ceiling. */
  readonly maxConcurrency: number;
}

const WINDOW_MS = 60_000;

@Injectable()
export class MarketingProviderLimiter {
  /** Overridable in tests; production uses the wall clock. */
  now: () => number = Date.now;

  private readonly windows = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();

  /** Throws `RateLimitError` (429) when the call would exceed the configured ceiling. */
  check(key: string, options: ProviderLimitOptions): void {
    if (options.maxConcurrency > 0 && (this.inFlight.get(key) ?? 0) >= options.maxConcurrency) {
      throw new RateLimitError(
        `Provider "${key}" is already handling ${String(options.maxConcurrency)} message(s); retry once that submission finishes.`,
      );
    }
    if (options.ratePerMinute > 0) {
      const window = this.window(key);
      if (window.length + options.messages > options.ratePerMinute) {
        throw new RateLimitError(
          `Provider "${key}" accepts ${String(options.ratePerMinute)} message(s) per minute; retry in ${String(this.retryAfterSeconds(window))} second(s).`,
        );
      }
    }
  }

  /**
   * Run one provider call under both ceilings. The in-flight counter is released in `finally`, so a thrown
   * provider error cannot leak the slot and wedge every later send.
   */
  async run<T>(key: string, options: ProviderLimitOptions, action: () => Promise<T>): Promise<T> {
    this.check(key, options);
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    if (options.ratePerMinute > 0) this.window(key).push(this.now());
    try {
      return await action();
    } finally {
      const remaining = (this.inFlight.get(key) ?? 1) - 1;
      if (remaining <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, remaining);
    }
  }

  /** Only tests and a controlled reload call this; the counters are otherwise self-expiring. */
  reset(): void {
    this.windows.clear();
    this.inFlight.clear();
  }

  /**
   * The live timestamps inside the window, pruned on read so a long-lived process cannot grow unbounded.
   * The (possibly empty) array is always written back, because `run` appends to the array it returns —
   * a temporary `[]` would silently drop the record and the rate limit would never engage.
   */
  private window(key: string): number[] {
    const cutoff = this.now() - WINDOW_MS;
    const kept = (this.windows.get(key) ?? []).filter((at) => at > cutoff);
    this.windows.set(key, kept);
    return kept;
  }

  private retryAfterSeconds(window: readonly number[]): number {
    const oldest = window[0];
    if (oldest === undefined) return 1;
    return Math.max(1, Math.ceil((oldest + WINDOW_MS - this.now()) / 1000));
  }
}
