import { describe, expect, it } from 'vitest';

import { addDays, daysBetween, dueDateFor, endOfMonth, isOverdue, parseDay } from '../src/sales/document/terms.js';

/**
 * Phase 19-S.8 / 19-S.9 — payment terms and the dates they produce.
 *
 * No database, no clock: every case names the day it means, which is the whole reason the module takes
 * the day as an argument. The cases that matter are the ones a hand-written date helper gets wrong —
 * month ends, leap years, and days that do not exist.
 */
describe('day arithmetic', () => {
  it('accepts a real calendar day', () => {
    expect(parseDay('2026-10-15')).toBe(Date.UTC(2026, 9, 15));
    expect(parseDay('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
  });

  it('refuses a day that does not exist instead of rolling it over', () => {
    // `Date.parse('2026-02-30T00:00:00Z')` silently becomes 2 March; a due date must not do that.
    expect(() => parseDay('2026-02-30')).toThrow(/not a valid calendar date/);
    expect(() => parseDay('2026-02-29')).toThrow(/not a valid calendar date/); // 2026 is not a leap year
    expect(() => parseDay('2026-13-01')).toThrow(/not a valid calendar date/);
    expect(() => parseDay('15/10/2026')).toThrow(/YYYY-MM-DD/);
  });

  it('moves whole days across a month, a year and backwards', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-10-15', 30)).toBe('2026-11-14');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(() => addDays('2026-10-15', 1.5)).toThrow(/whole number/);
  });

  it('finds the end of the month, including February in a leap year', () => {
    expect(endOfMonth('2026-02-14')).toBe('2026-02-28');
    expect(endOfMonth('2024-02-14')).toBe('2024-02-29');
    expect(endOfMonth('2026-12-01')).toBe('2026-12-31');
    expect(endOfMonth('2026-10-31')).toBe('2026-10-31');
  });

  it('counts days between two days, signed', () => {
    expect(daysBetween('2026-10-01', '2026-10-15')).toBe(14);
    expect(daysBetween('2026-10-15', '2026-10-01')).toBe(-14);
  });
});

describe('due dates from payment terms', () => {
  it('adds the days to the document date on a `net` basis', () => {
    expect(dueDateFor('2026-10-15', { dueDays: 30, basis: 'net' })).toBe('2026-11-14');
    expect(dueDateFor('2026-10-15', { dueDays: 0, basis: 'net' })).toBe('2026-10-15');
  });

  it('counts from the end of the month on an `endOfMonth` basis', () => {
    // "30 days end of month" must mean the same thing whoever raises the invoice and whenever.
    expect(dueDateFor('2026-10-15', { dueDays: 30, basis: 'endOfMonth' })).toBe('2026-11-30');
    expect(dueDateFor('2026-10-01', { dueDays: 30, basis: 'endOfMonth' })).toBe('2026-11-30');
    expect(dueDateFor('2026-02-10', { dueDays: 30, basis: 'endOfMonth' })).toBe('2026-03-30');
  });

  it('refuses terms that could not produce a sane date', () => {
    expect(() => dueDateFor('2026-10-15', { dueDays: -1, basis: 'net' })).toThrow(/3650/);
    expect(() => dueDateFor('2026-10-15', { dueDays: 3_651, basis: 'net' })).toThrow(/3650/);
    expect(() => dueDateFor('2026-10-15', { dueDays: 1.5, basis: 'net' })).toThrow(/whole number/);
    expect(() => dueDateFor('2026-10-15', { dueDays: 30, basis: 'whenever' as never })).toThrow(/basis/);
  });
});

describe('overdue detection', () => {
  it('is late only after the day it falls due', () => {
    expect(isOverdue('2026-10-14', '2026-10-15')).toBe(true);
    // A document is not late on the day it is due.
    expect(isOverdue('2026-10-15', '2026-10-15')).toBe(false);
    expect(isOverdue('2026-10-16', '2026-10-15')).toBe(false);
  });

  it('treats a missing due date as "not overdue", not as a payment failure', () => {
    expect(isOverdue(null, '2026-10-15')).toBe(false);
    expect(isOverdue(undefined, '2026-10-15')).toBe(false);
    expect(isOverdue('', '2026-10-15')).toBe(false);
  });
});
