/**
 * Phase 22.18/G15 — the retry backoff the durable queues use.
 *
 * Both the outbox poller and the BullMQ consumer compute an exponential delay and then apply
 * **equal jitter** to it, the same construction the provider HTTP retry policy uses
 * (`apps/api/src/advanced-integrations/resilience.ts`): the computed value is halved, and the
 * caller waits somewhere in the upper half. Jitter is what keeps a fleet that failed at the same
 * moment from retrying at the same moment; without it the retry storm replays in lockstep.
 *
 * The delay is always lower-bounded by half the exponential plan and capped by the caller's own
 * ceiling, so a fleet-wide retry is spread without ever waiting longer than the policy allows.
 */
export function exponentialDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, Math.floor(attempts));
  const delay = 2 ** exponent * baseMs;
  if (!Number.isFinite(delay)) return maxMs;
  return Math.min(delay, maxMs);
}

/** Equal jitter over an already-capped exponential delay: a random value in the upper half. */
export function equalJitterDelayMs(delayMs: number, random: () => number = Math.random): number {
  if (delayMs <= 0) return 0;
  const half = Math.floor(delayMs / 2);
  return half + Math.floor(random() * (delayMs - half));
}
