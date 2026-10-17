import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import {
  dayValue,
  RENEWAL_STATUSES,
  renewalWindow,
  text,
} from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessRecords } from "./customer-success-records.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.10 — renewal readiness (PLAN_Phase_19_Customer_Success.md §5.9).
 *
 * Renewal readiness is visibility and workflow support, never a billing system: it reads the manual
 * profile fields and, when the Sales/Subscriptions module is present, an authorised summary of the
 * account's subscriptions. A source failure never erases a valid manual value, and `renewed` requires
 * a traceable source reference or an explicit manual confirmation.
 */

/** Counts one bounded renewal-window scan reports (§11.1). */
export interface RenewalWindowScan {
  readonly processed: number;
  readonly skipped: number;
  readonly entered: number;
  readonly errors: number;
  readonly durationMs: number;
}

export interface RenewalSummary {
  readonly profileId: string;
  readonly accountId: string | null;
  readonly renewalDate: string | null;
  readonly daysToRenewal: number | null;
  readonly windowDays: number | null;
  readonly overdue: boolean;
  readonly status: string;
  readonly source: string | null;
  readonly syncedAt: string | null;
  readonly commercialSource: {
    readonly available: boolean;
    readonly subscriptionId: string | null;
    readonly subscriptionStatus: string | null;
    readonly renewalDate: string | null;
  };
  readonly healthTrend: string | null;
  readonly openRisks: number;
  readonly activePlanProgress: number | null;
  readonly nextAction: string | null;
  readonly csmUserId: string | null;
}

