import cronParser from 'cron-parser';

const { parseExpression } = cronParser;

/**
 * Cron validation for the schedules API (PLAN §24). The worker owns the firing logic
 * (`apps/worker/src/schedule/cron.ts`); the API only refuses expressions the scheduler could
 * never parse, before they are stored.
 */
export function isValidCronExpression(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  try {
    parseExpression(trimmed, { currentDate: new Date() }).next();
    return true;
  } catch {
    return false;
  }
}

/** Upcoming run times, so an admin can see what a stored expression actually means. */
export function nextRuns(value: string, count = 3, now: Date = new Date()): string[] {
  if (!isValidCronExpression(value)) return [];
  const expression = parseExpression(value.trim(), { currentDate: now });
  const times: string[] = [];
  for (let index = 0; index < count; index += 1) {
    times.push(new Date(expression.next().getTime()).toISOString());
  }
  return times;
}
