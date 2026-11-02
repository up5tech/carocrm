import { ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-CHAT.21 — server-side relative periods
 * (plans/PLAN_Phase_19_CRM_Chat.md §5.4, §17 `19-CHAT.21`).
 *
 * ## Why the model may not compute a date
 *
 * "Deals closing this quarter" is answerable with the tools that already exist, but only if someone
 * turns *this quarter* into two instants. A model asked to do that itself has to know today's date,
 * the viewer's timezone, where the quarter starts and whether the fiscal year matches the calendar.
 * It usually gets one of those wrong, and the wrong answer is indistinguishable from a data problem:
 * a plausible number over the wrong 90 days.
 *
 * So the model passes a **token** and this module returns the range. The token grammar is closed, the
 * arithmetic is calendar arithmetic in the actor's zone, and the result carries the range it resolved
 * so the answer can state it.
 *
 * ## Timezone handling without a library
 *
 * A CRM stores UTC instants but people mean local midnights. `Intl` is the only timezone database
 * available in the runtime, so a local wall clock is converted by guessing the instant, measuring the
 * offset at that guess, correcting, and measuring again — the second pass is what makes a DST
 * boundary land on the right side. A local midnight that does not exist (a spring-forward at 00:00)
 * resolves to the first instant of that day, which is what a human means by "today".
 */

/** The closed token grammar the model may use. Anything else is rejected before it reaches SQL. */
export const PERIOD_TOKENS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'next_week',
  'this_month',
  'last_month',
  'next_month',
  'this_quarter',
  'last_quarter',
  'next_quarter',
  'this_year',
  'last_year',
  'next_year',
] as const;

export type PeriodToken = (typeof PERIOD_TOKENS)[number];

/** `rolling:30d` — an exact instant window, used for "the last N days" style questions. */
const ROLLING_RE = /^rolling:([1-9][0-9]{0,2})d$/;

const MAX_ROLLING_DAYS = 365;

/** The longest token we accept, so a hostile string cannot reach the parser at all. */
export const PERIOD_TOKEN_MAX_LENGTH = 24;

export interface ResolvedPeriod {
  /** The token as supplied, so the answer can quote what the user asked for. */
  readonly token: string;
  /** Short, stable label: `2026-Q4`, `2026-11`, `2026-W45`, `2026`, `last 30 days`. */
  readonly label: string;
  /** Inclusive start, ISO-8601 UTC. */
  readonly from: string;
  /** Exclusive end, ISO-8601 UTC. */
  readonly to: string;
  /** The zone the calendar arithmetic ran in. */
  readonly timezone: string;
}

/** Whether a string is a token this module can resolve. Used by the tool schemas. */
export function isPeriodToken(value: string): boolean {
  if (value.length === 0 || value.length > PERIOD_TOKEN_MAX_LENGTH) return false;
  if ((PERIOD_TOKENS as readonly string[]).includes(value)) return true;
  const rolling = ROLLING_RE.exec(value);
  if (rolling === null) return false;
  const days = Number(rolling[1]);
  return Number.isInteger(days) && days >= 1 && days <= MAX_ROLLING_DAYS;
}

/**
 * Resolve one token to a half-open instant range in `timeZone`.
 *
 * @param token  a token accepted by {@link isPeriodToken}
 * @param timeZone IANA zone name; the actor's, falling back to the instance default
 * @param now    the reference instant, injected so the result is testable
 */
