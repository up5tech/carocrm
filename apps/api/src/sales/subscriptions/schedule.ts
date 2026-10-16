/**
 * Phase 19-S.16 — the billing calendar, as pure date arithmetic.
 *
 * A subscription's periods are a function of four facts and nothing else: where the term starts,
 * how long the term runs, how often it bills, and how far ahead of a period the invoice is planned.
 * That makes the schedule worth keeping pure and separately testable: "does a job replay compute the
 * same windows?", "does lead time actually hold a period back?", "can a month-end anchor produce a
 * zero-length or infinite run of periods?" are all answered here without a database, a clock or a
 * socket — which is what makes an idempotent period claim possible at all (§4.14).
 *
 * **Date-only semantics.** Everything is a calendar day in UTC, `YYYY-MM-DD`, exactly like
 * `clock.ts` and the rest of the module (§4.14 "honour time zones/date-only semantics consistently").
 * A period boundary is a day, never an instant, so a subscription does not shift a billing date when
 * the server's timezone or a viewer's differs.
 *
 * **Deterministic windows.** Each window is derived from the previous one by stepping the anchor,
 * so the same subscription always yields the same windows in the same order. Month-end anchors clamp
 * forward (`2026-01-31 → 2026-02-28`) instead of overflowing into March, and the step always moves
 * forward, so a window walk terminates.
 */

import { ValidationError } from "@carocrm/core/errors/index.js";

/**
 * Billing intervals this module supports. Every one of them is a whole number of days or months, so
 * a period boundary is always exact — an "every 4 weeks, 3 days" style interval would make
 * `plannedInvoiceDate` ambiguous at month ends.
 */
export const BILLING_INTERVALS = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "halfYearly",
  "annual",
] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** The subscription states that may still produce a period or an invoice (§4.14). */
export const BILLABLE_SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "renewed",
  "billingFailed",
] as const;

export type BillableSubscriptionStatus =
  (typeof BILLABLE_SUBSCRIPTION_STATUSES)[number];

/** Every state a subscription may hold; the ones outside the billable set are terminal or paused. */
export const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "paused",
  "ended",
  "cancelled",
  "billingFailed",
  "renewed",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The states a period may hold. `processing` is the claim a run holds while it bills. */
