/**
 * Phase 19-S.2 — date-only and instant helpers for a commercial document.
 *
 * Commercial documents carry **dates**, not instants: an effective price window, a tax-rate window
 * and a due date all mean "this day", and the comparison must not shift with the viewer's timezone
 * (PLAN_Phase_19_Sales.md §4.14 "date-only semantics consistently"). Everything here is UTC, and a
 * `YYYY-MM-DD` string is the canonical form at every boundary.
 */

import { ValidationError } from "@carocrm/core/errors/index.js";

export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** `date ?? today`, validated; a malformed date is refused rather than coerced. */
export function resolveDay(
  value: string | undefined,
  fallback: Date = new Date(),
): string {
  if (value === undefined || value === "") return utcDay(fallback);
  if (!isDateOnly(value)) {
    throw new ValidationError(`"${value}" is not a YYYY-MM-DD date.`, {
      date: value,
    });
  }
  return value;
}

/**
 * A stored date attribute as its `YYYY-MM-DD` day.
 *
 * The Entity Engine may hand a `date` field back as an ISO instant (`2026-10-15T00:00:00.000Z`) when
 * the record was written through a path that coerced it to a `Date`. A commercial date is a calendar
 * day, so both forms are accepted and the UTC day is taken — the same rule Projects applies with
 * `dayValue` (`apps/api/src/projects/project-domain.ts`).
 */
export function storedDay(value: unknown): string | undefined {
  if (value instanceof Date) return utcDay(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}
