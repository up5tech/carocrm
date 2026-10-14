/**
 * Time zones offered by the pickers. A free-text field would accept anything and then fail at
 * render time, so the list is explicit; the viewer's own zone is added on top by the caller.
 */
export const COMMON_TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Saigon',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Jakarta',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Asia/Dubai',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
];

/** The viewer's browser zone first, then the curated list, without duplicates. */
export function timezoneOptions(): { value: string; label: string }[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Array.from(new Set([local, ...COMMON_TIMEZONES].filter(Boolean))).map((value) => ({ value, label: value }));
}