@Injectable()
export class CustomerSuccessRenewalService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(CustomerSuccessNotificationService) private readonly notifications: CustomerSuccessNotificationService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** Renewal readiness view for one profile (§5.9). */
  async summary(profileId: string): Promise<RenewalSummary> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const settings = await this.settings.settings();
    const today = new Date().toISOString().slice(0, 10);
    const accountId = text(profile.data["accountId"]) ?? null;
    const renewalDate = text(profile.data["renewalDate"]) ?? null;
    const window = renewalDate === null ? null : renewalWindow(renewalDate, today, settings.renewal.windows);
    const commercial = accountId === null ? null : await this.commercialSource(accountId, profileId);
    const risks = await this.records.find("CustomerSuccessRisk", { profileId }, { limit: 500 });
    const openRisks = risks.filter((risk) => {
      const status = text(risk.data["status"]) ?? "open";
      return status !== "resolved" && status !== "closed" && status !== "accepted";
    });
    return {
      profileId,
      accountId,
      renewalDate,
      daysToRenewal: window?.daysToRenewal ?? null,
      windowDays: window?.windowDays ?? null,
      overdue: window?.overdue ?? false,
      status: text(profile.data["renewalStatus"]) ?? "unknown",
      source: text(profile.data["renewalSource"]) ?? null,
      syncedAt: text(profile.data["renewalSyncedAt"]) ?? null,
      commercialSource: {
        available: commercial !== null,
        subscriptionId: commercial?.id ?? null,
        subscriptionStatus: commercial?.status ?? null,
        renewalDate: commercial?.renewalDate ?? null,
      },
      healthTrend: text(profile.data["scoreTrend"]) ?? null,
      openRisks: openRisks.length,
      activePlanProgress: typeof profile.data["activePlanProgress"] === "number" ? profile.data["activePlanProgress"] : null,
      nextAction: openRisks
        .map((risk) => text(risk.data["nextAction"]))
        .find((value): value is string => value !== undefined) ?? null,
      csmUserId: text(profile.data["csmUserId"]) ?? null,
    };
  }

  /** Set the renewal date/status manually when no commercial source is installed (§5.9). */
  async setManual(
    profileId: string,
    input: { readonly renewalDate?: string | null | undefined; readonly status?: string | undefined },
  ): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    if (input.status !== undefined && !(RENEWAL_STATUSES as readonly string[]).includes(input.status)) {
      throw new ValidationError(`"${input.status}" is not a valid renewal status.`, { status: input.status });
    }
    const patch: Record<string, unknown> = { renewalSource: "manual" };
    if (input.renewalDate !== undefined) patch["renewalDate"] = input.renewalDate;
    if (input.status !== undefined) patch["renewalStatus"] = input.status;
    await runAsCustomerSuccessInternal(() => this.entities.update("CustomerSuccessProfile", profileId, patch));
    return { profileId, ...patch };
  }

  /**
   * Adopt a renewal date from the commercial source, honouring the configured precedence (§5.9). A
   * manual date is kept unless precedence says otherwise, and a source failure never clears a value.
   */
  async syncFromSource(profileId: string, force = false): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const accountId = text(profile.data["accountId"]);
    if (accountId === undefined) return { profileId, synced: false, reason: "noAccount" };
    const settings = await this.settings.settings();
    let commercial;
    try {
      commercial = await this.commercialSource(accountId, profileId);
    } catch (error: unknown) {
      // A source failure is visible but never erases a valid value (§5.9).
      return {
        profileId,
        synced: false,
        reason: "sourceError",
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      };
    }
    if (commercial === null || commercial.renewalDate === null) {
      return { profileId, synced: false, reason: "noSource" };
    }
    const currentSource = text(profile.data["renewalSource"]);
    const currentDate = text(profile.data["renewalDate"]);
    const manualFirst = settings.renewal.sourcePrecedence === "manualFirst";
    if (!force && manualFirst && currentSource === "manual" && currentDate !== undefined) {
      return { profileId, synced: false, reason: "manualPreferred", manualDate: currentDate };
    }
    await runAsCustomerSuccessInternal(() =>
      this.entities.update("CustomerSuccessProfile", profileId, {
        renewalDate: commercial.renewalDate,
        renewalSource: "subscription",
        renewalSyncedAt: new Date().toISOString(),
      }),
    );
    return { profileId, synced: true, renewalDate: commercial.renewalDate };
  }

  /** Detect profiles newly entering a configured renewal window (§11.1 `evaluateRenewalWindows`). */
  async evaluateWindows(today: string, limit: number): Promise<RenewalWindowScan> {
    const started = Date.now();
    const settings = await this.settings.settings();
    const rows = await this.records.find("CustomerSuccessProfile", {}, { limit: 5_000 });
    const result = { processed: 0, skipped: 0, entered: 0, errors: 0 };
    for (const row of rows) {
      if (result.processed >= limit) break;
      result.processed += 1;
      try {
        const renewalDate = dayValue(row.data["renewalDate"]);
        if (renewalDate === undefined) {
          result.skipped += 1;
          continue;
        }
        const window = renewalWindow(renewalDate, today, settings.renewal.windows);
        if (window === null || window.windowDays === null || window.overdue) {
          result.skipped += 1;
          continue;
        }
        const lastWindows = parseWindows(row.data["notifiedRenewalWindows"]);
        if (lastWindows.includes(window.windowDays)) {
          result.skipped += 1;
          continue;
        }
        await runInTransaction(this.database.db, async () => {
          await runAsCustomerSuccessInternal(() =>
            this.entities.update("CustomerSuccessProfile", row.id, {
              notifiedRenewalWindows: JSON.stringify([...lastWindows, window.windowDays]),
            }),
          );
          await this.events.dispatch(this.database.db, {
            type: "customerSuccess.renewal.windowEntered",
            payload: { profileId: row.id, accountId: text(row.data["accountId"]) ?? null, windowDays: window.windowDays, daysToRenewal: window.daysToRenewal },
          });
        });
        const csmUserId = text(row.data["csmUserId"]);
        if (csmUserId !== undefined) {
          await this.notifications.notify({
            userId: csmUserId,
            type: "CustomerSuccessRenewal",
            title: `Renewal window: ${String(window.windowDays)} days`,
            body: accountLabel(row.name, window.daysToRenewal),
            dedupKey: `renewal:${row.id}:${String(window.windowDays)}`,
            link: `/CustomerSuccessProfile/view/${row.id}`,
            severity: "warning",
          });
        }
        result.entered += 1;
      } catch {
        // A profile that cannot be updated is counted; the scan still finishes (§11.1).
        result.errors += 1;
      }
    }
    return { ...result, durationMs: Date.now() - started };
  }

  // -------------------------------------------------------------------------

  private async commercialSource(
    accountId: string,
    _profileId: string,
  ): Promise<{ id: string; status: string | null; renewalDate: string | null } | null> {
    if (!this.metadata.registry.hasEntity("Subscription")) return null;
    const subscriptions = await this.records.find("Subscription", { accountId }, { limit: 100 });
    const live = subscriptions.filter((subscription) => {
      const status = text(subscription.data["status"]) ?? "";
      return status !== "ended" && status !== "cancelled";
    });
    if (live.length === 0) return null;
    const sorted = live
      .map((subscription) => ({
        id: subscription.id,
        status: text(subscription.data["status"]) ?? null,
        renewalDate: dayValue(subscription.data["renewalDate"]) ?? dayValue(subscription.data["endDate"]) ?? null,
      }))
      .filter((entry) => entry.renewalDate !== null)
      .sort((a, b) => String(a.renewalDate).localeCompare(String(b.renewalDate)));
    return sorted[0] ?? { id: live[0]?.id ?? "", status: text(live[0]?.data["status"]) ?? null, renewalDate: null };
  }
}

function parseWindows(raw: unknown): number[] {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function accountLabel(name: string | null, days: number): string {
  return `${name ?? "Account"} renews in ${String(days)} day(s).`;
}
