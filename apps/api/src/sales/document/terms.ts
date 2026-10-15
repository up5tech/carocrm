import { ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-S.8 / 19-S.9 — payment terms and the dates they produce (§4.6, §4.7).
 *
 * A due date is not a free-text field an operator guesses: it is the document date plus the terms the
 * document references, and both the invoice and the eventual supplier bill have to compute it the same
 * way. So the arithmetic lives here, pure and clock-free — every function takes the day it should use,
 * which is also what makes the behaviour testable without waiting for tomorrow.
 *
 * Days are `YYYY-MM-DD` strings in UTC, the same convention `clock.ts` uses for every effective window
 * in this module. No `Date` object ever crosses a boundary.
 */

export type PaymentTermBasis = 'net' | 'endOfMonth';

export const PAYMENT_TERM_BASES: readonly PaymentTermBasis[] = ['net', 'endOfMonth'];

/** The policy slice a due-date calculation needs. */
export interface PaymentTerms {
  readonly dueDays: number;
  readonly basis: PaymentTermBasis;
}

export const DEFAULT_PAYMENT_TERMS: PaymentTerms = { dueDays: 30, basis: 'net' };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Parse a `YYYY-MM-DD` day into a UTC epoch, refusing anything that is not a real calendar day. */
export function parseDay(day: string): number {
  if (!DAY_PATTERN.test(day)) {
    throw new ValidationError(`"${day}" is not a YYYY-MM-DD date.`, { day });
  }
  const epoch = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) {
    throw new ValidationError(`"${day}" is not a valid calendar date.`, { day });
  }
  // `Date.parse` happily rolls 2026-02-30 over to March; reject the roll-over instead.
  if (formatDay(epoch) !== day) {
    throw new ValidationError(`"${day}" is not a valid calendar date.`, { day });
  }
  return epoch;
}

export function formatDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Add whole days. Negative values move backwards, which is how a credit period is expressed. */
export function addDays(day: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new ValidationError('A day offset must be a whole number.', { days });
  }
  return formatDay(parseDay(day) + days * MS_PER_DAY);
}

/** The last day of the month the given day falls in. */
export function endOfMonth(day: string): string {
  const epoch = parseDay(day);
  const date = new Date(epoch);
  // Day 0 of the next month is the last day of this one.
  return formatDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

/**
 * The due date for a document dated `documentDate` under `terms`.
 *
 *  - `net`: document date + `dueDays`.
 *  - `endOfMonth`: the end of the document date's month + `dueDays`. This is the convention that makes
 *    "30 days end of month" mean the same thing to both parties regardless of when the invoice was
 *    raised, which is why it is a separate basis rather than an offset an operator has to compute.
 *
 * `dueDays` of zero is legal and means "due on the day the basis lands", not "no due date".
 */
export function dueDateFor(documentDate: string, terms: PaymentTerms = DEFAULT_PAYMENT_TERMS): string {
  if (!Number.isInteger(terms.dueDays) || terms.dueDays < 0 || terms.dueDays > 3_650) {
    throw new ValidationError('Payment terms must have a whole number of days between 0 and 3650.', { dueDays: terms.dueDays });
  }
  if (!PAYMENT_TERM_BASES.includes(terms.basis)) {
    throw new ValidationError(`Payment terms basis must be one of: ${PAYMENT_TERM_BASES.join(', ')}.`, { basis: terms.basis });
  }
  const anchor = terms.basis === 'endOfMonth' ? endOfMonth(documentDate) : documentDate;
  return addDays(anchor, terms.dueDays);
}

/**
 * Whether a document with this due date is overdue on `today`.
 *
 * Overdue is `today > dueDate`: a document is not late on the day it falls due. A document with no due
 * date is never overdue — an absent term is a configuration gap, not a payment failure.
 */
export function isOverdue(dueDate: string | null | undefined, today: string): boolean {
  if (dueDate === null || dueDate === undefined || dueDate === '') return false;
  return parseDay(dueDate) < parseDay(today);
}

/** Days between two days, signed. Used for ageing buckets and for explaining an overdue document. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / MS_PER_DAY);
}
