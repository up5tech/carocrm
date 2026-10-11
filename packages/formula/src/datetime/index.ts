import { FormulaEvaluationError } from '../errors/index.js';

/**
 * Deterministic date/time helpers (PLAN §22.1). Calendar arithmetic goes through `Intl` with a
 * fixed, validated IANA zone taken from the formula context and month/day names come from
 * built-in English tables, so the same input always yields the same output — no host locale and
 * no ambient clock.
 */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Parsed date argument: an instant plus whether the source was a date-only value. */
export interface FormulaDate {
  epochMs: number;
  dateOnly: boolean;
}

const MS_PER_DAY = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WALL_ONLY = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  try {
    const created = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    // Probe once so an invalid zone fails here, not deep inside a formula.
    created.formatToParts(new Date(0));
    formatters.set(timeZone, created);
    return created;
  } catch {
    throw new FormulaEvaluationError(`Unknown time zone "${timeZone}".`);
  }
}

function pad(value: number, length = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(length, '0');
}

export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  if (!Number.isFinite(epochMs)) throw new FormulaEvaluationError('Date value is not a finite number.');
  const formatter = zoneFormatter(timeZone);
  const list = formatter.formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes, fallback: number): number => {
    const found = list.find((part) => part.type === type)?.value;
    const parsed = found === undefined ? Number.NaN : Number.parseInt(found, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  };
  return {
    year: read('year', 1970),
    month: read('month', 1),
    day: read('day', 1),
    hour: read('hour', 0),
    minute: read('minute', 0),
    second: read('second', 0),
  };
}

function partsToNaiveMs(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetOf(epochMs: number, timeZone: string): number {
  const parts = zonedParts(epochMs, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - epochMs;
}

/** Wall-clock parts in `timeZone` -> epoch ms; the offset is resolved twice so DST edges converge. */
export function zonedToEpoch(parts: ZonedParts, timeZone: string): number {
  const naive = partsToNaiveMs(parts);
  if (timeZone === 'UTC') return naive;
  let guess = naive - offsetOf(naive, timeZone);
  guess = naive - offsetOf(guess, timeZone);
  return guess;
}

export function parseDateValue(input: unknown, timeZone: string): FormulaDate {
  if (input instanceof Date) {
    const ms = input.getTime();
    if (Number.isNaN(ms)) throw new FormulaEvaluationError('Date value is invalid.');
    return { epochMs: ms, dateOnly: false };
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new FormulaEvaluationError('Date value is not a number.');
    return { epochMs: Math.abs(input) > 1e11 ? input : input * 1000, dateOnly: false };
  }
  if (typeof input === 'string') {
    const text = input.trim();
    if (DATE_ONLY.test(text)) {
      const [year, month, day] = text.split('-').map((part) => Number.parseInt(part, 10));
      const epochMs = zonedToEpoch({ year: year ?? 1970, month: month ?? 1, day: day ?? 1, hour: 0, minute: 0, second: 0 }, timeZone);
      return { epochMs, dateOnly: true };
    }
    const wall = WALL_ONLY.exec(text);
    if (wall) {
      const epochMs = zonedToEpoch(
        {
          year: Number(wall[1]),
          month: Number(wall[2]),
          day: Number(wall[3]),
          hour: Number(wall[4]),
          minute: Number(wall[5]),
          second: Number(wall[6] ?? '0'),
        },
        timeZone,
      );
      return { epochMs, dateOnly: false };
    }
    if (text === '') throw new FormulaEvaluationError('Cannot parse an empty string as a date.');
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) throw new FormulaEvaluationError(`"${text}" is not a date.`);
    return { epochMs: parsed, dateOnly: false };
  }
  throw new FormulaEvaluationError('Expected a date value.');
}

/** ISO text in the context zone without an offset marker, so value -> text -> value round-trips. */
export function formatDateValue(date: FormulaDate, timeZone: string): string {
  const parts = zonedParts(date.epochMs, timeZone);
  const day = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  if (date.dateOnly) return day;
  return `${day}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function addCalendarDays(date: FormulaDate, days: number): FormulaDate {
  return { epochMs: date.epochMs + days * MS_PER_DAY, dateOnly: date.dateOnly };
}

/** Month arithmetic keeps the wall-clock day-of-month, clamped to the target month's length. */
export function addCalendarMonths(date: FormulaDate, months: number, timeZone: string): FormulaDate {
  const parts = zonedParts(date.epochMs, timeZone);
  const zeroBased = parts.month - 1 + months;
  const year = parts.year + Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDay);
  return { epochMs: zonedToEpoch({ ...parts, year, month: month + 1, day }, timeZone), dateOnly: date.dateOnly };
}

export function startOfDay(date: FormulaDate, timeZone: string): FormulaDate {
  const parts = zonedParts(date.epochMs, timeZone);
  return { epochMs: zonedToEpoch({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone), dateOnly: date.dateOnly };
}

export function startOfMonth(date: FormulaDate, timeZone: string): FormulaDate {
  const parts = zonedParts(date.epochMs, timeZone);
  return { epochMs: zonedToEpoch({ ...parts, day: 1, hour: 0, minute: 0, second: 0 }, timeZone), dateOnly: date.dateOnly };
}

export function weekdayOf(date: FormulaDate, timeZone: string): number {
  const parts = zonedParts(date.epochMs, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function diffCalendarDays(from: FormulaDate, to: FormulaDate, timeZone: string): number {
  const a = startOfDay(from, timeZone).epochMs;
  const b = startOfDay(to, timeZone).epochMs;
  return Math.round((b - a) / MS_PER_DAY);
}

const PATTERN_TOKENS = /YYYY|YY|MMMM|MMM|MM|M|EEEE|EEE|DD|D|HH|hh|ss|mm|SS/g;

export function formatDateWithPattern(date: FormulaDate, pattern: string, timeZone: string): string {
  const parts = zonedParts(date.epochMs, timeZone);
  const weekday = weekdayOf(date, timeZone);
  return pattern.replace(PATTERN_TOKENS, (token) => {
    switch (token) {
      case 'YYYY':
        return pad(parts.year, 4);
      case 'YY':
        return pad(parts.year % 100);
      case 'MMMM':
        return MONTH_NAMES[parts.month - 1] ?? '';
      case 'MMM':
        return MONTH_SHORT[parts.month - 1] ?? '';
      case 'MM':
        return pad(parts.month);
      case 'M':
        return String(parts.month);
      case 'EEEE':
        return WEEKDAY_NAMES[weekday] ?? '';
      case 'EEE':
        return WEEKDAY_SHORT[weekday] ?? '';
      case 'DD':
        return pad(parts.day);
      case 'D':
        return String(parts.day);
      case 'HH':
        return pad(parts.hour);
      case 'hh':
        return pad(parts.hour % 12 === 0 ? 12 : parts.hour % 12);
      case 'mm':
        return pad(parts.minute);
      case 'ss':
        return pad(parts.second);
      case 'SS':
        return pad(Math.floor(date.epochMs % 1000), 3);
      default:
        return token;
    }
  });
}
