import { ValidationError } from '@carocrm/core/errors/index.js';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  assertScheduleInput,
  daysBetween,
  ineligibilityReason,
  isBillableStatus,
  nextPeriodStart,
  normalizeInterval,
  periodEndFor,
  periodKey,
  type PeriodWindow,
  periodWindows,
  plannedInvoiceDateFor,
  subscriptionTransitionRefusal,
} from '../src/sales/subscriptions/schedule.js';

/**
 * Phase 19-S.16 — the billing calendar, with no database, no clock and no socket.
 *
 * Every acceptance criterion that can be settled by arithmetic is settled here, which is what makes
 * the idempotency guarantees in `subscription.service.ts` checkable at all: if a replay recomputes
 * the same windows from the same four facts, a duplicate period is impossible by construction rather
 * than by luck.
 *
 *  - the windows are **deterministic** — the same subscription always yields the same periods, so a
 *    replay recomputes an identical identity;
 *  - the walk **terminates**, including at a month-end anchor where an off-by-one would otherwise
 *    produce a zero-length period or an infinite loop;
 *  - **lead time holds a period back**: `plannedInvoiceDate` is the period start pulled back, and a
 *    zero lead time plans it on the first day of the period;
 *  - a term that ends mid-period **truncates** the last window instead of billing past its end;
 *  - the lifecycle rules refuse the transitions that would resurrect a cancelled or ended term.
 */

const HORIZON = { lastPeriodEnd: '2027-12-31', limit: 500 };

describe('19-S.16 billing intervals', () => {
  it('adds days across a month and a leap boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('clamps a month-end anchor instead of overflowing into the next month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-30', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('falls back to monthly for an interval outside the supported vocabulary', () => {
    expect(normalizeInterval('monthly')).toBe('monthly');
    expect(normalizeInterval('fortnightly')).toBe('monthly');
    expect(normalizeInterval(undefined)).toBe('monthly');
    expect(normalizeInterval('')).toBe('monthly');
  });
});

