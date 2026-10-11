import { describe, expect, it } from 'vitest';

import { expandOccurrences } from '../src/calendar/recurrence.js';

const at = (iso: string): Date => new Date(iso);
const days = (list: Array<{ start: Date }>): string[] => list.map((occurrence) => occurrence.start.toISOString().slice(0, 10));

describe('expandOccurrences', () => {
  it('returns the stored record when it is not recurring', () => {
    const result = expandOccurrences({
      start: at('2026-03-04T09:00:00.000Z'),
      durationMs: 60 * 60 * 1000,
      recurrence: {},
      from: at('2026-03-01T00:00:00.000Z'),
      to: at('2026-03-31T00:00:00.000Z'),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.end?.toISOString()).toBe('2026-03-04T10:00:00.000Z');
  });

  it('drops a non-recurring record outside the window', () => {
    const result = expandOccurrences({
      start: at('2026-01-04T09:00:00.000Z'),
      durationMs: 0,
      recurrence: {},
      from: at('2026-03-01T00:00:00.000Z'),
      to: at('2026-03-31T00:00:00.000Z'),
    });
    expect(result).toHaveLength(0);
  });

  it('expands daily recurrence with a step', () => {
    const result = expandOccurrences({
      start: at('2026-03-01T08:00:00.000Z'),
      durationMs: 30 * 60 * 1000,
      recurrence: { repeatType: 'Daily', repeatEvery: 2 },
      from: at('2026-03-01T00:00:00.000Z'),
      to: at('2026-03-10T00:00:00.000Z'),
    });
    expect(days(result)).toEqual(['2026-03-01', '2026-03-03', '2026-03-05', '2026-03-07', '2026-03-09']);
  });

  it('honours repeatEndDate', () => {
    const result = expandOccurrences({
      start: at('2026-03-01T08:00:00.000Z'),
      durationMs: 0,
      recurrence: { repeatType: 'Daily', repeatEvery: 1, repeatEndDate: '2026-03-04' },
      from: at('2026-03-01T00:00:00.000Z'),
      to: at('2026-03-31T00:00:00.000Z'),
    });
    expect(days(result)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']);
  });

  it('expands weekly recurrence onto the selected weekdays', () => {
    // 2026-03-02 is a Monday
    const result = expandOccurrences({
      start: at('2026-03-02T09:00:00.000Z'),
      durationMs: 0,
      recurrence: { repeatType: 'Weekly', repeatEvery: 1, repeatDayOfWeek: ['mon', 'fri'] },
      from: at('2026-03-02T00:00:00.000Z'),
      to: at('2026-03-15T00:00:00.000Z'),
    });
    expect(days(result)).toEqual(['2026-03-02', '2026-03-06', '2026-03-09', '2026-03-13']);
  });

  it('clamps monthly day-of-month recurrence to shorter months', () => {
    const result = expandOccurrences({
      start: at('2026-01-31T09:00:00.000Z'),
      durationMs: 0,
      recurrence: { repeatType: 'Monthly', repeatEvery: 1 },
      from: at('2026-01-01T00:00:00.000Z'),
      to: at('2026-05-01T00:00:00.000Z'),
    });
    expect(days(result)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('supports the nth-weekday monthly variant', () => {
    // second Tuesday of each month; 2026-03-10 is the second Tuesday
    const result = expandOccurrences({
      start: at('2026-03-10T14:00:00.000Z'),
      durationMs: 0,
      recurrence: { repeatType: 'Monthly', repeatEvery: 1, repeatByMonth: 'Day of week' },
      from: at('2026-03-01T00:00:00.000Z'),
      to: at('2026-06-30T00:00:00.000Z'),
    });
    expect(days(result)).toEqual(['2026-03-10', '2026-04-14', '2026-05-12', '2026-06-09']);
  });

  it('expands yearly recurrence', () => {
    const result = expandOccurrences({
      start: at('2026-05-04T09:00:00.000Z'),
      durationMs: 0,
      recurrence: { repeatType: 'Yearly', repeatEvery: 1 },
      from: at('2026-01-01T00:00:00.000Z'),
      to: at('2030-12-31T00:00:00.000Z'),
    });
    expect(days(result)).toEqual(['2026-05-04', '2027-05-04', '2028-05-04', '2029-05-04', '2030-05-04']);
  });

  it('keeps the time of day across occurrences', () => {
    const result = expandOccurrences({
      start: at('2026-03-01T22:30:00.000Z'),
      durationMs: 0,
      recurrence: { repeatType: 'Daily', repeatEvery: 1 },
      from: at('2026-03-01T00:00:00.000Z'),
      to: at('2026-03-04T00:00:00.000Z'),
    });
    expect(result.map((occurrence) => occurrence.start.toISOString().slice(11, 16))).toEqual(['22:30', '22:30', '22:30']);
  });

  it('never expands beyond the safety cap', () => {
    const result = expandOccurrences({
      start: at('2020-01-01T00:00:00.000Z'),
      durationMs: 0,
      recurrence: { repeatType: 'Daily', repeatEvery: 1, repeatEndDate: '2030-01-01' },
      from: at('2020-01-01T00:00:00.000Z'),
      to: at('2030-01-02T00:00:00.000Z'),
    });
    expect(result.length).toBeLessThanOrEqual(400);
  });
});