export const SUBSCRIPTION_PERIOD_STATUSES = [
  "pending",
  "processing",
  "invoiced",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type SubscriptionPeriodStatus =
  (typeof SUBSCRIPTION_PERIOD_STATUSES)[number];

/**
 * How long each interval covers, split by unit.
 *
 * The two units are kept apart on purpose: `quarterly` is *three months*, and reading that three out
 * of a day-count table would bill a quarter in three days.
 */
const INTERVAL_DAYS: Readonly<Record<string, number>> = {
  daily: 1,
  weekly: 7,
};

const INTERVAL_MONTHS: Readonly<Record<string, number>> = {
  monthly: 1,
  quarterly: 3,
  halfYearly: 6,
  annual: 12,
};

export function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

export function isBillableStatus(value: string): value is BillableSubscriptionStatus {
  return (BILLABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * The interval to schedule with.
 *
 * A record created before an interval existed, or one written by an import that did not know the
 * vocabulary, must not stop the billing run with a crash — it schedules as `monthly`, the default the
 * entity metadata declares. A value that *is* in the vocabulary is never rewritten.
 */
export function normalizeInterval(value: unknown): BillingInterval {
  const candidate = typeof value === "string" ? value.trim() : "";
  return isBillingInterval(candidate) ? candidate : "monthly";
}

function intervalDays(interval: BillingInterval): number | null {
  return INTERVAL_DAYS[interval] ?? null;
}

function intervalMonths(interval: BillingInterval): number | null {
  return INTERVAL_MONTHS[interval] ?? null;
}

const DAY_MS = 86_400_000;

function atUtcDay(day: string): Date {
  return new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
}

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `day` shifted by `days`, clamped to nothing — plain calendar arithmetic. */
export function addDays(day: string, days: number): string {
  const date = atUtcDay(day);
  date.setUTCDate(date.getUTCDate() + days);
  return toDay(date);
}

/**
 * `day` shifted by `months`, clamping to the last day of the target month.
 *
 * An anchor set on the 31st walks `2026-01-31 → 2026-02-28 → 2026-03-28` rather than overflowing
 * into March and losing a day. The anchor is not restored afterwards: the walk is monotonic, which
 * is what guarantees termination.
 */
export function addMonths(day: string, months: number): string {
  const date = atUtcDay(day);
  const anchorDay = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  if (date.getUTCDate() !== anchorDay) date.setUTCDate(0);
  return toDay(date);
}

/** The last day of the period a `start` opens with this interval (inclusive). */
export function periodEndFor(start: string, interval: BillingInterval): string {
  const days = intervalDays(interval);
  if (days !== null) return addDays(start, days - 1);
  return addDays(addMonths(start, intervalMonths(interval) ?? 1), -1);
}

/** Where the next period opens. Always strictly after `start`. */
export function nextPeriodStart(
  start: string,
  interval: BillingInterval,
): string {
  const days = intervalDays(interval);
  if (days !== null) return addDays(start, days);
  return addMonths(start, intervalMonths(interval) ?? 1);
}

/**
 * When the invoice for a period is *planned*.
 *
 * Billing in advance is the normal case, so the planned date is the period start pulled back by the
 * lead time. A zero lead time plans the invoice on the first day of the period it bills (§4.14 "do
 * not generate invoices early when period policy says billing is pending").
 */
export function plannedInvoiceDateFor(
  periodStart: string,
  leadTimeDays: number,
): string {
  return addDays(periodStart, -Math.max(0, Math.trunc(leadTimeDays)));
}

export interface PeriodWindow {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly plannedInvoiceDate: string;
}

export interface PeriodWalkInput {
  /** The subscription's `startDate` — a `YYYY-MM-DD` day. */
  readonly startDate: string;
  /** The term end, or `null` for an open-ended (auto-renewing) term. */
  readonly endDate: string | null;
  readonly interval: string;
  readonly leadTimeDays: number;
}

export interface PeriodWalkOptions {
  /**
   * The last day a window may end on. A run passes the subscription's `endDate` here; the caller is
   * free to narrow it further (the default billing run stops at its own horizon).
   */
  readonly lastPeriodEnd: string;
  /** How many windows to return. The caller pages by lowering the window's start, never by guessing. */
  readonly limit: number;
}

/**
 * Walk the period windows from `startDate`, stopping at `lastPeriodEnd` or after `limit` windows.
 *
 * The walk is total: `limit` bounds it, and every step is asserted to move forward, so a subscription
 * can never spin a job run on a bad interval or a term that ends before it starts.
 */
export function periodWindows(
  input: PeriodWalkInput,
  options: PeriodWalkOptions,
): PeriodWindow[] {
  const interval = normalizeInterval(input.interval);
  const leadTimeDays = Number.isFinite(input.leadTimeDays)
    ? input.leadTimeDays
    : 0;
  const last = options.lastPeriodEnd;
  const limit = Math.max(0, Math.trunc(options.limit));

  const windows: PeriodWindow[] = [];
  if (limit === 0) return windows;
  if (input.endDate !== null && input.startDate > input.endDate) return windows;

  let cursor = input.startDate;
  while (cursor <= last && windows.length < limit) {
    let end = periodEndFor(cursor, interval);
    if (input.endDate !== null && end > input.endDate) end = input.endDate;
    if (end < cursor) break;

    windows.push({
      periodStart: cursor,
      periodEnd: end,
      plannedInvoiceDate: plannedInvoiceDateFor(cursor, leadTimeDays),
    });

    const next = nextPeriodStart(cursor, interval);
    // A step that does not advance would repeat this window forever; stop rather than loop.
    if (next <= cursor) break;
    cursor = next;
  }
  return windows;
}

/** The stable identity of a billing window — the idempotency key material (§6.3). */
export function periodKey(subscriptionId: string, window: PeriodWindow): string {
  return `${subscriptionId}:${window.periodStart}:${window.periodEnd}`;
}

/** Whether a planned invoice date has arrived (`runDay` is the day the run is acting as of). */
export function isDue(plannedInvoiceDate: string, runDay: string): boolean {
  return plannedInvoiceDate <= runDay;
}

/** Why a period cannot be billed right now, or `null` when it can. */
export function ineligibilityReason(
  periodStatus: string,
  subscriptionStatus: string,
  plannedInvoiceDate: string,
  runDay: string,
): string | null {
  if (periodStatus === "invoiced") return "alreadyInvoiced";
  if (periodStatus === "cancelled") return "notEligible";
  if (periodStatus === "skipped") return "notEligible";
  if (!isBillableStatus(subscriptionStatus)) return "subscriptionNotActive";
  if (!isDue(plannedInvoiceDate, runDay)) return "notDueYet";
  return null;
}

/**
 * The state change a `pause`/`resume`/`cancel` command is allowed to make, or the refusal naming
 * why it cannot.
 *
 * The rules are deliberately small and stated rather than implied: a cancelled or ended term is
 * terminal, a paused term does not bill, and cancelling a paused term is allowed (that is how an
 * operator stops billing without resuming it first).
 */
export function subscriptionTransitionRefusal(
  action: "pause" | "resume" | "cancel",
  status: string,
): string | null {
  if (action === "pause") {
    if (status === "paused") return `A ${status} subscription is already paused.`;
    if (status === "cancelled" || status === "ended")
      return `A ${status} subscription cannot be paused.`;
    return null;
  }
  if (action === "resume") {
    if (status !== "paused") return `Only a paused subscription can be resumed; this one is "${status}".`;
    return null;
  }
  // cancel
  if (status === "cancelled") return "This subscription is already cancelled.";
  if (status === "ended")
    return `An ended subscription cannot be cancelled; it has already finished its term.`;
  return null;
}

/** Refuse a term that cannot describe a billable schedule, with the facts that are wrong. */
export function assertScheduleInput(input: {
  readonly startDate: string;
  readonly endDate: string | null;
  readonly interval: string;
  readonly leadTimeDays: number;
}): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
    throw new ValidationError(`"${input.startDate}" is not a YYYY-MM-DD date.`, {
      startDate: input.startDate,
    });
  }
  if (input.endDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    throw new ValidationError(`"${input.endDate}" is not a YYYY-MM-DD date.`, {
      endDate: input.endDate,
    });
  }
  if (
    input.endDate !== null &&
    input.endDate < input.startDate
  ) {
    throw new ValidationError(
      "A subscription cannot end before it starts.",
      { startDate: input.startDate, endDate: input.endDate },
    );
  }
  if (input.leadTimeDays < 0 || !Number.isInteger(input.leadTimeDays)) {
    throw new ValidationError(
      "A subscription's billing lead time is a whole number of days and cannot be negative.",
      { leadTimeDays: input.leadTimeDays },
    );
  }
}

/** Days between two `YYYY-MM-DD` days, sign included. */
export function daysBetween(from: string, to: string): number {
  return Math.round((atUtcDay(to).getTime() - atUtcDay(from).getTime()) / DAY_MS);
}