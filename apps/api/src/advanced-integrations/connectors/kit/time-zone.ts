/**
 * Phase 24.7 — the time-zone rules for a calendar instant.
 *
 * A provider reports a timed event as an **instant** (`2026-01-05T09:00:00+07:00`), and every
 * consumer — the CRM `datetime` field, the audit row, the SPA's `formatDateTime` — wants that
 * instant in UTC. Parsing the provider's string does that already.
 *
 * An **all-day** event is different: it reports a *calendar date* (`2026-01-07`) with no time and
 * no offset, and a date is not an instant. `new Date('2026-01-07')` reads it as midnight **UTC**,
 * which in any negative-offset zone is the *previous day* — the meeting silently moves. The date
 * belongs to the calendar's own zone, so the rule is: an all-day event starts at midnight in the
 * event's time zone, and the instant is that midnight expressed in UTC.
 *
 * The conversion uses `Intl.DateTimeFormat`, which is the only time-zone database in the runtime.
 * The offset of a zone depends on the instant (daylight saving), so the offset is resolved twice:
 * once for the naive guess, and once more for the corrected guess. A zone that changes its offset
 * between the two (the hour around a DST switch) keeps the second answer, which is the offset that
 * applies to the resulting instant.
 */

/** The offset of a zone at an instant, in milliseconds (east of UTC is positive). */
function zoneOffsetMs(instantMs: number, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instantMs));
  } catch {
    // An unknown zone is not a reason to fail a sync: the caller falls back to UTC.
    return null;
  }
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    return part === undefined ? 0 : Number.parseInt(part.value, 10);
  };
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return asUtc - instantMs;
}

/** Whether a string is a plain calendar date (`YYYY-MM-DD`). */
function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The UTC instant of midnight on a calendar date **in the given zone**.
 *
 * Returns `null` when the date is not a calendar date or the zone is unknown, so the caller can
 * decide what to do rather than receiving a wrong instant.
 */
export function startOfDayInZone(calendarDate: string, timeZone: string | null | undefined): Date | null {
  if (!isCalendarDate(calendarDate)) return null;
  const zone = (timeZone ?? '').trim();
  const [year, month, day] = calendarDate.split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) return null;
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  if (zone === '') return new Date(naive);
  const firstOffset = zoneOffsetMs(naive, zone);
  if (firstOffset === null) return null;
  const candidate = naive - firstOffset;
  const secondOffset = zoneOffsetMs(candidate, zone);
  if (secondOffset === null) return null;
  // A zone whose offset differs between the two readings sits on a daylight-saving boundary; the
  // second reading is the one that applies to the candidate instant.
  const settled = secondOffset === firstOffset ? candidate : naive - secondOffset;
  return new Date(settled);
}

/**
 * The instant a provider's event boundary means.
 *
 * A **timed** boundary already carries an offset and is returned as it is — normalized to UTC so
 * every consumer sees the same string. An **all-day** boundary is a calendar date and is anchored
 * at midnight in the event's zone.
 */
export function eventBoundaryToInstant(
  boundary: string,
  timeZone: string | null | undefined,
): string | null {
  const value = boundary.trim();
  if (value === '') return null;
  if (isCalendarDate(value)) {
    const start = startOfDayInZone(value, timeZone);
    return start === null ? null : start.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
