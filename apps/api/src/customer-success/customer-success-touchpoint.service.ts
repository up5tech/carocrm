import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import {
  dayValue,
  isMeaningfulTouch,
  lastMeaningfulTouchAt,
  text,
  type TouchCandidate,
  type TouchEntity,
} from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessRecords, type CustomerSuccessRow } from "./customer-success-records.js";

/**
 * Phase 19-CS.9 — touchpoints and success reviews (PLAN_Phase_19_Customer_Success.md §5.10).
 *
 * The module adds CSM context on top of the existing Task/Call/Meeting/Email entities — it never
 * builds a second scheduler. A structured review is a small `CustomerSuccessReview` record that
 * **links** to an existing Activity (`activityType` + `activityId`); scheduling a review creates a
 * Meeting through the same entity API the Calendar uses.
 */

export const REVIEW_ACTIVITY_TYPES = ["Call", "Meeting", "Task", "Email"] as const;
export type ReviewActivityType = (typeof REVIEW_ACTIVITY_TYPES)[number];

export const SENTIMENTS = ["positive", "neutral", "negative", "unknown"] as const;

/** Counts one bounded review-reminder scan reports (§11.1). */
export interface ReviewReminderScan {
  readonly processed: number;
  readonly skipped: number;
  readonly notified: number;
  readonly errors: number;
  readonly due: readonly { readonly profileId: string; readonly reviewDate: string }[];
  readonly durationMs: number;
}

export interface ScheduleReviewInput {
  readonly profileId: string;
  readonly name: string;
  readonly activityType?: ReviewActivityType | undefined;
  readonly dateStart: string;
  readonly duration?: number | undefined;
  readonly ownerUserId?: string | undefined;
  readonly objectives?: string | undefined;
  readonly outcomes?: string | undefined;
  readonly openRisks?: string | undefined;
  readonly goalProgressNote?: string | undefined;
  readonly sentiment?: string | undefined;
  readonly actionItems?: string | undefined;
  readonly nextReviewDate?: string | undefined;
  readonly contactIds?: readonly string[] | undefined;
}

export interface RecentActivityView {
  readonly id: string;
  readonly entityType: string;
  readonly name: string | null;
  readonly status: string | null;
  readonly dateStart: string | null;
  readonly meaningful: boolean;
}

