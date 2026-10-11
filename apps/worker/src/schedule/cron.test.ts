import { describe, expect, it } from 'vitest';

import { cronBoundary, InvalidCronError, isDue, isValidCron, previousBoundaryMs } from './cron.js';

const NOW = new Date('2026-02-10T10:00:30.500Z');

describe('cronBoundary', () => {
  it('brackets the reference instant: previous <= now < next', () => {
    for (const cron of ['* * * * *', '*/15 * * * *', '0 12 * * 1-5', '@hourly', '@daily', '0 30 3 * * *']) {
      const boundary = cronBoundary(cron, NOW);
      expect(boundary.previousMs, cron).toBeLessThanOrEqual(NOW.getTime());
      expect(boundary.nextMs, cron).toBeGreaterThan(NOW.getTime());
    }
  });

  it('snaps to the minute grid for a per-minute cron', () => {
    const previous = previousBoundaryMs('* * * * *', NOW);
    expect(previous % 60000).toBe(0);
    expect(NOW.getTime() - previous).toBe(30500);
  });

  it('snaps to a 30 second grid when seconds are part of the expression', () => {
    const previous = previousBoundaryMs('*/30 * * * * *', NOW);
    expect(previous % 30000).toBe(0);
    expect(NOW.getTime() - previous).toBeLessThan(30000);
  });

  it('is stable for the same instant (deterministic boundaries)', () => {
    expect(cronBoundary('5 4 * * *', NOW)).toEqual(cronBoundary('5 4 * * *', NOW));
  });

  it('throws InvalidCronError for garbage', () => {
    expect(() => cronBoundary('nonsense here', NOW)).toThrow(InvalidCronError);
    expect(() => cronBoundary('   ', NOW)).toThrow('expression is empty');
    expect(() => cronBoundary('0 0 32 * *', NOW)).toThrow(InvalidCronError);
  });

  it('isValidCron never throws', () => {
    expect(isValidCron('* * * * *', NOW)).toBe(true);
    expect(isValidCron('daily job', NOW)).toBe(false);
    expect(isValidCron('', NOW)).toBe(false);
  });
});

describe('isDue', () => {
  it('fires schedules that never ran', () => {
    expect(isDue(null, 1000)).toBe(true);
    expect(isDue(undefined, 1000)).toBe(true);
  });

  it('fires when the last run predates the current boundary', () => {
    expect(isDue(999, 1000)).toBe(true);
  });

  it('does not fire twice for the same boundary', () => {
    expect(isDue(1000, 1000)).toBe(false);
    expect(isDue(1001, 1000)).toBe(false);
  });
});
