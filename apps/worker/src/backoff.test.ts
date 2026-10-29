import { describe, expect, it } from 'vitest';

import { equalJitterDelayMs, exponentialDelayMs } from './backoff.js';
import { retryDelayMs } from './outbox/outbox-poller.js';
import { jobRetryDelayMs } from './queue/job-consumer.js';

/**
 * Phase 22.18/G15 — the backoff the durable queues wait on.
 *
 * The delay plan stays exponential and capped (what the earlier tests pinned); what is new is the
 * equal jitter: every retry waits a random amount inside the upper half of the plan, so a fleet that
 * failed at the same instant does not retry at the same instant.
 */

describe('exponentialDelayMs (the delay plan)', () => {
  it('doubles from the base and caps at the ceiling', () => {
    expect(exponentialDelayMs(0, 5000, 900000)).toBe(5000);
    expect(exponentialDelayMs(3, 5000, 900000)).toBe(40000);
    expect(exponentialDelayMs(8, 5000, 900000)).toBe(900000);
    expect(exponentialDelayMs(40, 5000, 900000)).toBe(900000);
  });

  it('clamps negative attempt counts to the base delay', () => {
    expect(exponentialDelayMs(-2, 5000, 900000)).toBe(5000);
  });
});

describe('equal jitter (G15)', () => {
  it('stays inside the upper half of the plan — never below half, never above the cap', () => {
    for (const [attempts, base, max] of [[0, 5000, 900000], [3, 5000, 900000], [8, 5000, 900000], [40, 5000, 900000]] as const) {
      const plan = exponentialDelayMs(attempts, base, max);
      for (const draw of [0, 0.3, 0.999, 1]) {
        const delay = equalJitterDelayMs(plan, () => draw);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(plan / 2));
        expect(delay).toBeLessThanOrEqual(plan);
      }
    }
  });

  it('spreads retries: the same failure does not recomput to the same instant', () => {
    // With a fine-grained delay the two draws will differ for the overwhelming majority of runs;
    // with a deterministic check this asserts at least that the jitter changes the value sometimes.
    const delays = new Set(Array.from({ length: 32 }, () => equalJitterDelayMs(40_000)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('answers zero when the plan is zero', () => {
    expect(equalJitterDelayMs(0, () => 0.5)).toBe(0);
  });
});

describe('the two callers agree on the same construction', () => {
  it('the outbox poller delay follows the identical bounds', () => {
    const plan = exponentialDelayMs(2, 5000, 900000);
    const delay = retryDelayMs(2, 5000, 900000);
    expect(delay).toBeGreaterThanOrEqual(Math.floor(plan / 2));
    expect(delay).toBeLessThanOrEqual(plan);
    // And with a pinned random, the exact plan value (the upper bound) is reachable:
    expect(retryDelayMs(2, 5000, 900000, () => 1)).toBe(20_000);
  });

  it('the BullMQ consumer delay follows the identical bounds with a pinned random', () => {
    expect(jobRetryDelayMs(0, 5000, 900000, () => 0)).toBe(2500);
    expect(jobRetryDelayMs(0, 5000, 900000, () => 1)).toBe(5000);
    expect(jobRetryDelayMs(4, 1000, 1500, () => 1)).toBe(1500); // capped, never over the ceiling
  });
});
