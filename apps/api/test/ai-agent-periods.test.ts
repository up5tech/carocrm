import { describe, expect, it } from 'vitest';

import { isPeriodToken, localDateString, resolvePeriod } from '../src/ai-agents/ai-agent-periods.js';

/**
 * Phase 19-CHAT.21 — the relative-period resolver
 * (plans/PLAN_Phase_19_CRM_Chat.md §5.4, §17 `19-CHAT.21`).
 *
 * Pure: no database, no clock, no locale. `now` is an argument, so every expectation below is a
 * literal rather than a tolerance. The suite is listed in `PURE_API_TESTS` so the DB-less CI gate
 * runs it.
 *
 * The cases that matter are the ones a model gets wrong when it computes dates itself: where the
 * quarter starts, which Monday begins the week, what "today" means in a zone that is already
 * tomorrow in UTC, and what happens across a DST boundary.
 */

const NOV_2 = new Date('2026-11-02T12:00:00.000Z'); // a Monday, 19:00 in Ho Chi Minh City
const NOV_2_EARLY = new Date('2026-11-02T00:30:00.000Z'); // still 2026-11-01 in New York

describe('resolvePeriod — calendar boundaries in UTC', () => {
  it('resolves the current quarter to its first and last instant', () => {
    const period = resolvePeriod('this_quarter', 'UTC', NOV_2);
    expect(period.from).toBe('2026-10-01T00:00:00.000Z');
    expect(period.to).toBe('2027-01-01T00:00:00.000Z');
    expect(period.label).toBe('2026-Q4');
    expect(period.timezone).toBe('UTC');
  });

  it('resolves the previous quarter, not the current one shifted by 90 days', () => {
    const period = resolvePeriod('last_quarter', 'UTC', NOV_2);
    expect(period.from).toBe('2026-07-01T00:00:00.000Z');
    expect(period.to).toBe('2026-10-01T00:00:00.000Z');
    expect(period.label).toBe('2026-Q3');
  });

  it('starts the week on Monday, which is where a CRM week starts', () => {
    const period = resolvePeriod('this_week', 'UTC', NOV_2);
    expect(period.from).toBe('2026-11-02T00:00:00.000Z');
    expect(period.to).toBe('2026-11-09T00:00:00.000Z');
    expect(period.label).toBe('2026-W45');
  });

  it('resolves a month as a calendar month, not as 30 days', () => {
    const period = resolvePeriod('this_month', 'UTC', NOV_2);
    expect(period.from).toBe('2026-11-01T00:00:00.000Z');
    expect(period.to).toBe('2026-12-01T00:00:00.000Z');
    expect(period.label).toBe('2026-11');
  });

  it('resolves the year and the previous year', () => {
    expect(resolvePeriod('this_year', 'UTC', NOV_2).from).toBe('2026-01-01T00:00:00.000Z');
    const lastYear = resolvePeriod('last_year', 'UTC', NOV_2);
    expect(lastYear.from).toBe('2025-01-01T00:00:00.000Z');
    expect(lastYear.to).toBe('2026-01-01T00:00:00.000Z');
    expect(lastYear.label).toBe('2025');
  });
});

describe('resolvePeriod — the actor\'s zone, not the server\'s', () => {
  it('uses the local day in a zone ahead of UTC', () => {
    // 00:30 UTC is 07:30 in Ho Chi Minh City, so "today" is the 2nd locally and the 1st in UTC.
    const period = resolvePeriod('today', 'Asia/Ho_Chi_Minh', NOV_2_EARLY);
    expect(period.from).toBe('2026-11-01T17:00:00.000Z');
    expect(period.to).toBe('2026-11-02T17:00:00.000Z');
  });

  it('uses the local day in a zone behind UTC', () => {
    // 00:30 UTC on the 2nd is 20:30 on the 1st in New York. DST ended on the 1st, so that day
    // begins at 04:00Z (EDT, -4) and the next begins at 05:00Z (EST, -5) — a 25-hour "day", which
    // is exactly the case a fixed-offset implementation gets wrong.
    const period = resolvePeriod('today', 'America/New_York', NOV_2_EARLY);
    expect(period.from).toBe('2026-11-01T04:00:00.000Z');
    expect(period.to).toBe('2026-11-02T05:00:00.000Z');
  });

  it('keeps a quarter boundary on the local calendar', () => {
    // Q4 begins at 00:00 local, which is 04:00Z while EDT is in force.
    const period = resolvePeriod('this_quarter', 'America/New_York', NOV_2);
    expect(period.from).toBe('2026-10-01T04:00:00.000Z');
    expect(period.to).toBe('2027-01-01T05:00:00.000Z');
  });

  it('survives a DST boundary inside the period', () => {
    // March 2026 starts in EST (-5) and ends in EDT (-4): a naive implementation produces one of
    // these two instants wrong, and the range silently covers 31 days plus or minus an hour.
    const period = resolvePeriod('this_month', 'America/New_York', new Date('2026-03-15T12:00:00.000Z'));
    expect(period.from).toBe('2026-03-01T05:00:00.000Z');
    expect(period.to).toBe('2026-04-01T04:00:00.000Z');
  });

  it('treats an empty zone as UTC rather than throwing', () => {
    expect(resolvePeriod('today', '   ', NOV_2).timezone).toBe('UTC');
  });
});

describe('resolvePeriod — rolling windows are exact instants', () => {
  it('subtracts whole days from now, not from midnight', () => {
    const period = resolvePeriod('rolling:30d', 'UTC', NOV_2);
    expect(period.from).toBe('2026-10-03T12:00:00.000Z');
    expect(period.to).toBe('2026-11-02T12:00:00.000Z');
    expect(period.label).toBe('last 30 days');
  });
});

describe('isPeriodToken — the closed grammar', () => {
  it('accepts the named tokens and bounded rolling windows', () => {
    expect(isPeriodToken('this_quarter')).toBe(true);
    expect(isPeriodToken('next_year')).toBe(true);
    expect(isPeriodToken('rolling:1d')).toBe(true);
    expect(isPeriodToken('rolling:365d')).toBe(true);
  });

  it('rejects anything that is not a token, including a date', () => {
    expect(isPeriodToken('2026-Q4')).toBe(false);
    expect(isPeriodToken('2026-10-01')).toBe(false);
    expect(isPeriodToken('rolling:0d')).toBe(false);
    expect(isPeriodToken('rolling:366d')).toBe(false);
    expect(isPeriodToken('rolling:30')).toBe(false);
    expect(isPeriodToken('this quarter')).toBe(false);
    expect(isPeriodToken('')).toBe(false);
  });
});

describe('resolvePeriod — refusals', () => {
  it('names the allowed tokens when the token is unknown', () => {
    expect(() => resolvePeriod('q4', 'UTC', NOV_2)).toThrow(/Unknown period/);
  });

  it('rejects a zone the runtime does not know', () => {
    expect(() => resolvePeriod('this_month', 'Mars/Olympus', NOV_2)).toThrow(/Unknown time zone/);
  });
});

describe('localDateString', () => {
  it('formats the local date, which is what an answer should quote', () => {
    expect(localDateString(NOV_2_EARLY, 'UTC')).toBe('2026-11-02');
    expect(localDateString(NOV_2_EARLY, 'America/New_York')).toBe('2026-11-01');
    expect(localDateString(NOV_2_EARLY, 'Asia/Ho_Chi_Minh')).toBe('2026-11-02');
  });
});
