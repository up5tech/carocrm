import cronParser from 'cron-parser';

const { parseExpression } = cronParser;

/**
 * Cron helpers for the scheduler.
 *
 * `scheduled_jobs.scheduling` holds a standard 5-field crontab expression (6 fields when
 * seconds matter, plus the `@daily` / `@hourly` style aliases cron-parser supports).
 * Everything is expressed against a caller-supplied `now` so the logic is deterministic and
 * unit-testable.
 */

export interface CronBoundary {
  /** Millisecond epoch of the most recent cron tick at or before `now`. */
  previousMs: number;
  /** Millisecond epoch of the next cron tick after `now`. */
  nextMs: number;
}

export class InvalidCronError extends Error {
  constructor(cron: string, cause: string) {
    super(`Invalid cron expression "${cron}": ${cause}`);
    this.name = 'InvalidCronError';
  }
}

/** Returns the previous / next cron boundaries around `now`, or throws `InvalidCronError`. */
export function cronBoundary(cron: string, now: Date): CronBoundary {
  const trimmed = cron.trim();
  if (trimmed === '') throw new InvalidCronError(cron, 'expression is empty');
  try {
    const expression = parseExpression(trimmed, { currentDate: now });
    const previousMs = expression.prev().getTime();
    expression.reset(now);
    const nextMs = expression.next().getTime();
    return { previousMs, nextMs };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidCronError(cron, message);
  }
}

/** Convenience wrapper: the most recent cron boundary at or before `now`. */
export function previousBoundaryMs(cron: string, now: Date): number {
  return cronBoundary(cron, now).previousMs;
}

export function isValidCron(cron: string, now: Date = new Date()): boolean {
  try {
    cronBoundary(cron, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * A schedule is due when it never ran, or when its last run happened before the current
 * cron boundary. Comparing against the boundary (not `now`) keeps the scheduler from
 * double-firing inside a tick and from skipping a fire after a worker restart.
 */
export function isDue(lastRunAtMs: number | null | undefined, boundaryMs: number): boolean {
  if (lastRunAtMs === null || lastRunAtMs === undefined) return true;
  return lastRunAtMs < boundaryMs;
}