export function resolvePeriod(token: string, timeZone: string, now: Date): ResolvedPeriod {
  if (!isPeriodToken(token)) {
    throw new ValidationError(`Unknown period "${token}".`, {
      allowed: [...PERIOD_TOKENS, 'rolling:30d'],
    });
  }
  const zone = assertZone(timeZone);
  const today = zonedParts(now, zone);

  const rolling = ROLLING_RE.exec(token);
  if (rolling !== null) {
    const days = Number(rolling[1]);
    const from = new Date(now.getTime() - days * 86_400_000);
    return {
      token,
      label: `last ${String(days)} days`,
      from: from.toISOString(),
      to: now.toISOString(),
      timezone: zone,
    };
  }

  const startOfDay = (date: LocalDate): Date => wallClock(date, zone);
  const startOfWeek = (date: LocalDate): LocalDate => shiftDays(date, -isoWeekday(date));
  const startOfMonth = (date: LocalDate): LocalDate => ({ ...date, day: 1 });
  const startOfQuarter = (date: LocalDate): LocalDate => ({
    year: date.year,
    month: Math.floor((date.month - 1) / 3) * 3 + 1,
    day: 1,
  });
  const startOfYear = (date: LocalDate): LocalDate => ({ year: date.year, month: 1, day: 1 });

  switch (token as PeriodToken) {
    case 'today':
      return range(token, labelDay(today), startOfDay(today), startOfDay(shiftDays(today, 1)), zone);
    case 'yesterday': {
      const yesterday = shiftDays(today, -1);
      return range(token, labelDay(yesterday), startOfDay(yesterday), startOfDay(today), zone);
    }
    case 'this_week': {
      const start = startOfWeek(today);
      return range(token, labelWeek(start), startOfDay(start), startOfDay(shiftDays(start, 7)), zone);
    }
    case 'last_week': {
      const start = shiftDays(startOfWeek(today), -7);
      return range(token, labelWeek(start), startOfDay(start), startOfDay(shiftDays(start, 7)), zone);
    }
    case 'next_week': {
      const start = shiftDays(startOfWeek(today), 7);
      return range(token, labelWeek(start), startOfDay(start), startOfDay(shiftDays(start, 7)), zone);
    }
    case 'this_month': {
      const start = startOfMonth(today);
      return range(token, labelMonth(start), startOfDay(start), startOfDay(addMonths(start, 1)), zone);
    }
    case 'last_month': {
      const start = addMonths(startOfMonth(today), -1);
      return range(token, labelMonth(start), startOfDay(start), startOfDay(addMonths(start, 1)), zone);
    }
    case 'next_month': {
      const start = addMonths(startOfMonth(today), 1);
      return range(token, labelMonth(start), startOfDay(start), startOfDay(addMonths(start, 1)), zone);
    }
    case 'this_quarter': {
      const start = startOfQuarter(today);
      return range(token, labelQuarter(start), startOfDay(start), startOfDay(addMonths(start, 3)), zone);
    }
    case 'last_quarter': {
      const start = addMonths(startOfQuarter(today), -3);
      return range(token, labelQuarter(start), startOfDay(start), startOfDay(addMonths(start, 3)), zone);
    }
    case 'next_quarter': {
      const start = addMonths(startOfQuarter(today), 3);
      return range(token, labelQuarter(start), startOfDay(start), startOfDay(addMonths(start, 3)), zone);
    }
    case 'this_year': {
      const start = startOfYear(today);
      return range(token, String(start.year), startOfDay(start), startOfDay(addMonths(start, 12)), zone);
    }
    case 'last_year': {
      const start = addMonths(startOfYear(today), -12);
      return range(token, String(start.year), startOfDay(start), startOfDay(addMonths(start, 12)), zone);
    }
    case 'next_year': {
      const start = addMonths(startOfYear(today), 12);
      return range(token, String(start.year), startOfDay(start), startOfDay(addMonths(start, 12)), zone);
    }
  }
}

/** `YYYY-MM-DD` in a zone — the value a model should quote when it says "as of". */
export function localDateString(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, assertZone(timeZone));
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

// ---------------------------------------------------------------------------
// calendar arithmetic
// ---------------------------------------------------------------------------

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface ZonedParts extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

/** Rejects a zone `Intl` does not know, with the message an administrator needs to fix it. */
function assertZone(timeZone: string): string {
  const zone = timeZone.trim() === '' ? 'UTC' : timeZone.trim();
  try {
    formatterFor(zone);
  } catch {
    throw new ValidationError(`Unknown time zone "${timeZone}".`, { timezone: timeZone });
  }
  return zone;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? '0';
    return Number.parseInt(value, 10);
  };
  // Some ICU versions report midnight as hour 24 even with h23; both mean the same instant.
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's offset from UTC at one instant, in minutes (east positive). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which the zone's wall clock reads `date 00:00`.
 *
 * Two passes: the first offset is measured at the naive guess, the second at the corrected instant.
 * They differ only across a DST boundary, and in that case the second one is the correct offset.
 */
function wallClock(date: LocalDate, timeZone: string): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  const firstOffset = offsetMinutes(new Date(guess), timeZone);
  let instant = guess - firstOffset * 60_000;
  const secondOffset = offsetMinutes(new Date(instant), timeZone);
  if (secondOffset !== firstOffset) instant = guess - secondOffset * 60_000;
  return new Date(instant);
}

function shiftDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function addMonths(date: LocalDate, months: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1 + months, date.day));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Monday = 0 … Sunday = 6, so `-isoWeekday(date)` walks back to the start of the week. */
function isoWeekday(date: LocalDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (day + 6) % 7;
}

function range(token: string, label: string, from: Date, to: Date, timezone: string): ResolvedPeriod {
  return { token, label, from: from.toISOString(), to: to.toISOString(), timezone };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function labelDay(date: LocalDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

function labelWeek(monday: LocalDate): string {
  // ISO-8601: week 1 is the week containing 4 January, so the Monday of that week is the anchor.
  const thursday = shiftDays(monday, 3);
  const jan4: LocalDate = { year: thursday.year, month: 1, day: 4 };
  const week1Monday = shiftDays(jan4, -isoWeekday(jan4));
  const weeks = Math.round(
    (Date.UTC(monday.year, monday.month - 1, monday.day) - Date.UTC(week1Monday.year, week1Monday.month - 1, week1Monday.day)) /
      (7 * 86_400_000),
  ) + 1;
  return `${pad(thursday.year, 4)}-W${pad(weeks, 2)}`;
}

function labelMonth(date: LocalDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}`;
}

function labelQuarter(date: LocalDate): string {
  return `${pad(date.year, 4)}-Q${String(Math.floor((date.month - 1) / 3) + 1)}`;
}
