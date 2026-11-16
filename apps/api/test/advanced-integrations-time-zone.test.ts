import { describe, expect, it } from 'vitest';

import { eventBoundaryToInstant, startOfDayInZone } from '../src/advanced-integrations/connectors/kit/time-zone.js';

/**
 * Phase 24.7 — the calendar time-zone rules.
 *
 * A timed event boundary is an instant and is normalized to UTC as-is; an **all-day** event is a
 * calendar date with no time and no offset, and is anchored at midnight **in the event's own zone**
 * — `new Date('2026-01-07')` would read it as midnight UTC, which in any negative-offset zone is
 * the previous day. The rules are pure, so these tests are DB-free.
 */

describe('Phase 24.7 — the calendar time-zone rules', () => {
  it('reads a timed event boundary as the UTC instant it already is', () => {
    expect(eventBoundaryToInstant('2026-01-05T09:00:00+07:00', 'Asia/Bangkok')).toBe('2026-01-05T02:00:00.000Z');
    expect(eventBoundaryToInstant('2026-01-06T14:00:00.000Z', null)).toBe('2026-01-06T14:00:00.000Z');
    expect(eventBoundaryToInstant('not-a-date', 'UTC')).toBeNull();
  });

  it('anchors an all-day event at midnight in its own zone, not at midnight UTC', () => {
    // 2026-01-07 in +07:00 is 2026-01-06T17:00:00Z — midnight local, not the previous day's midnight UTC.
    expect(eventBoundaryToInstant('2026-01-07', 'Asia/Bangkok')).toBe('2026-01-06T17:00:00.000Z');
    // No zone was sent, so the fallback is midnight UTC.
    expect(eventBoundaryToInstant('2026-01-07', '')).toBe('2026-01-07T00:00:00.000Z');
  });

  it('resolves the zone offset twice, so a daylight-saving boundary keeps the second reading', () => {
    // America/New_York starts DST on 2026-03-08, so midnight on that date is EST (−05:00), not EDT.
    expect(startOfDayInZone('2026-03-08', 'America/New_York')).toEqual(new Date('2026-03-08T05:00:00.000Z'));
    expect(startOfDayInZone('2026-01-07', 'America/New_York')).toEqual(new Date('2026-01-07T05:00:00.000Z'));
  });

  it('returns null for a boundary that is not a usable instant and for an unknown zone', () => {
    expect(startOfDayInZone('2026-01-07T00:00:00.000Z', 'UTC')).toBeNull();
    expect(startOfDayInZone('2026-01-07', 'Not/AZone')).toBeNull();
    expect(eventBoundaryToInstant('', 'UTC')).toBeNull();
  });
});