describe('19-S.16 period windows', () => {
  it('produces whole calendar months from an anchor, inclusive of both ends', () => {
    const windows = periodWindows(
      { startDate: '2026-03-01', endDate: null, interval: 'monthly', leadTimeDays: 0 },
      { lastPeriodEnd: '2026-05-31', limit: 10 },
    );
    expect(windows).toEqual([
      { periodStart: '2026-03-01', periodEnd: '2026-03-31', plannedInvoiceDate: '2026-03-01' },
      { periodStart: '2026-04-01', periodEnd: '2026-04-30', plannedInvoiceDate: '2026-04-01' },
      { periodStart: '2026-05-01', periodEnd: '2026-05-31', plannedInvoiceDate: '2026-05-01' },
    ]);
  });

  it('never emits a window that runs past the term, and truncates the final one', () => {
    const windows = periodWindows(
      { startDate: '2026-01-01', endDate: '2026-02-15', interval: 'monthly', leadTimeDays: 0 },
      { lastPeriodEnd: '2026-12-31', limit: 50 },
    );
    expect(windows.map((w) => w.periodEnd)).toEqual(['2026-01-31', '2026-02-15']);
  });

  it('holds a period back by exactly the lead time, and bills on day one at zero', () => {
    expect(plannedInvoiceDateFor('2026-03-01', 0)).toBe('2026-03-01');
    expect(plannedInvoiceDateFor('2026-03-01', 20)).toBe('2026-02-09');
    expect(plannedInvoiceDateFor('2026-03-01', 31)).toBe('2026-01-29');
    // A negative lead time is not "bill in the future"; it is treated as none.
    expect(plannedInvoiceDateFor('2026-03-01', -5)).toBe('2026-03-01');

    const windows = periodWindows(
      { startDate: '2026-03-01', endDate: null, interval: 'monthly', leadTimeDays: 20 },
      { lastPeriodEnd: '2026-03-31', limit: 5 },
    );
    expect(windows[0]?.plannedInvoiceDate).toBe('2026-02-09');
  });

  it('covers every supported interval with a whole number of days or months', () => {
    const cases: ReadonlyArray<[string, string, string]> = [
      ['daily', '2026-03-01', '2026-03-01'],
      ['weekly', '2026-03-01', '2026-03-07'],
      ['monthly', '2026-03-01', '2026-03-31'],
      ['quarterly', '2026-01-01', '2026-03-31'],
      ['halfYearly', '2026-01-01', '2026-06-30'],
      ['annual', '2026-01-01', '2026-12-31'],
    ];
    for (const [interval, start, end] of cases) {
      expect([interval, periodEndFor(start, normalizeInterval(interval))]).toEqual([interval, end]);
    }
  });

  it('keeps a month-end anchor monotonic, so the walk cannot stall or repeat', () => {
    let cursor = '2026-01-31';
    for (let index = 0; index < 24; index += 1) {
      const next = nextPeriodStart(cursor, 'monthly');
      expect(next > cursor).toBe(true);
      cursor = next;
    }
    // 31st → 28th → 28th … never back to the 31st, never backwards.
    expect(cursor).toBe('2028-01-28');

    const windows = periodWindows(
      { startDate: '2026-01-31', endDate: null, interval: 'monthly', leadTimeDays: 0 },
      { lastPeriodEnd: '2027-12-31', limit: 24 },
    );
    expect(windows).toHaveLength(24);
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1];
      const current = windows[index];
      expect(current?.periodStart > (previous?.periodEnd ?? '')).toBe(true);
    }
  });

  it('bounds the walk by the caller limit instead of running to the horizon', () => {
    const windows = periodWindows(
      { startDate: '2026-01-01', endDate: null, interval: 'daily', leadTimeDays: 0 },
      { lastPeriodEnd: '2030-01-01', limit: 5 },
    );
    expect(windows).toHaveLength(5);
    expect(windows[4]?.periodEnd).toBe('2026-01-05');
  });

  it('returns nothing for a term that cannot describe a window', () => {
    expect(
      periodWindows(
        { startDate: '2026-05-01', endDate: '2026-04-01', interval: 'monthly', leadTimeDays: 0 },
        { lastPeriodEnd: '2026-12-31', limit: 10 },
      ),
    ).toEqual([]);
    expect(
      periodWindows(
        { startDate: '2027-01-01', endDate: null, interval: 'monthly', leadTimeDays: 0 },
        { lastPeriodEnd: '2026-12-31', limit: 10 },
      ),
    ).toEqual([]);
  });

  it('gives the same window the same identity on every replay', () => {
    const input = { startDate: '2026-03-01', endDate: null, interval: 'monthly', leadTimeDays: 5 } as const;
    const first = periodWindows(input, HORIZON);
    const second = periodWindows(input, HORIZON);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(periodKey('sub-1', first[0] as PeriodWindow)).toBe('sub-1:2026-03-01:2026-03-31');
    // The same windows in the same order, on every run.
    expect(periodKey('sub-1', first[0] as PeriodWindow)).toBe(periodKey('sub-1', second[0] as PeriodWindow));
    expect(first.map((window) => window.periodStart)).toEqual(second.map((window) => window.periodStart));
    // A different subscription never shares a period identity.
    expect(periodKey('sub-2', first[0] as PeriodWindow)).not.toBe(periodKey('sub-1', first[0] as PeriodWindow));
  });
});

