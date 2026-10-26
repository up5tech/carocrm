import { describe, expect, it } from 'vitest';

import { formatClock, formatDateTime, formatNumber, formatRelative } from './i18n.js';

/**
 * §20.23: dates and numbers go through Intl with the active locale/timezone, never a raw ISO slice
 * and never `new Date(x).toLocaleString()` (which uses the host zone). The formatters are pure, so
 * they are the cheapest thing to pin down without a DOM.
 */
describe('formatters (§20.23)', () => {
  it('formatDateTime renders a real date, not an ISO slice', () => {
    const out = formatDateTime('2026-01-01T00:00:00Z');
    expect(out).toContain('2026');
    expect(out).not.toContain('T00:00:00');
  });

  it('formatDateTime keeps a late-31-December instant in the right year', () => {
    expect(formatDateTime('2025-12-31T23:30:00Z')).toContain('2025');
  });

  it('formatRelative describes recency instead of printing a date', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    expect(formatRelative('2026-01-01T11:57:00Z', now)).toMatch(/minute/i);
  });

  it('formatNumber is locale-aware', () => {
    expect(formatNumber(1234.5)).toBe('1,234.5');
  });

  it('formatClock prints a time only', () => {
    expect(formatClock('2026-01-01T09:30:00Z')).toContain('09:30');
  });

  it('returns the input unchanged for an unparseable value rather than "Invalid Date"', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
