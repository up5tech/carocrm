import {
  AuthorizationDeniedError,
  DuplicateRecordError,
  NotFoundError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import { OutboxService } from "../../common/outbox.service.js";
import type { DbTx } from "../../database/database.service.js";
import { DatabaseService } from "../../database/database.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import { resolveDay, storedDay, utcDay } from "../clock.js";
import { SalesDocumentService } from "../document/document.service.js";
import type { RequestedLine } from "../document/line-items.js";
import { SalesBalanceService } from "../payments/balance.service.js";
import { runAsSalesInternal } from "../sales-internal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import { SalesSettingsService } from "../sales-settings.service.js";
import {
  addDays,
  assertScheduleInput,
  ineligibilityReason,
  isBillableStatus,
  normalizeInterval,
  periodEndFor,
  periodKey,
  type PeriodWindow,
  periodWindows,
  subscriptionTransitionRefusal,
} from "./schedule.js";

/**
 * Phase 19-S.16 — subscriptions and recurring invoice generation.
 *
 * A subscription is a commercial document that pays for itself: it names a customer, a product and a
 * price, and over its term produces **periods**, each of which produces exactly one issued invoice.
 * Everything hard about that is idempotency, and this service is built around the one invariant the
 * plan states outright (§4.14): *if the invoice-generation operation partially fails, it must be safe
 * to retry without creating duplicate invoices, periods, numbers, or email sends.*
 *
 * **How the idempotency is actually enforced** — four independent guards, because one is a
 * convention and a convention is not a guarantee:
 *
 *  1. **A period's identity is its window.** `(subscriptionId, periodStart, periodEnd)` is unique
 *     (migration 030), so two runs cannot own the same period.
 *  2. **A window is computed, never supplied.** It comes from `schedule.ts`, so a replay recomputes
 *     the same dates instead of trusting a stored one.
 *  3. **A run claims the period row under `FOR UPDATE` before it creates anything.** The claim is a
 *     transactional read-modify-write, so two concurrent runs serialize rather than both billing.
 *  4. **A unique violation is an expected domain outcome, not a crash.** If another run wins the
 *     race, the loser re-reads the winner's row and reports it as existing. The plan is explicit
 *     here: a unique-constraint race is a domain outcome, never a silent success *or* an error the
 *     operator has to interpret (§6.3).
 *
 * **Invoicing is one transaction.** The invoice is created *and* issued inside a single transaction
 * together with the period's `invoiceId` write, so a failure rolls the whole thing back. There is no
 * window in which a half-issued invoice exists with no period pointing at it — the one state that
 * would let a retry bill twice.
 *
 * **Nothing external happens here.** Generation issues a document; it does not charge a payment
 * method, send an invoice by email, or call a gateway. Those are separate, explicitly approved
 * integrations (§4.14, and the phase acceptance criterion that no automatic charge or live email
 * occurs without one).
 */

interface SubscriptionData {
  readonly id: string;
  readonly status: string;
  readonly accountId: string | null;
  readonly contactId: string | null;
  readonly productId: string | null;
  readonly priceBookId: string | null;
  readonly paymentTermId: string | null;
  readonly taxCodeId: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly currency: string;
  readonly interval: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly renewalDate: string | null;
  readonly leadTimeDays: number;
  readonly autoRenew: boolean;
  readonly name: string | null;
}

export interface PeriodView {
  readonly id: string;
  readonly subscriptionId: string;
  readonly status: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly plannedInvoiceDate: string;
  readonly invoiceDate: string | null;
  readonly invoiceId: string | null;
  readonly attemptCount: number;
  readonly failureCode: string | null;
  readonly retryState: string | null;
  /** False when this run found the period already there — what makes a replay visible. */
  readonly created: boolean;
  /** True when the run's configured lead time has put this period's invoice date in the past. */
  readonly due: boolean;
}

export interface GeneratePeriodsResult {
  readonly subscriptionId: string;
  readonly created: number;
  readonly existing: number;
  /** True when `maxPeriodsPerRun` stopped the walk before the term was covered. */
  readonly truncated: boolean;
  readonly periods: readonly PeriodView[];
}

export interface ProcessDueResult {
  readonly enabled: boolean;
  readonly runDay: string;
  readonly subscriptions: number;
  readonly periodsCreated: number;
  readonly invoiced: number;
  readonly failed: number;
  /** True when `maxInvoicesPerRun` stopped the run with eligible periods still waiting. */
  readonly truncated: boolean;
  readonly results: readonly Record<string, unknown>[];
}

export interface InvoicePeriodResult {
  readonly periodId: string;
  readonly subscriptionId: string | null;
  readonly invoiced: boolean;
  readonly invoiceId: string | null;
  readonly reason: string | null;
  readonly failureCode: string | null;
  readonly attemptCount: number;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function intValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return fallback;
}

/** A stored date attribute as its calendar day, or `null` when it carries none. */
function day(value: unknown): string | null {
  return storedDay(value) ?? null;
}

function periodView(row: SalesRow, runDay: string, created: boolean): PeriodView {
  const data = row.data;
  const plannedInvoiceDate =
    day(data["plannedInvoiceDate"]) ?? day(data["periodStart"]) ?? "";
  return {
    id: row.id,
    subscriptionId: text(data["subscriptionId"]) ?? "",
    status: text(data["status"]) ?? "pending",
    periodStart: day(data["periodStart"]) ?? "",
    periodEnd: day(data["periodEnd"]) ?? "",
    plannedInvoiceDate,
    invoiceDate: day(data["invoiceDate"]),
    invoiceId: text(data["invoiceId"]) ?? text(data["generatedInvoiceId"]),
    attemptCount: intValue(data["attemptCount"], 0),
    failureCode: text(data["failureCode"]),
    retryState: text(data["retryState"]),
    created,
    due: plannedInvoiceDate !== "" && plannedInvoiceDate <= runDay,
  };
}

@Injectable()
export class SubscriptionService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesBalanceService) private readonly balances: SalesBalanceService,
    @Inject(SalesSettingsService) private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(SalesDocumentService) private readonly documents: SalesDocumentService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /**
   * A subscription as the billing code needs it, with every date normalized to its `YYYY-MM-DD` day.
   *
   * The stored `date` attributes come back as ISO instants through the record API, while the schedule
   * computes plain days; reading both through `storedDay` is what lets the two agree.
   */
  private async loadSubscription(id: string): Promise<SubscriptionData> {
    await this.acl.assertAccess("Subscription", "read");
    const row = await this.entities.get("Subscription", id);
    const data = row as unknown as Record<string, unknown>;
    const startDate = storedDay(data["startDate"]) ?? utcDay();
    return {
      id: String(data["id"] ?? id),
      status: text(data["status"]) ?? "pending",
      accountId: text(data["accountId"]),
      contactId: text(data["contactId"]),
      productId: text(data["productId"]),
      priceBookId: text(data["priceBookId"]),
      paymentTermId: text(data["paymentTermId"]),
      taxCodeId: text(data["taxCodeId"]),
      quantity: text(data["quantity"]) ?? "1",
      unitPrice: text(data["unitPrice"]) ?? "",
      currency: text(data["currency"]) ?? "USD",
      interval: normalizeInterval(data["interval"]),
      startDate,
      endDate: day(data["endDate"]),
      renewalDate: day(data["renewalDate"]),
      leadTimeDays: Math.max(0, intValue(data["leadTimeDays"], 0)),
      autoRenew: data["autoRenew"] !== false,
      name: text(data["name"]),
    };
  }

  private async subscriptionOrThrow(id: string): Promise<SubscriptionData> {
    const found = await this.records.byId("Subscription", id);
    if (found === undefined) {
      throw new NotFoundError(`Subscription "${id}" does not exist.`);
    }
    return await this.loadSubscription(id);
  }

  /** Every live period of a subscription, keyed by its window so two runs agree on identity. */
  private async existingPeriods(subscriptionId: string): Promise<Map<string, SalesRow>> {
    const rows = await this.records.find("SubscriptionPeriod", { subscriptionId }, 2_000);
    const byWindow = new Map<string, SalesRow>();
    for (const row of rows) {
      const start = storedDay(row.data["periodStart"]);
      const end = storedDay(row.data["periodEnd"]);
      if (start === undefined || end === undefined) continue;
      byWindow.set(`${start}|${end}`, row);
    }
    return byWindow;
  }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  /**
   * The billing policy this installation runs, or a refusal naming the setting.
   *
   * Subscriptions are opt-in like purchasing and inventory: an installation that never configured
   * recurring billing must not silently start issuing invoices from records a user created by hand.
   */
  private async requireEnabled(): Promise<{
    readonly horizonDays: number;
    readonly maxPeriodsPerRun: number;
    readonly maxInvoicesPerRun: number;
  }> {
    const settings = await this.settings.read();
    if (!settings.settings.features.subscriptions) {
      throw new AuthorizationDeniedError(
        "Subscriptions are disabled. Turn on the `subscriptions` feature in the Sales settings before using billing commands.",
        { feature: "subscriptions" },
      );
    }
    return settings.settings.subscriptions;
  }

  private async billingPolicy(): Promise<{
    readonly horizonDays: number;
    readonly maxPeriodsPerRun: number;
    readonly maxInvoicesPerRun: number;
  }> {
    return await this.requireEnabled();
  }

  /**
   * How far past the run day periods are generated when the term is open-ended.
   *
   * A fixed horizon is what keeps a weekly subscription over a ten-year term from creating
   * thousands of periods in one run: the next daily run extends the window as the term approaches.
   */
  private horizonFor(subscription: SubscriptionData, runDay: string, policy: { readonly horizonDays: number }): string {
    const horizon = addDays(runDay, policy.horizonDays);
    if (subscription.endDate === null) return horizon;
    return subscription.endDate < horizon ? subscription.endDate : horizon;
  }

  // -------------------------------------------------------------------------------------------
  // Period generation
  // -------------------------------------------------------------------------------------------

  /**
   * The windows this subscription should own, whatever is already stored.
   *
   * `maxPeriodsPerRun` bounds how many windows one call may *create*, not how many it may look at —
   * existing windows are skipped rather than counted, so a back-dated subscription still makes
   * progress across successive runs instead of stalling on the same first N windows.
   */
  private windowsFor(
    subscription: SubscriptionData,
    runDay: string,
    policy: { readonly horizonDays: number },
    stored: ReadonlyMap<string, SalesRow>,
    createBudget: number,
  ): { readonly windows: PeriodWindow[]; readonly truncated: boolean } {
    const lastPeriodEnd = this.horizonFor(subscription, runDay, policy);
    const limit = Math.max(stored.size + createBudget, 1);
    const all = periodWindows(
      {
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        interval: subscription.interval,
        leadTimeDays: subscription.leadTimeDays,
      },
      { lastPeriodEnd, limit },
    );
    const missing = all.filter(
      (window) => !stored.has(`${window.periodStart}|${window.periodEnd}`),
    );
    const take = missing.slice(0, createBudget);
    return {
      windows: all.filter((window) => {
        const key = `${window.periodStart}|${window.periodEnd}`;
        return stored.has(key) || take.includes(window);
      }),
      truncated: missing.length > take.length,
    };
  }

  /**
   * Create the periods a subscription is missing, up to the configured horizon.
   *
   * Idempotent: a replay creates nothing and reports what already existed. The whole claim runs in
   * one transaction, so a failure part-way leaves no half-created set of periods.
   */
  async generatePeriods(subscriptionId: string, today?: string): Promise<GeneratePeriodsResult> {
    const policy = await this.requireEnabled();
    await this.acl.assertAccess("SubscriptionPeriod", "create");
    await this.acl.assertAccess("Subscription", "edit");
    const runDay = resolveDay(today);

    return await runAsSalesInternal(() =>
      runInTransaction(this.database.db, async (tx) => {
        const subscription = await this.subscriptionOrThrow(subscriptionId);
        assertScheduleInput({
          startDate: subscription.startDate,
          endDate: subscription.endDate,
          interval: subscription.interval,
          leadTimeDays: subscription.leadTimeDays,
        });

        const stored = await this.existingPeriods(subscriptionId);
        const { windows, truncated } = this.windowsFor(
          subscription,
          runDay,
          policy,
          stored,
          policy.maxPeriodsPerRun,
        );

        const views: PeriodView[] = [];
        let created = 0;
        let existing = 0;
        for (const window of windows) {
          const key = `${window.periodStart}|${window.periodEnd}`;
          const already = stored.get(key);
          if (already !== undefined) {
            existing += 1;
            views.push(periodView(already, runDay, false));
            continue;
          }
          const row = await this.createPeriod(subscription, window);
          if (row !== undefined) {
            created += 1;
            views.push(periodView(row, runDay, true));
          } else {
            // Another run won the race for this window; report its row, not an error.
            const winner = (await this.existingPeriods(subscriptionId)).get(key);
            if (winner === undefined) continue;
            existing += 1;
            views.push(periodView(winner, runDay, false));
          }
        }

        if (created > 0) {
          await this.emit(tx, "sales.subscription.periodsGenerated", {
            entityType: "Subscription",
            subscriptionId,
            created,
            existing,
            runDay,
            actor: this.actor(),
          });
        }

        return { subscriptionId, created, existing, truncated, periods: views };
      }),
    );
  }

  /**
   * Claim one period for billing, or report the winner when the claim was taken.
   *
   * `undefined` means "this window already has a period" — the caller re-reads it. The unique index
   * behind `uq_subscription_period_identity` is what makes the loser of a concurrent run land here
   * instead of raising.
   */
  private async createPeriod(
    subscription: SubscriptionData,
    window: PeriodWindow,
  ): Promise<SalesRow | undefined> {
    try {
      const record = await this.entities.create("SubscriptionPeriod", {
        name: `${subscription.name ?? "Subscription"} ${window.periodStart} → ${window.periodEnd}`,
        subscriptionId: subscription.id,
        status: "pending",
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        plannedInvoiceDate: window.plannedInvoiceDate,
        attemptCount: 0,
        idempotencyKey: periodKey(subscription.id, window),
      });
      return { id: String(record["id"]), version: 1, name: null, data: record };
    } catch (error: unknown) {
      if (error instanceof DuplicateRecordError) return undefined;
      throw error;
    }
  }

  /**
   * What this subscription *would* bill, without writing anything (§4.14 task 8: a safe preview).
   *
   * The preview marks each window `due` against the run day and says whether a period already
   * exists, so an operator can see the effect of a lead-time or interval change before committing it.
   */
  async previewPeriods(
    subscriptionId: string,
    today?: string,
  ): Promise<{
    readonly subscriptionId: string;
    readonly runDay: string;
    readonly horizon: string;
    readonly interval: string;
    readonly leadTimeDays: number;
    readonly periods: readonly PeriodView[];
    readonly dueCount: number;
    readonly truncated: boolean;
  }> {
    const policy = await this.requireEnabled();
    await this.acl.assertAccess("Subscription", "read");
    const runDay = resolveDay(today);
    const subscription = await this.subscriptionOrThrow(subscriptionId);
    assertScheduleInput({
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      interval: subscription.interval,
      leadTimeDays: subscription.leadTimeDays,
    });

    const stored = await this.existingPeriods(subscriptionId);
    const lastPeriodEnd = this.horizonFor(subscription, runDay, policy);
    const limit = Math.max(stored.size + policy.maxPeriodsPerRun, 1);
    const windows = periodWindows(
      {
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        interval: subscription.interval,
        leadTimeDays: subscription.leadTimeDays,
      },
      { lastPeriodEnd, limit },
    );

    const periods: PeriodView[] = [];
    let truncated = false;
    for (const window of windows) {
      const key = `${window.periodStart}|${window.periodEnd}`;
      const row = stored.get(key);
      if (row !== undefined) {
        periods.push(periodView(row, runDay, false));
        continue;
      }
      const afterBudget = periods.length - stored.size >= policy.maxPeriodsPerRun;
      if (afterBudget) {
        truncated = true;
        continue;
      }
      periods.push({
        id: "",
        subscriptionId,
        status: "pending",
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        plannedInvoiceDate: window.plannedInvoiceDate,
        invoiceDate: null,
        invoiceId: null,
        attemptCount: 0,
        failureCode: null,
        retryState: null,
        created: false,
        due: window.plannedInvoiceDate <= runDay,
      });
    }

    return {
      subscriptionId,
      runDay,
      horizon: lastPeriodEnd,
      interval: subscription.interval,
      leadTimeDays: subscription.leadTimeDays,
      periods,
      dueCount: periods.filter((period) => period.due && period.status !== "invoiced").length,
      truncated,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Invoicing
  // -------------------------------------------------------------------------------------------

  /** The one line a subscription period bills: its product, quantity and agreed price. */
  private invoiceLines(subscription: SubscriptionData): readonly RequestedLine[] {
    if (subscription.productId === null && subscription.unitPrice === "") return [];
    const line: Record<string, unknown> = {
      quantity: subscription.quantity,
      taxRatePercent: "0",
    };
    if (subscription.productId !== null) line["productId"] = subscription.productId;
    else line["name"] = subscription.name ?? "Subscription";
    if (subscription.unitPrice !== "") line["unitPrice"] = subscription.unitPrice;
    if (subscription.taxCodeId !== null) line["taxCodeId"] = subscription.taxCodeId;
    return [line as unknown as RequestedLine];
  }

  /**
   * Bill one period, exactly once.
   *
   * The claim is a `FOR UPDATE` read-modify-write inside its own transaction, so a replay cannot
   * double-bill even when two runs overlap: the second run finds the period already claimed or
   * invoiced and reports that instead of creating an invoice. The invoice is then created *and*
   * issued in one further transaction together with the period's `invoiceId` write — a failure there
   * leaves no orphan invoice, which is what makes the retry safe.
   */
  async invoicePeriod(periodId: string, today?: string): Promise<InvoicePeriodResult> {
    await this.requireEnabled();
    // Billing a period issues a real invoice, so the authority to do that is checked here and not
    // only in `processDue`: no caller can reach an invoice without `Invoice: create`.
    await this.acl.assertAccess("SubscriptionPeriod", "edit");
    await this.acl.assertAccess("Invoice", "create");
    const runDay = resolveDay(today);

    const claim = await runAsSalesInternal(() =>
      runInTransaction(this.database.db, async (tx) => {
        const period = await this.balances.lockRow(tx, "SubscriptionPeriod", periodId);
        const data = period.data;
        const status = text(data["status"]) ?? "pending";
        const subscriptionId = text(data["subscriptionId"]);
        const existingInvoiceId = text(data["invoiceId"]) ?? text(data["generatedInvoiceId"]);

        // An invoice this period already produced is the answer, whatever the status says.
        if (existingInvoiceId !== null) {
          return { period, subscriptionId, invoiceId: existingInvoiceId, claimed: false, reason: "alreadyInvoiced" };
        }
        if (status === "cancelled" || status === "skipped") {
          return { period, subscriptionId, invoiceId: null, claimed: false, reason: "notEligible" };
        }

        const subscription =
          subscriptionId === null ? null : await this.loadSubscription(subscriptionId);
        const planned =
          storedDay(data["plannedInvoiceDate"]) ?? storedDay(data["periodStart"]) ?? runDay;
        const reason =
          subscription === null
            ? "notEligible"
            : ineligibilityReason(status, subscription.status, planned, runDay);
        if (reason !== null) {
          return { period, subscriptionId, invoiceId: null, claimed: false, reason };
        }

        const attemptCount = intValue(data["attemptCount"], 0) + 1;
        await this.entities.update("SubscriptionPeriod", periodId, {
          status: "processing",
          attemptCount,
          retryState: "claimed",
          failureCode: null,
        });
        return {
          period,
          subscriptionId,
          invoiceId: null,
          claimed: true,
          reason: null,
          attemptCount,
          planned,
        };
      }),
    );

    const attemptCount =
      claim.attemptCount ??
      intValue(claim.period.data["attemptCount"], 0);
    if (claim.invoiceId !== null) {
      return {
        periodId,
        subscriptionId: claim.subscriptionId,
        invoiced: false,
        invoiceId: claim.invoiceId,
        reason: claim.reason ?? "alreadyInvoiced",
        failureCode: null,
        attemptCount,
      };
    }
    if (!claim.claimed) {
      return {
        periodId,
        subscriptionId: claim.subscriptionId,
        invoiced: false,
        invoiceId: null,
        reason: claim.reason ?? "notEligible",
        failureCode: null,
        attemptCount,
      };
    }

    // The subscription the claim verified, read again for the invoice header and its line.
    const subscription = await this.loadSubscription(claim.subscriptionId ?? "");
    const periodStart = storedDay(claim.period.data["periodStart"]) ?? runDay;
    const periodEnd = storedDay(claim.period.data["periodEnd"]) ?? periodStart;

    try {
      const invoiceId = await runAsSalesInternal(() =>
        runInTransaction(this.database.db, async (tx) => {
          const invoice = await this.documents.create({
            kind: "invoice",
            data: {
              name: `${subscription.name ?? "Subscription"} ${periodStart} → ${periodEnd}`,
              currency: subscription.currency,
              invoiceDate: runDay,
              accountId: subscription.accountId,
              contactId: subscription.contactId,
              paymentTermId: subscription.paymentTermId,
              priceBookId: subscription.priceBookId,
              subscriptionId: subscription.id,
              subscriptionPeriodId: periodId,
              // The service window is the reason the invoice exists; it is part of its own fact.
              servicePeriodStart: periodStart,
              servicePeriodEnd: periodEnd,
            },
            items: this.invoiceLines(subscription),
            audit: { userName: BILLING_ACTOR },
          });
          const invoiceId = String(invoice.id);
          await this.documents.transition("invoice", invoiceId, "issue", {
            userName: BILLING_ACTOR,
            correlationId: `subscription:${subscription.id}:${periodStart}`,
          });
          await this.entities.update("SubscriptionPeriod", periodId, {
            status: "invoiced",
            invoiceDate: runDay,
            invoiceId,
            generatedInvoiceId: invoiceId,
            retryState: "completed",
            failureCode: null,
          });
          await this.emit(tx, "sales.subscription.invoiceGenerated", {
            entityType: "Subscription",
            subscriptionId: subscription.id,
            periodId,
            invoiceId,
            periodStart,
            periodEnd,
            invoiceDate: runDay,
            currency: subscription.currency,
            actor: BILLING_ACTOR,
          });
          return invoiceId;
        }),
      );

      return {
        periodId,
        subscriptionId: subscription.id,
        invoiced: true,
        invoiceId,
        reason: null,
        failureCode: null,
        attemptCount,
      };
    } catch (error: unknown) {
      const failureCode = error instanceof Error ? error.message : String(error);
      // The failed attempt is *recorded*, never swallowed: the period stays visible as failed with
      // its reason, and a retry re-runs exactly this path (§4.14 "failed period processing is
      // visible and can be retried safely").
      await runAsSalesInternal(() =>
        runInTransaction(this.database.db, async (tx) => {
          await this.entities.update("SubscriptionPeriod", periodId, {
            status: "failed",
            failureCode,
            retryState: "failed",
          });
          await this.emit(tx, "sales.subscription.billingFailed", {
            entityType: "Subscription",
            subscriptionId: subscription.id,
            periodId,
            failureCode,
            attemptCount,
            actor: BILLING_ACTOR,
          });
        }),
      ).catch(() => undefined);
      return {
        periodId,
        subscriptionId: subscription.id,
        invoiced: false,
        invoiceId: null,
        reason: "failed",
        failureCode,
        attemptCount,
      };
    }
  }

  /**
   * The recurring run: every billable subscription gets its missing periods, then every due period
   * gets its invoice.
   *
   * One subscription's failure never aborts the run — a single unpriceable period must not stop every
   * other subscription from billing — but each failure is reported in `results`, so the run's outcome
   * is a complete account rather than a partial one.
   */
  async processDue(today?: string): Promise<ProcessDueResult> {
    const settings = await this.settings.read();
    const runDay = resolveDay(today);
    if (!settings.settings.features.subscriptions) {
      return {
        enabled: false,
        runDay,
        subscriptions: 0,
        periodsCreated: 0,
        invoiced: 0,
        failed: 0,
        truncated: false,
        results: [],
      };
    }
    await this.acl.assertAccess("Subscription", "read");
    await this.acl.assertAccess("SubscriptionPeriod", "create");
    await this.acl.assertAccess("Invoice", "create");
    const policy = await this.billingPolicy();

    const rows = await this.records.allLive("Subscription", 2_000);
    const billable = rows.filter((row) =>
      isBillableStatus(text(row.data["status"]) ?? "pending"),
    );

    const results: Record<string, unknown>[] = [];
    let invoiced = 0;
    let failed = 0;
    let periodsCreated = 0;
    let truncated = false;
    let budget = policy.maxInvoicesPerRun;

    for (const row of billable) {
      try {
        const periods = await this.generatePeriods(row.id, runDay);
        periodsCreated += periods.created;
        truncated = truncated || periods.truncated;
      } catch (error: unknown) {
        results.push({
          subscriptionId: row.id,
          stage: "periods",
          ok: false,
          failureCode: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const periods = await this.records.find("SubscriptionPeriod", { subscriptionId: row.id }, 2_000);
      for (const period of periods) {
        const status = text(period.data["status"]) ?? "pending";
        if (status !== "pending") continue;
        if (budget <= 0) {
          truncated = true;
          continue;
        }
        const outcome = await this.invoicePeriod(period.id, runDay);
        budget -= 1;
        results.push({ ...outcome });
        if (outcome.invoiced) invoiced += 1;
        else if (outcome.reason === "failed") failed += 1;
      }

      // The term is settled only once its earned periods have been billed. Ending a term first would
      // take it out of the billable set and quietly cancel the last invoice a customer was owed.
      try {
        await this.settleTerm(row.id, runDay);
      } catch (error: unknown) {
        results.push({
          subscriptionId: row.id,
          stage: "term",
          ok: false,
          failureCode: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      enabled: true,
      runDay,
      subscriptions: billable.length,
      periodsCreated,
      invoiced,
      failed,
      truncated,
      results,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Renewal and termination
  // -------------------------------------------------------------------------------------------

  /**
   * Roll a finished term forward, or end it — the decision `autoRenew` encodes (§4.14).
   *
   * This is the one place a run *changes a term rather than billing it*, so it is deliberately
   * narrow and idempotent:
   *
   *  - it acts only on a term whose `endDate` has passed, which is a fact, not a guess;
   *  - with `autoRenew` it extends the term by exactly one interval and records `renewed`, so the
   *    next run finds a term that is still running and does nothing;
   *  - without `autoRenew` it records `ended`, and an ended term is neither billable nor renewable,
   *    so the decision is final;
   *  - an open-ended term (no `endDate`) has no term to settle and is left alone.
   */
  private async settleTerm(subscriptionId: string, runDay: string): Promise<{ status: string } | null> {
    const subscription = await this.subscriptionOrThrow(subscriptionId);
    const endDate = subscription.endDate;
    if (endDate === null) return null;
    if (runDay < endDate) return null;

    if (!subscription.autoRenew) {
      const current = subscription.status;
      if (current === "ended") return null;
      await runAsSalesInternal(() =>
        runInTransaction(this.database.db, async (tx) => {
          await this.entities.update("Subscription", subscriptionId, { status: "ended" });
          await this.emit(tx, "sales.subscription.ended", {
            entityType: "Subscription",
            subscriptionId,
            from: current,
            to: "ended",
            endDate,
            actor: this.actor(),
          });
        }),
      );
      return { status: "ended" };
    }

    // One interval past the finished term. `periodEndFor` keeps the same boundary rule the schedule
    // uses, so a renewal does not shift a customer's billing day.
    const nextEnd = periodEndFor(addDays(endDate, 1), normalizeInterval(subscription.interval));
    if (nextEnd <= endDate) return null;
    await runAsSalesInternal(() =>
      runInTransaction(this.database.db, async (tx) => {
        await this.entities.update("Subscription", subscriptionId, {
          status: "renewed",
          endDate: nextEnd,
          renewalDate: endDate,
        });
        await this.emit(tx, "sales.subscription.renewed", {
          entityType: "Subscription",
          subscriptionId,
          from: subscription.status,
          to: "renewed",
          previousEndDate: endDate,
          endDate: nextEnd,
          actor: this.actor(),
        });
      }),
    );
    return { status: "renewed" };
  }

  // -------------------------------------------------------------------------------------------
  // Recovery and lifecycle
  // -------------------------------------------------------------------------------------------

  /**
   * Re-run one period's billing after a failure.
   *
   * A retry never edits an issued invoice: it re-claims a period that has no invoice, which is the
   * only state a retry is allowed to act on. A period that already produced an invoice is reported
   * as-is rather than billed again (§4.9 "reversible only through a supported compensating action",
   * applied to the billing side).
   */
  async retryPeriod(periodId: string, today?: string): Promise<InvoicePeriodResult> {
    await this.requireEnabled();
    await this.acl.assertAccess("SubscriptionPeriod", "edit");
    const runDay = resolveDay(today);

    const period = await this.balances.lockRow(this.database.db, "SubscriptionPeriod", periodId);
    const status = text(period.data["status"]) ?? "pending";
    if (text(period.data["invoiceId"]) !== null || status === "invoiced") {
      return {
        periodId,
        subscriptionId: text(period.data["subscriptionId"]),
        invoiced: false,
        invoiceId: text(period.data["invoiceId"]) ?? text(period.data["generatedInvoiceId"]),
        reason: "alreadyInvoiced",
        failureCode: null,
        attemptCount: intValue(period.data["attemptCount"], 0),
      };
    }
    if (status === "processing") {
      // A run claimed it and did not finish. The claim is stale by definition: nothing external is
      // in flight, so releasing it for an explicit retry is safe.
      await runAsSalesInternal(() =>
        runInTransaction(this.database.db, async (tx) => {
          await this.entities.update("SubscriptionPeriod", periodId, {
            status: "pending",
            retryState: "retryRequested",
            failureCode: null,
          });
          await this.emit(tx, "sales.subscription.periodRetried", {
            entityType: "Subscription",
            subscriptionId: text(period.data["subscriptionId"]),
            periodId,
            from: status,
            runDay,
            actor: this.actor(),
          });
        }),
      );
    }
    return await this.invoicePeriod(periodId, runDay);
  }

  /**
   * Pause, resume or cancel a subscription.
   *
   * Cancelling also stops the periods that would still bill: an operator who cancels a subscription
   * must not find invoices for it appearing from a later run.
   */
  async transition(
    action: "pause" | "resume" | "cancel",
    subscriptionId: string,
  ): Promise<{ readonly subscriptionId: string; readonly status: string; readonly cancelledPeriods: number }> {
    await this.requireEnabled();
    await this.acl.assertAccess("Subscription", "edit");

    return await runAsSalesInternal(() =>
      runInTransaction(this.database.db, async (tx) => {
        const row = await this.balances.lockRow(tx, "Subscription", subscriptionId);
        const current = text(row.data["status"]) ?? "pending";
        const refusal = subscriptionTransitionRefusal(action, current);
        if (refusal !== null) {
          throw new ValidationError(refusal, { subscriptionId, action, status: current });
        }
        const next =
          action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
        await this.entities.update("Subscription", subscriptionId, { status: next });

        let cancelledPeriods = 0;
        if (action === "cancel") {
          const periods = await this.existingPeriods(subscriptionId);
          for (const period of periods.values()) {
            const status = text(period.data["status"]) ?? "pending";
            if (status !== "pending" && status !== "failed") continue;
            await this.entities.update("SubscriptionPeriod", period.id, {
              status: "cancelled",
              retryState: "subscriptionCancelled",
            });
            cancelledPeriods += 1;
          }
        }

        await this.emit(tx, `sales.subscription.${action}d`, {
          entityType: "Subscription",
          subscriptionId,
          from: current,
          to: next,
          cancelledPeriods,
          actor: this.actor(),
        });
        return { subscriptionId, status: next, cancelledPeriods };
      }),
    );
  }

  async pauseSubscription(id: string) {
    return await this.transition("pause", id);
  }

  async resumeSubscription(id: string) {
    return await this.transition("resume", id);
  }

  async cancelSubscription(id: string) {
    return await this.transition("cancel", id);
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  private actor(): string {
    return BILLING_ACTOR;
  }

  /**
   * A billing event for the integration consumers named in the plan (§4.14 task 10, and the
   * `CustomerSuccess` / accounting contracts of 19-S.19).
   *
   * Events carry record ids, the window and the status — never an amount of money the consumer could
   * not reconcile, and never anything about a payment method. Consumers must be idempotent: the same
   * event type can be delivered more than once, and the record ids it carries are stable.
   */
  private async emit(
    tx: DbTx,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.insertMany(tx, [
      {
        eventType,
        payload: { ...payload, occurredAt: new Date().toISOString() },
      },
    ]);
  }
}

/** A billing run is the system acting, not a user: the issuer on the invoice says so. */
const BILLING_ACTOR = "sales.billing";