describe('19-S.16 billing eligibility', () => {
  it('refuses to bill a period that already has an invoice, or a terminal one', () => {
    expect(ineligibilityReason('invoiced', 'active', '2026-01-01', '2026-03-01')).toBe('alreadyInvoiced');
    expect(ineligibilityReason('cancelled', 'active', '2026-01-01', '2026-03-01')).toBe('notEligible');
    expect(ineligibilityReason('skipped', 'active', '2026-01-01', '2026-03-01')).toBe('notEligible');
  });

  it('refuses a period whose planned invoice date has not arrived', () => {
    expect(ineligibilityReason('pending', 'active', '2026-03-05', '2026-03-01')).toBe('notDueYet');
    expect(ineligibilityReason('pending', 'active', '2026-03-01', '2026-03-01')).toBeNull();
    expect(ineligibilityReason('pending', 'active', '2026-02-28', '2026-03-01')).toBeNull();
  });

  it('refuses a period whose subscription is not in a billable state', () => {
    expect(ineligibilityReason('pending', 'paused', '2026-01-01', '2026-03-01')).toBe('subscriptionNotActive');
    expect(ineligibilityReason('pending', 'cancelled', '2026-01-01', '2026-03-01')).toBe('subscriptionNotActive');
    expect(ineligibilityReason('pending', 'active', '2026-01-01', '2026-03-01')).toBeNull();
  });

  it('treats pending and billingFailed as billable, and paused or ended as not', () => {
    expect(isBillableStatus('pending')).toBe(true);
    expect(isBillableStatus('active')).toBe(true);
    expect(isBillableStatus('renewed')).toBe(true);
    // A failed subscription must still be billable, or a transient failure would end the term.
    expect(isBillableStatus('billingFailed')).toBe(true);
    expect(isBillableStatus('paused')).toBe(false);
    expect(isBillableStatus('ended')).toBe(false);
    expect(isBillableStatus('cancelled')).toBe(false);
  });
});

describe('19-S.16 subscription lifecycle', () => {
  it('pauses and resumes only where the state allows it', () => {
    expect(subscriptionTransitionRefusal('pause', 'active')).toBeNull();
    expect(subscriptionTransitionRefusal('pause', 'paused')).toContain('already paused');
    expect(subscriptionTransitionRefusal('pause', 'cancelled')).toContain('cannot be paused');
    expect(subscriptionTransitionRefusal('resume', 'paused')).toBeNull();
    expect(subscriptionTransitionRefusal('resume', 'active')).toContain('Only a paused subscription');
  });

  it('never resurrects a cancelled or ended term', () => {
    expect(subscriptionTransitionRefusal('cancel', 'active')).toBeNull();
    // A paused term may be cancelled directly: that is how an operator stops billing without resuming.
    expect(subscriptionTransitionRefusal('cancel', 'paused')).toBeNull();
    expect(subscriptionTransitionRefusal('cancel', 'cancelled')).toContain('already cancelled');
    expect(subscriptionTransitionRefusal('cancel', 'ended')).toContain('already finished');
  });
});

describe('19-S.16 schedule validation', () => {
  it('refuses a malformed or inverted term by naming the field', () => {
    expect(() =>
      assertScheduleInput({ startDate: '01/03/2026', endDate: null, interval: 'monthly', leadTimeDays: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      assertScheduleInput({ startDate: '2026-03-01', endDate: '2026-02-01', interval: 'monthly', leadTimeDays: 0 }),
    ).toThrow(/cannot end before it starts/);
    expect(() =>
      assertScheduleInput({ startDate: '2026-03-01', endDate: null, interval: 'monthly', leadTimeDays: -1 }),
    ).toThrow(/whole number of days/);
    expect(() =>
      assertScheduleInput({ startDate: '2026-03-01', endDate: null, interval: 'monthly', leadTimeDays: 1.5 }),
    ).toThrow(/whole number of days/);
  });

  it('accepts a well-formed term and measures the days between two anchors', () => {
    expect(() =>
      assertScheduleInput({ startDate: '2026-03-01', endDate: '2027-03-01', interval: 'quarterly', leadTimeDays: 3 }),
    ).not.toThrow();
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysBetween('2026-03-31', '2026-03-01')).toBe(-30);
  });
});