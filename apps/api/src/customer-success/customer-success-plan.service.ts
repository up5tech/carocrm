import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { text } from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessRecords } from "./customer-success-records.js";

/**
 * Phase 19-CS.6 — success plans (PLAN_Phase_19_Customer_Success.md §5.6).
 *
 * A plan keeps its own lifecycle, enforces at most one primary active plan per profile by default,
 * and rolls its goals up into a progress figure. Completed and canceled plans are history: they are
 * preserved, never hard-deleted by routine cleanup.
 */

export const PLAN_STATUSES = ["draft", "active", "onHold", "completed", "canceled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

const PLAN_TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = {
  draft: ["active", "canceled"],
  active: ["onHold", "completed", "canceled"],
  onHold: ["active", "canceled"],
  completed: [],
  canceled: [],
};

export interface CreatePlanInput {
  readonly accountId?: string | undefined;
  readonly profileId?: string | undefined;
  readonly name: string;
  readonly planType?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly nextReviewDate?: string | undefined;
  readonly outcomes?: string | undefined;
  readonly baselineSummary?: string | undefined;
  readonly executiveSponsorContactId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly contactIds?: readonly string[] | undefined;
}

@Injectable()
export class CustomerSuccessPlanService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async create(input: CreatePlanInput): Promise<Record<string, unknown>> {
    const profile = await this.resolveProfile(input.profileId, input.accountId);
    const data: Record<string, unknown> = {
      name: input.name,
      profileId: profile.id,
      accountId: text(profile.data["accountId"]) ?? null,
      status: "draft",
      isPrimary: false,
      progress: 0,
      ...(input.planType !== undefined ? { planType: input.planType } : {}),
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
      ...(input.nextReviewDate !== undefined ? { nextReviewDate: input.nextReviewDate } : {}),
      ...(input.outcomes !== undefined ? { outcomes: input.outcomes } : {}),
      ...(input.baselineSummary !== undefined ? { baselineSummary: input.baselineSummary } : {}),
      ...(input.executiveSponsorContactId !== undefined
        ? { executiveSponsorContactId: input.executiveSponsorContactId }
        : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.contactIds !== undefined ? { contactIds: [...input.contactIds] } : {}),
    };
    const created = await runAsCustomerSuccessInternal(() => this.entities.create("CustomerSuccessPlan", data));
    return created;
  }

  /** Activate a plan. At most one primary active plan per profile unless `allowSecondary` (§5.6). */
  async activate(planId: string, allowSecondary = false): Promise<Record<string, unknown>> {
    const plan = await this.mustLoad(planId);
    const status = text(plan.data["status"]) ?? "draft";
    if (status === "active") return { planId, status, changed: false };
    this.assertTransition(status, "active");
    const profileId = text(plan.data["profileId"]);
    let primary = true;
    if (profileId !== undefined) {
      const siblings = await this.records.find("CustomerSuccessPlan", { profileId, status: "active" }, { limit: 100 });
      const existingPrimary = siblings.find((row) => row.id !== planId && row.data["isPrimary"] === true);
      if (existingPrimary !== undefined) {
        if (!allowSecondary) {
          throw new ValidationError("An active primary success plan already exists for this profile.", {
            planId,
            existingPlanId: existingPrimary.id,
            code: "duplicatePrimaryPlan",
          });
        }
        primary = false;
      }
    }
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlan", planId, { status: "active", isPrimary: primary }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.plan.activated",
        payload: { planId, profileId: profileId ?? null, primary },
      });
    });
    return { planId, status: "active", primary };
  }

  /** Complete a plan with a close-out summary (§5.6). Does not auto-achieve its goals (§13.9). */
  async complete(planId: string, closeOutSummary?: string): Promise<Record<string, unknown>> {
    const plan = await this.mustLoad(planId);
    this.assertTransition(text(plan.data["status"]) ?? "draft", "completed");
    const now = new Date().toISOString();
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlan", planId, {
          status: "completed",
          completedDate: now.slice(0, 10),
          closeOutSummary: closeOutSummary ?? plan.data["closeOutSummary"] ?? null,
          isPrimary: false,
        }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.plan.activated",
        payload: { planId, status: "completed" },
      });
    });
    return { planId, status: "completed" };
  }

  async transition(planId: string, to: string): Promise<Record<string, unknown>> {
    if (to === "active") return this.activate(planId, true);
    if (to === "completed") return this.complete(planId);
    const plan = await this.mustLoad(planId);
    const from = text(plan.data["status"]) ?? "draft";
    this.assertTransition(from, to);
    await runAsCustomerSuccessInternal(() =>
      this.entities.update("CustomerSuccessPlan", planId, { status: to, isPrimary: false }),
    );
    return { planId, from, to };
  }

  /** Copy a completed/canceled plan as a fresh draft: new ids, no completion metadata (§5.6). */
  async duplicate(planId: string): Promise<Record<string, unknown>> {
    const plan = await this.mustLoad(planId);
    const created = await this.create({
      profileId: text(plan.data["profileId"]),
      name: `${text(plan.data["name"]) ?? "Plan"} (copy)`,
      planType: text(plan.data["planType"]),
      ownerUserId: text(plan.data["ownerUserId"]),
      outcomes: text(plan.data["outcomes"]),
      baselineSummary: text(plan.data["baselineSummary"]),
    });
    return { planId: String(created["id"]), copiedFrom: planId };
  }

  /** Recompute a plan's roll-up progress from its goals and persist it (§5.6, §5.7). */
  async recomputeProgress(planId: string): Promise<{ planId: string; progress: number | null }> {
    const goals = await this.records.find("CustomerSuccessGoal", { planId }, { limit: 500 });
    const measurable = goals.filter((goal) => {
      const status = text(goal.data["status"]) ?? "";
      return status !== "canceled";
    });
    if (measurable.length === 0) {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlan", planId, { progress: null }),
      );
      return { planId, progress: null };
    }
    const total = measurable.reduce((sum, goal) => {
      const progress = goal.data["progress"];
      return sum + (typeof progress === "number" && Number.isFinite(progress) ? progress : 0);
    }, 0);
    const progress = Math.round(total / measurable.length);
    await runAsCustomerSuccessInternal(() =>
      this.entities.update("CustomerSuccessPlan", planId, { progress }),
    );
    return { planId, progress };
  }

  /** Account/profile-level summary of the active plan and its goal outcomes (§5.6). */
  async summary(profileId: string): Promise<Record<string, unknown>> {
    const plans = await this.records.find("CustomerSuccessPlan", { profileId }, { limit: 200 });
    const active = plans.find((plan) => text(plan.data["status"]) === "active");
    if (active === undefined) return { profileId, activePlan: null, historyCount: plans.length };
    const goals = await this.records.find("CustomerSuccessGoal", { planId: active.id }, { limit: 500 });
    return {
      profileId,
      activePlan: {
        id: active.id,
        name: active.name,
        status: "active",
        progress: typeof active.data["progress"] === "number" ? active.data["progress"] : null,
        endDate: text(active.data["endDate"]) ?? null,
        nextReviewDate: text(active.data["nextReviewDate"]) ?? null,
      },
      goals: goals.map((goal) => ({
        id: goal.id,
        name: goal.name,
        status: text(goal.data["status"]) ?? "notStarted",
        progress: typeof goal.data["progress"] === "number" ? goal.data["progress"] : null,
      })),
      historyCount: plans.length,
    };
  }

  private assertTransition(from: string, to: string): void {
    const allowed = PLAN_TRANSITIONS[from as PlanStatus];
    if (allowed === undefined) {
      throw new ValidationError(`Unknown plan status "${from}".`, { from });
    }
    if (!allowed.includes(to as PlanStatus)) {
      throw new ValidationError(`A plan cannot move from "${from}" to "${to}".`, { from, to });
    }
  }

  private async mustLoad(planId: string) {
    const plan = await this.records.byId("CustomerSuccessPlan", planId);
    if (plan === undefined) throw new NotFoundError(`CustomerSuccessPlan "${planId}" does not exist.`);
    return plan;
  }

  private async resolveProfile(profileId: string | undefined, accountId: string | undefined) {
    if (profileId !== undefined) {
      const profile = await this.records.byId("CustomerSuccessProfile", profileId);
      if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
      return profile;
    }
    if (accountId === undefined) {
      throw new ValidationError("A success plan needs a profile or an account.", {});
    }
    const ids = await this.records.idsMatching("CustomerSuccessProfile", "accountId", accountId);
    const id = ids[0];
    if (id === undefined) {
      throw new ValidationError(`Account "${accountId}" has no Customer Success profile yet.`, { accountId });
    }
    const profile = await this.records.byId("CustomerSuccessProfile", id);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${id}" does not exist.`);
    return profile;
  }
}
