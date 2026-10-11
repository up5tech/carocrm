/**
 * Recurrence expansion (PLAN §27 "recurrence where required").
 *
 * EspoCRM core has no recurring activities, so this is a deliberate extension of the
 * data model rather than a compatibility surface. All arithmetic is done in UTC; the
 * caller converts to the viewer's zone at the edge.
 */

export type RepeatType = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';
export type RepeatByMonth = 'Day of month' | 'Day of week';

export interface RecurrenceConfig {
  repeatType?: string | undefined;
  repeatEvery?: number | undefined;
  repeatEndDate?: string | Date | undefined;
  repeatDayOfWeek?: string[] | undefined;
  repeatByMonth?: string | undefined;
}

export interface Occurrence {
  start: Date;
  end: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAYS: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
/** Hard stop so a distant repeatEndDate can never produce an unbounded page. */
export const MAX_OCCURRENCES = 400;

function isoDayOfWeek(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function addMonths(date: Date, months: number, keepDayOfMonth: boolean): Date {
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, date.getUTCHours(), date.getUTCMinutes()));
  if (!keepDayOfMonth) return target;
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target;
}

/** nth weekday of a month, counting from the start; negative counts from the end. */
function weekdayOfMonth(year: number, month: number, isoDay: number, nth: number): Date | undefined {
  const first = new Date(Date.UTC(year, month, 1, 0, 0));
  const offset = (isoDay - isoDayOfWeek(first) + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dayOfMonth = 1 + offset + (nth - 1) * 7;
  if (dayOfMonth > daysInMonth) return undefined;
  return new Date(Date.UTC(year, month, dayOfMonth, first.getUTCHours(), first.getUTCMinutes()));
}

function overlaps(start: Date, end: Date, from: Date, to: Date): boolean {
  return end >= from && start <= to;
}

function timeOfDayOf(date: Date): number {
  return date.getUTCHours() * 3_600_000 + date.getUTCMinutes() * 60_000;
}

/**
 * Returns every occurrence of the activity that intersects `[from, to]`, the base
 * record included, ordered by start. `durationMs` is taken from the stored end when
 * present, otherwise the caller supplies it.
 */
export function expandOccurrences(input: {
  start: Date;
  durationMs: number;
  recurrence: RecurrenceConfig;
  from: Date;
  to: Date;
  max?: number;
}): Occurrence[] {
  const { start, durationMs, recurrence, from, to } = input;
  const limit = input.max ?? MAX_OCCURRENCES;
  const length = Math.max(durationMs, 0);
  const occurrences: Occurrence[] = [];
  const push = (candidate: Date): boolean => {
    if (occurrences.length >= limit) return false;
    const candidateEnd = new Date(candidate.getTime() + length);
    if (overlaps(candidate, candidateEnd, from, to)) occurrences.push({ start: candidate, end: length > 0 ? candidateEnd : null });
    return true;
  };

  const repeatType = recurrence.repeatType;
  if (!repeatType || repeatType === 'None') {
    if (overlaps(start, new Date(start.getTime() + Math.max(length, 0)), from, to)) {
      occurrences.push({ start, end: length > 0 ? new Date(start.getTime() + length) : null });
    }
    return occurrences;
  }

  const every = Math.max(1, Math.trunc(recurrence.repeatEvery ?? 1));
  const until = recurrence.repeatEndDate === undefined ? undefined : new Date(recurrence.repeatEndDate);
  // a repeat end date covers the whole day it names
  const untilMs = until === undefined ? undefined : until.getTime() + DAY_MS - 1;
  const stopped = (candidate: Date): boolean =>
    candidate.getTime() > to.getTime() || (untilMs !== undefined && candidate.getTime() > untilMs);

  if (repeatType === 'Daily') {
    const stepDays = every;
    // skip straight past the window start instead of iterating from the base record
    const firstIndex = Math.max(0, Math.floor((from.getTime() - start.getTime()) / (stepDays * DAY_MS)) - 1);
    for (let i = firstIndex; occurrences.length < limit; i += 1) {
      const candidate = addDays(start, i * stepDays);
      if (stopped(candidate)) break;
      push(candidate);
    }
  } else if (repeatType === 'Weekly') {
    const days = (recurrence.repeatDayOfWeek ?? [])
      .map((day) => ISO_DAYS[day.toLowerCase()])
      .filter((day): day is number => day !== undefined);
    const weekStart = addDays(start, -(isoDayOfWeek(start) - 1));
    const firstWeek = Math.max(0, Math.floor((from.getTime() - weekStart.getTime()) / (every * 7 * DAY_MS)) - 1);
    for (let week = firstWeek; occurrences.length < limit; week += 1) {
      const anchor = addDays(weekStart, week * every * 7);
      // every candidate in the week is at or after the Monday anchor
      if (stopped(anchor)) break;
      const candidates = (days.length > 0 ? days : [isoDayOfWeek(start)]).map((day) => {
        const shifted = addDays(anchor, day - 1);
        return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0) + timeOfDayOf(start));
      });
      for (const candidate of candidates.sort((a, b) => a.getTime() - b.getTime())) {
        if (candidate.getTime() < start.getTime() || stopped(candidate)) continue;
        push(candidate);
      }
    }
  } else if (repeatType === 'Monthly') {
    const months = Math.max(1, every);
    const byDayOfWeek = recurrence.repeatByMonth === 'Day of week';
    const firstIndex = Math.max(0, Math.floor((from.getTime() - start.getTime()) / (31 * DAY_MS * months)) - 1);
    for (let i = firstIndex; occurrences.length < limit; i += 1) {
      const anchor = addMonths(start, i * months, !byDayOfWeek);
      if (stopped(anchor)) break;
      if (byDayOfWeek) {
        const nth = Math.ceil(start.getUTCDate() / 7);
        const day = weekdayOfMonth(anchor.getUTCFullYear(), anchor.getUTCMonth(), isoDayOfWeek(start), nth);
        if (!day) continue;
        const candidate = new Date(day.getTime() + timeOfDayOf(start));
        if (candidate.getTime() < start.getTime() || stopped(candidate)) continue;
        push(candidate);
      } else {
        if (anchor.getTime() < start.getTime()) continue;
        push(anchor);
      }
    }
  } else if (repeatType === 'Yearly') {
    for (let i = 0; occurrences.length < limit; i += 1) {
      const candidate = new Date(Date.UTC(start.getUTCFullYear() + i * every, start.getUTCMonth(), start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes()));
      if (stopped(candidate)) break;
      push(candidate);
    }
  }

  return occurrences.sort((a, b) => a.start.getTime() - b.start.getTime());
}
