import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { text } from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessRecords, type CustomerSuccessRow } from "./customer-success-records.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.2 / 19-CS.3 — the portfolio-facing profile (PLAN_Phase_19_Customer_Success.md §5.1).
 *
 * One `CustomerSuccessProfile` per Account, enforced by both service validation and a partial unique
 * index (migration 032). Creating a profile never creates an Account; it references one. The latest
 * health/plan/risk summary on the profile is a read-optimised projection — snapshots remain the
 * source for explaining change.
 */

export interface CreateProfileInput {
  readonly accountId: string;
  readonly csmUserId?: string | undefined;
  readonly csmTeamId?: string | undefined;
  readonly segment?: string | undefined;
  readonly lifecycleStage?: string | undefined;
  readonly renewalDate?: string | undefined;
  readonly customerSince?: string | undefined;
}

export interface AssignProfileInput {
  readonly csmUserId?: string | null | undefined;
  readonly csmTeamId?: string | null | undefined;
}

@Injectable()
export class CustomerSuccessProfileService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(CustomerSuccessNotificationService) private readonly notifications: CustomerSuccessNotificationService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** The profile of an Account, or undefined. */
  async byAccount(accountId: string): Promise<CustomerSuccessRow | undefined> {
    const ids = await this.records.idsMatching("CustomerSuccessProfile", "accountId", accountId);
    if (ids.length === 0) return undefined;
    return this.records.byId("CustomerSuccessProfile", ids[0] as string);
  }

  /**
   * Create the profile of an Account (§5.1). Idempotent when a live profile already exists: a
   * workflow, a job or a migration that calls this twice does not create a duplicate.
   */
  async ensureForAccount(input: CreateProfileInput): Promise<{ id: string; created: boolean }> {
    const existing = await this.byAccount(input.accountId);
    if (existing !== undefined) return { id: existing.id, created: false };

    const account = await this.records.byId("Account", input.accountId);
    if (account === undefined) {
      throw new ValidationError(`Account "${input.accountId}" does not exist.`, { accountId: input.accountId });
    }
    const settings = await this.settings.settings();
    const data: Record<string, unknown> = {
      accountId: input.accountId,
      name: account.name ?? `CS profile for ${input.accountId}`,
      lifecycleStage: input.lifecycleStage ?? "onboarding",
      onboardingStatus: "notStarted",
      renewalStatus: "unknown",
      healthStatus: "unknown",
      calculatedHealthStatus: "unknown",
      scoreTrend: "unknown",
      ...(input.csmUserId !== undefined ? { csmUserId: input.csmUserId } : {}),
      ...(input.csmTeamId !== undefined ? { csmTeamId: input.csmTeamId } : {}),
      ...(input.segment !== undefined ? { segment: input.segment } : {}),
      ...(input.renewalDate !== undefined ? { renewalDate: input.renewalDate } : {}),
      ...(input.customerSince !== undefined ? { customerSince: input.customerSince } : {}),
    };
    if (data["csmUserId"] === undefined && settings.assignment.defaultPolicy === "accountOwner") {
      const owner = text(account.data["assignedUserId"]);
      if (owner !== undefined) data["csmUserId"] = owner;
    }
    const created = await runInTransaction(this.database.db, async () => {
      const record = await runAsCustomerSuccessInternal(() =>
        this.entities.create("CustomerSuccessProfile", data),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.profile.created",
        payload: { profileId: String(record["id"]), accountId: input.accountId },
      });
      return record;
    });
    return { id: String(created["id"]), created: true };
  }

  /** Assign or reassign a CSM and/or owning team (§5.2). Audited; emits `profile.assigned`. */
  async assign(profileId: string, input: AssignProfileInput): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const patch: Record<string, unknown> = {};
    if (input.csmUserId !== undefined) patch["csmUserId"] = input.csmUserId;
    if (input.csmTeamId !== undefined) patch["csmTeamId"] = input.csmTeamId;
    if (Object.keys(patch).length === 0) {
      throw new ValidationError("An assignment request must name a CSM or a team.", { profileId });
    }
    const previousCsm = text(profile.data["csmUserId"]) ?? null;
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() => this.entities.update("CustomerSuccessProfile", profileId, patch));
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.profile.assigned",
        payload: {
          profileId,
          csmUserId: (patch["csmUserId"] as string | null | undefined) ?? null,
          csmTeamId: (patch["csmTeamId"] as string | null | undefined) ?? null,
        },
      });
    });
    // §11.2 — a reassignment (or a profile left unassigned) is a change of ownership that both sides
    // must see. The dedup key carries the moment it happened, so re-sending the same assignment does
    // not notify twice while a later one does.
    const assignedAt = new Date().toISOString();
    const newCsm = "csmUserId" in patch ? (patch["csmUserId"] as string | null) : undefined;
    if (typeof newCsm === "string") {
      await this.notifications.notify({
        userId: newCsm,
        type: "CustomerSuccessProfile",
        title: "You own a customer profile",
        body: `${profile.name ?? "A customer profile"} is now assigned to you.`,
        dedupKey: `assigned:${profileId}:${assignedAt}`,
        link: `/CustomerSuccessProfile/view/${profileId}`,
        severity: "info",
      });
    } else if (newCsm === null && previousCsm !== null) {
      await this.notifications.notify({
        userId: previousCsm,
        type: "CustomerSuccessProfile",
        title: "Profile no longer assigned to you",
        body: `${profile.name ?? "A customer profile"} was reassigned and no longer has you as CSM.`,
        dedupKey: `unassigned:${profileId}:${assignedAt}`,
        link: `/CustomerSuccessProfile/view/${profileId}`,
        severity: "info",
      });
    }
    return { profileId, ...patch };
  }

  /**
   * A readable summary of a profile (§10.2): Account link, health and override state, active plan
   * progress, open risk count, onboarding state, renewal horizon and the next planned review.
   */
  async summary(profileId: string): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const accountId = text(profile.data["accountId"]);
    const account = accountId === undefined ? undefined : await this.records.byId("Account", accountId);
    const plans = await this.records.find("CustomerSuccessPlan", { profileId }, { limit: 100 });
    const activePlan = plans.find((plan) => text(plan.data["status"]) === "active");
    const goals =
      activePlan === undefined
        ? []
        : await this.records.find("CustomerSuccessGoal", { planId: activePlan.id }, { limit: 500 });
    const risks = await this.records.find("CustomerSuccessRisk", { profileId }, { limit: 500 });
    const openRisks = risks.filter((risk) => {
      const status = text(risk.data["status"]) ?? "open";
      return status !== "resolved" && status !== "closed" && status !== "accepted";
    });
    return {
      profileId,
      accountId: accountId ?? null,
      accountName: account?.name ?? null,
      csmUserId: text(profile.data["csmUserId"]) ?? null,
      csmTeamId: text(profile.data["csmTeamId"]) ?? null,
      lifecycleStage: text(profile.data["lifecycleStage"]) ?? "onboarding",
      segment: text(profile.data["segment"]) ?? null,
      health: {
        status: text(profile.data["healthStatus"]) ?? "unknown",
        calculatedStatus: text(profile.data["calculatedHealthStatus"]) ?? "unknown",
        score: numberOrNull(profile.data["healthScore"]),
        at: text(profile.data["healthScoreAt"]) ?? null,
        trend: text(profile.data["scoreTrend"]) ?? "unknown",
        overridden: (text(profile.data["healthOverride"]) ?? null) !== null,
      },
      onboarding: {
        status: text(profile.data["onboardingStatus"]) ?? "notStarted",
        targetDate: text(profile.data["onboardingTargetDate"]) ?? null,
        completedAt: text(profile.data["onboardingCompletedAt"]) ?? null,
      },
      renewal: {
        date: text(profile.data["renewalDate"]) ?? null,
        status: text(profile.data["renewalStatus"]) ?? "unknown",
        source: text(profile.data["renewalSource"]) ?? null,
      },
      plan:
        activePlan === undefined
          ? null
          : {
              id: activePlan.id,
              name: activePlan.name,
              progress: numberOrNull(activePlan.data["progress"]),
              goals: goals.length,
              overdueGoals: goals.filter((goal) => {
                const target = text(goal.data["targetDate"]);
                const status = text(goal.data["status"]) ?? "";
                return target !== undefined && target < today() && status !== "achieved" && status !== "canceled";
              }).length,
            },
      risks: {
        open: openRisks.length,
        highOrCritical: openRisks.filter((risk) => {
          const severity = text(risk.data["severity"]);
          return severity === "high" || severity === "critical";
        }).length,
      },
      lastMeaningfulTouchAt: text(profile.data["lastMeaningfulTouchAt"]) ?? null,
      nextSuccessReviewAt: text(profile.data["nextSuccessReviewAt"]) ?? null,
    };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
