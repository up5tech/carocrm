import type { CalendarEvent, DashboardRow,DashletRow } from '../../api/client.js';
import type { ProcessTaskView } from '../../api/types.js';

/**
 * Pure derivations for the home workspace (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * Nothing here touches React or the network, so every rule the page states in prose — which greeting
 * it shows, which day the agenda covers, how many KPI tiles appear, what counts as overdue — is one
 * function that can be read and reasoned about on its own.
 */

export type GreetingPeriod = 'morning' | 'afternoon' | 'evening';

/** Morning before noon, afternoon until 18:00, evening after that. */
export function greetingPeriod(hour: number): GreetingPeriod {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/** The catalog key of the greeting for a local hour. */
export function greetingKey(hour: number): string {
  return `web.home.greeting.${greetingPeriod(hour)}`;
}

export interface DayBounds {
  /** Start of the local day, as the `from` the calendar API expects. */
  from: string;
  /** End of the local day, as the `to` the calendar API expects. */
  to: string;
}

/**
 * The user's local day: midnight to 23:59:59.999 in the browser's time zone — the same day the
 * calendar screen draws, because it computes its range the same way.
 */
export function localDayBounds(now: Date): DayBounds {
  const start = new Date(now.getTime());
  start.setHours(0, 0, 0, 0);
  const end = new Date(now.getTime());
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** `YYYY-MM-DD` of a local date — the key the calendar API groups an event's `day` by. */
export function localDayKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The events the API filed on one day, all-day items first and then by start time.
 *
 * `event.day` is the day the calendar grouped the occurrence into, so this is the same slice the
 * calendar screen's day panel shows — the requested range alone can carry neighbouring days.
 */
export function dayEvents(events: readonly CalendarEvent[], dayKey: string): CalendarEvent[] {
  return events
    .filter((event) => event.day === dayKey)
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.start.localeCompare(b.start);
    });
}

export interface AgendaSlice {
  events: CalendarEvent[];
  /** How many of the day's events the cap kept off the list. */
  hidden: number;
}

/** The day's events, capped; the count that did not fit is reported instead of being dropped. */
export function agendaSlice(events: readonly CalendarEvent[], dayKey: string, cap = 6): AgendaSlice {
  const ofDay = dayEvents(events, dayKey);
  return { events: ofDay.slice(0, cap), hidden: Math.max(0, ofDay.length - cap) };
}

/** A task is overdue when its due instant has passed and nobody has answered it yet. */
export function isTaskOverdue(task: ProcessTaskView, now: Date): boolean {
  if (task.status === 'overdue') return true;
  if (task.status !== 'open' && task.status !== 'escalated') return false;
  if (task.dueAt === null) return false;
  const due = new Date(task.dueAt).getTime();
  return Number.isFinite(due) && due < now.getTime();
}

export function overdueCount(tasks: readonly ProcessTaskView[], now: Date): number {
  return tasks.filter((task) => isTaskOverdue(task, now)).length;
}

/** The tasks that come due soonest — what the focus card lists under its count. */
export function nearestDue(tasks: readonly ProcessTaskView[], limit = 2): ProcessTaskView[] {
  return tasks
    .filter((task) => task.dueAt !== null)
    .slice()
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
    .slice(0, limit);
}

export interface FocusCounts {
  tasks: number;
  overdue: number;
  today: number;
}

/**
 * The one sentence under the greeting: what needs an answer, what is overdue, what is on today.
 * Nothing waiting is said plainly instead of showing a row of zeros.
 */
export function focusSentence(counts: FocusCounts, translate: (key: string, variables?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (counts.tasks > 0) parts.push(translate('web.home.focus.tasks', { count: counts.tasks }));
  if (counts.overdue > 0) parts.push(translate('web.home.focus.overdue', { count: counts.overdue }));
  if (counts.today > 0) parts.push(translate('web.home.focus.today', { count: counts.today }));
  return parts.length > 0 ? parts.join(' · ') : translate('web.home.focus.clear');
}

/** The three KPI dashlets the pulse rail may show, in the order the dashboard declares them. */
export function kpiDashletsOf(dashboard: DashboardRow | null | undefined, limit = 3): DashletRow[] {
  if (!dashboard) return [];
  return dashboard.dashlets
    .filter((dashlet) => dashlet.kind === 'kpi')
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** A short, localized "2h ago" for a stream entry. */
export function relativeLabel(iso: string, now: Date, locale: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const short = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  const minutes = Math.round((then - now.getTime()) / 60_000);
  if (Math.abs(minutes) < 60) return short.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return short.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return short.format(days, 'day');
  return short.format(Math.round(days / 30), 'month');
}

/** Initials for an activity avatar, from the stream author the API already resolved. */
export function authorInitials(author: { firstName: string | null; lastName: string | null; userName: string } | null): string {
  if (!author) return '?';
  const first = (author.firstName ?? author.userName ?? '').trim();
  const last = (author.lastName ?? '').trim();
  const initials = `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
  return initials === '' ? '?' : initials;
}