@Injectable()
export class CustomerSuccessTouchpointService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessNotificationService) private readonly notifications: CustomerSuccessNotificationService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** Recent customer-linked activities plus whether each qualifies as a meaningful touch (§5.10). */
  async recent(profileId: string, limit = 25): Promise<RecentActivityView[]> {
    const profile = await this.mustLoad(profileId);
    const accountId = text(profile.data["accountId"]);
    if (accountId === undefined) return [];
    const contacts = await this.records.find("Contact", { accountId }, { limit: 500 });
    const activities = await this.records.linkedActivitiesForAccount(
      accountId,
      contacts.map((contact) => contact.id),
    );
    return activities
      .map((activity) => this.viewActivity(activity))
      .sort((a, b) => String(b.dateStart ?? "").localeCompare(String(a.dateStart ?? "")))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  /** The last qualifying touch (§5.10), computed from the same facts the health engine uses. */
  async lastMeaningfulTouch(profileId: string): Promise<string | null> {
    const profile = await this.mustLoad(profileId);
    const accountId = text(profile.data["accountId"]);
    if (accountId === undefined) return null;
    const contacts = await this.records.find("Contact", { accountId }, { limit: 500 });
    const activities = await this.records.linkedActivitiesForAccount(
      accountId,
      contacts.map((contact) => contact.id),
    );
    return lastMeaningfulTouchAt(activities.map((activity) => this.touchCandidate(activity)).filter(notNull));
  }

  /**
   * Schedule a success review (§5.10). A Meeting is created through the standard entity API (or an
   * existing Activity is linked), and a `CustomerSuccessReview` documents the structured context.
   */
  async scheduleReview(input: ScheduleReviewInput): Promise<Record<string, unknown>> {
    const profile = await this.mustLoad(input.profileId);
    if (input.sentiment !== undefined && !(SENTIMENTS as readonly string[]).includes(input.sentiment)) {
      throw new ValidationError(`"${input.sentiment}" is not a valid sentiment value.`, { sentiment: input.sentiment });
    }
    const accountId = text(profile.data["accountId"]) ?? null;
    const activityType = input.activityType ?? "Meeting";
    const ownerUserId = input.ownerUserId ?? text(profile.data["csmUserId"]) ?? undefined;

    const activity = await this.entities.create(activityType, {
      name: input.name,
      status: activityType === "Task" ? "Planned" : "Planned",
      dateStart: `${input.dateStart}T09:00:00.000Z`,
      dateEnd: `${input.dateStart}T${endTime(input.duration ?? 60)}`,
      ...(ownerUserId !== undefined ? { assignedUserId: ownerUserId } : {}),
      ...(input.objectives !== undefined ? { description: input.objectives } : {}),
    });
    const activityId = String(activity["id"]);
    if (accountId !== null) {
      try {
        await this.entities.link(activityType, activityId, "accounts", accountId);
      } catch {
        // The activity exists even when the relation is not writable by the caller.
      }
    }

    const review = await runInTransaction(this.database.db, async () => {
      const record = await runAsCustomerSuccessInternal(() =>
        this.entities.create("CustomerSuccessReview", {
          name: input.name,
          profileId: input.profileId,
          accountId,
          activityType,
          activityId,
          reviewDate: input.dateStart,
          sentiment: input.sentiment ?? "unknown",
          ...(input.objectives !== undefined ? { objectives: input.objectives } : {}),
          ...(input.outcomes !== undefined ? { outcomes: input.outcomes } : {}),
          ...(input.openRisks !== undefined ? { openRisks: input.openRisks } : {}),
          ...(input.goalProgressNote !== undefined ? { goalProgressNote: input.goalProgressNote } : {}),
          ...(input.actionItems !== undefined ? { actionItems: input.actionItems } : {}),
          ...(input.nextReviewDate !== undefined ? { nextReviewDate: input.nextReviewDate } : {}),
          ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
          ...(input.contactIds !== undefined ? { contactIds: [...input.contactIds] } : {}),
        }),
      );
      const patch: Record<string, unknown> = {};
      const nextReview = input.nextReviewDate ?? advanceReview(input.dateStart);
      patch["nextSuccessReviewAt"] = nextReview;
      patch["lastHealthReviewAt"] = input.dateStart;
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessProfile", input.profileId, patch),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.review.scheduled",
        payload: { profileId: input.profileId, reviewId: String(record["id"]), activityId, activityType, reviewDate: input.dateStart },
      });
      return record;
    });
    return { reviewId: String(review["id"]), activityId, activityType, profileId: input.profileId };
  }

  /** Reviews of a profile, newest first. */
  async reviews(profileId: string, limit = 20): Promise<Record<string, unknown>[]> {
    const rows = await this.records.find("CustomerSuccessReview", { profileId }, { limit: 500 });
    return rows
      .sort((a, b) => String(b.data["reviewDate"] ?? "").localeCompare(String(a.data["reviewDate"] ?? "")))
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((row) => ({
        id: row.id,
        name: row.name,
        activityType: text(row.data["activityType"]) ?? null,
        activityId: text(row.data["activityId"]) ?? null,
        reviewDate: text(row.data["reviewDate"]) ?? null,
        sentiment: text(row.data["sentiment"]) ?? "unknown",
        outcomes: text(row.data["outcomes"]) ?? null,
        nextReviewDate: text(row.data["nextReviewDate"]) ?? null,
      }));
  }

  /**
   * Profiles whose next review is due or overdue (§11.1 `evaluateReviewReminders`), with the counts
   * the job row records. The reminder is written through the module's in-app writer with a stable
   * dedup key (`review:<profile>:<date>`), so a profile whose review is still due tomorrow does not
   * produce a second notification today (§11.2).
   */
  async evaluateReviewReminders(today: string, limit: number): Promise<ReviewReminderScan> {
    const started = Date.now();
    const rows = await this.records.find("CustomerSuccessProfile", {}, { limit: 5_000 });
    const result = { processed: 0, skipped: 0, notified: 0, errors: 0 };
    const due: { profileId: string; reviewDate: string }[] = [];
    for (const row of rows) {
      if (result.processed >= limit) break;
      result.processed += 1;
      try {
        const next = dayValue(row.data["nextSuccessReviewAt"]);
        if (next === undefined || next > today) {
          result.skipped += 1;
          continue;
        }
        due.push({ profileId: row.id, reviewDate: next });
        const csmUserId = text(row.data["csmUserId"]);
        if (csmUserId === undefined) {
          result.skipped += 1;
          continue;
        }
        const notified = await this.notifications.notify({
          userId: csmUserId,
          type: "CustomerSuccessReview",
          title: "Success review due",
          body: `${row.name ?? "Account"} has a success review due on ${next}.`,
          dedupKey: `review:${row.id}:${next}`,
          link: `/CustomerSuccessProfile/view/${row.id}`,
          severity: "info",
        });
        if (notified.created) result.notified += 1;
        else result.skipped += 1;
      } catch {
        // One profile must not stop the reminder scan (§11.1).
        result.errors += 1;
      }
    }
    return { ...result, due, durationMs: Date.now() - started };
  }

  private viewActivity(activity: CustomerSuccessRow): RecentActivityView {
    const candidate = this.touchCandidate(activity);
    return {
      id: activity.id,
      entityType: activity.entityType,
      name: activity.name,
      status: text(activity.data["status"]) ?? null,
      dateStart: text(activity.data["dateStart"]) ?? text(activity.data["createdAt"]) ?? null,
      meaningful: candidate === null ? false : isMeaningfulTouch(candidate),
    };
  }

  private touchCandidate(activity: CustomerSuccessRow): TouchCandidate | null {
    const type = activity.entityType;
    if (type !== "Task" && type !== "Call" && type !== "Meeting" && type !== "Email") return null;
    return {
      entity: type as TouchEntity,
      status: text(activity.data["status"]) ?? null,
      linkedToCustomer: true,
      completedAt: text(activity.data["completedAt"]) ?? null,
      createdAt: text(activity.data["dateStart"]) ?? text(activity.data["createdAt"]) ?? null,
    };
  }

  private async mustLoad(profileId: string) {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    return profile;
  }
}

function endTime(durationMinutes: number): string {
  const bounded = Math.max(15, Math.min(8 * 60, Math.round(durationMinutes)));
  const hours = Math.floor(bounded / 60) + 9;
  const minutes = bounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00.000Z`;
}

function advanceReview(date: string, days = 90): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
