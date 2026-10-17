import { NotFoundError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import {
  computeGoalProgress,
  type GoalDirection,
  goalIsOverdue,
  text,
} from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessPlanService } from "./customer-success-plan.service.js";
import { CustomerSuccessRecords, type CustomerSuccessRow } from "./customer-success-records.js";

/**
 * Phase 19-CS.6 — measurable goals inside a plan (PLAN_Phase_19_Customer_Success.md §5.7).
 *
 * Progress is computed by the pure `computeGoalProgress` for every direction (increase, decrease,
 * maintain, boolean, manual), bounded to 0–100 and safe against division by zero. Changing a goal
 * recomputes the plan roll-up; health recalculation is enqueued by the caller, not recursively here.
 */

export interface CreateGoalInput {
  readonly planId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly category?: string | undefined;
  readonly direction: string;
  readonly baselineValue?: number | undefined;
  readonly baselineDate?: string | undefined;
  readonly targetValue?: number | undefined;
  readonly targetDate?: string | undefined;
  readonly currentValue?: number | undefined;
  readonly currentDate?: string | undefined;
  readonly unit?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly tolerance?: number | undefined;
  readonly manualProgress?: number | undefined;
}

export interface UpdateGoalProgressInput {
  readonly currentValue?: number | undefined;
  readonly manualProgress?: number | undefined;
  readonly note?: string | undefined;
}

/** Outcome of one bounded overdue scan (§11.1 — processed/skipped/error counts per job run). */
export interface GoalOverdueScan {
  readonly processed: number;
  readonly updated: number;
  readonly cleared: number;
  readonly skipped: number;
  readonly errors: number;
  readonly notified: number;
  readonly durationMs: number;
}

@Injectable()
export class CustomerSuccessGoalService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessPlanService) private readonly plans: CustomerSuccessPlanService,
    @Inject(CustomerSuccessNotificationService) private readonly notifications: CustomerSuccessNotificationService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async create(input: CreateGoalInput): Promise<Record<string, unknown>> {
    const plan = await this.records.byId("CustomerSuccessPlan", input.planId);
    if (plan === undefined) throw new NotFoundError(`CustomerSuccessPlan "${input.planId}" does not exist.`);
    const progress = computeGoalProgress({
      direction: input.direction,
      baseline: input.baselineValue ?? null,
      target: input.targetValue ?? null,
      current: input.currentValue ?? null,
      tolerance: input.tolerance ?? null,
      manualProgress: input.manualProgress ?? null,
    });
    const now = new Date().toISOString();
    const created = await runAsCustomerSuccessInternal(() =>
      this.entities.create("CustomerSuccessGoal", {
        name: input.name,
        planId: input.planId,
        profileId: text(plan.data["profileId"]) ?? null,
        accountId: text(plan.data["accountId"]) ?? null,
        direction: input.direction,
        status: progress.status,
        progress: progress.progress,
        progressAt: now,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.baselineValue !== undefined ? { baselineValue: input.baselineValue } : {}),
        ...(input.baselineDate !== undefined ? { baselineDate: input.baselineDate } : {}),
        ...(input.targetValue !== undefined ? { targetValue: input.targetValue } : {}),
        ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
        ...(input.currentValue !== undefined ? { currentValue: input.currentValue } : {}),
        ...(input.currentDate !== undefined ? { currentDate: input.currentDate } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
        progressExplanation: progress.explanation,
      }),
    );
    await this.plans.recomputeProgress(input.planId);
    return created;
  }

  /** Controlled measurement update (§5.7, §8.2 `updateGoalProgress`). */
  async updateProgress(goalId: string, input: UpdateGoalProgressInput): Promise<Record<string, unknown>> {
    const goal = await this.records.byId("CustomerSuccessGoal", goalId);
    if (goal === undefined) throw new NotFoundError(`CustomerSuccessGoal "${goalId}" does not exist.`);
    const direction = (text(goal.data["direction"]) ?? "manual") as GoalDirection;
    const current =
      input.currentValue !== undefined
        ? input.currentValue
        : numOrUndefined(goal.data["currentValue"]);
    const progress = computeGoalProgress({
      direction,
      baseline: numOrUndefined(goal.data["baselineValue"]),
      target: numOrUndefined(goal.data["targetValue"]),
      current: current ?? null,
      tolerance: numOrUndefined(goal.data["tolerance"]),
      manualProgress: input.manualProgress ?? null,
    });
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      progress: progress.progress,
      status: progress.status,
      progressAt: now,
      progressExplanation: progress.explanation,
      ...(input.currentValue !== undefined ? { currentValue: input.currentValue } : {}),
      ...(input.currentValue !== undefined ? { currentDate: now.slice(0, 10) } : {}),
      ...(input.note !== undefined && input.note.trim() !== ""
        ? { checkpointNotes: appendNote(text(goal.data["checkpointNotes"]), now, input.note) }
        : {}),
    };
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() => this.entities.update("CustomerSuccessGoal", goalId, patch));
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.goal.progressChanged",
        payload: {
          goalId,
          planId: text(goal.data["planId"]) ?? null,
          progress: progress.progress,
          status: progress.status,
        },
      });
    });
    const planId = text(goal.data["planId"]);
    if (planId !== undefined) await this.plans.recomputeProgress(planId);
    return { goalId, progress: progress.progress, status: progress.status };
  }

  /** Mark goals past their due date overdue (§11.1 `updateGoalOverdueState`). */
  async overdue(goalId: string, today: string): Promise<{ goalId: string; overdue: boolean }> {
    const goal = await this.records.byId("CustomerSuccessGoal", goalId);
    if (goal === undefined) throw new NotFoundError(`CustomerSuccessGoal "${goalId}" does not exist.`);
    const isOverdue = goalIsOverdue(
      { status: text(goal.data["status"]) ?? "notStarted", targetDate: text(goal.data["targetDate"]) ?? null },
      today,
    );
    if (isOverdue) {
      await runInTransaction(this.database.db, async () => {
        await runAsCustomerSuccessInternal(() =>
          this.entities.update("CustomerSuccessGoal", goalId, { overdue: true }),
        );
        await this.events.dispatch(this.database.db, {
          type: "customerSuccess.goal.overdue",
          payload: { goalId, planId: text(goal.data["planId"]) ?? null },
        });
      });
    } else if (goal.data["overdue"] === true) {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessGoal", goalId, { overdue: false }),
      );
    }
    return { goalId, overdue: isOverdue };
  }

  /**
   * One bounded overdue scan (§11.1 `updateGoalOverdueState`).
   *
   * Ordered by id and capped at `limit`, so a run is resumable and two schedulers converge on the
   * same result. A row is written only when the computed flag differs from the stored one — the job
   * runs daily and must not churn `version`/`modified_at` for goals whose state did not change.
   * A goal that just became overdue notifies its owner once (dedup key + cadence in the writer).
   */
  async markOverdueState(today: string, limit: number): Promise<GoalOverdueScan> {
    const started = Date.now();
    const goals = await this.records.find("CustomerSuccessGoal", {}, { limit: 5_000 });
    const profileCache = new Map<string, string | null>();
    const result = { processed: 0, updated: 0, cleared: 0, skipped: 0, errors: 0, notified: 0 };
    for (const goal of goals) {
      if (result.processed >= limit) break;
      result.processed += 1;
      const stored = goal.data["overdue"] === true;
      const isOverdue = goalIsOverdue(
        { status: text(goal.data["status"]) ?? "notStarted", targetDate: text(goal.data["targetDate"]) ?? null },
        today,
      );
      if (isOverdue === stored) {
        result.skipped += 1;
        continue;
      }
      try {
        await this.overdue(goal.id, today);
        if (isOverdue) result.updated += 1;
        else result.cleared += 1;
        if (isOverdue) {
          const recipient = await this.overdueRecipient(goal, profileCache);
          if (recipient !== null) {
            const notified = await this.notifications.notify({
              userId: recipient,
              type: "CustomerSuccessGoal",
              title: "Goal overdue",
              body: `${goal.name ?? "A goal"} passed its target date on ${text(goal.data["targetDate"]) ?? today}.`,
              dedupKey: `goalOverdue:${goal.id}`,
              link: profileLink(text(goal.data["profileId"]) ?? null),
              severity: "warning",
            });
            if (notified.created) result.notified += 1;
          }
        }
      } catch {
        // One broken goal must not stop the batch; it is counted and the scan continues (§11.1).
        result.errors += 1;
      }
    }
    return { ...result, durationMs: Date.now() - started };
  }
  /** The person to tell about a goal: its owner when there is one, otherwise the profile's CSM. */
  private async overdueRecipient(
    goal: CustomerSuccessRow,
    profileCache: Map<string, string | null>,
  ): Promise<string | null> {
    const owner = text(goal.data["ownerUserId"]);
    if (owner !== undefined) return owner;
    const profileId = text(goal.data["profileId"]);
    if (profileId === undefined) return null;
    const cached = profileCache.get(profileId);
    if (cached !== undefined) return cached;
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    const csm = profile === undefined ? null : text(profile.data["csmUserId"]) ?? null;
    profileCache.set(profileId, csm);
    return csm;
  }

  /** Every goal id of a plan — used by the overdue job. */
  async goalIds(planId: string): Promise<string[]> {
    const goals = await this.records.find("CustomerSuccessGoal", { planId }, { limit: 1_000 });
    return goals.map((goal) => goal.id);
  }

  async mustLoad(goalId: string) {
    const goal = await this.records.byId("CustomerSuccessGoal", goalId);
    if (goal === undefined) throw new NotFoundError(`CustomerSuccessGoal "${goalId}" does not exist.`);
    return goal;
  }
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function appendNote(existing: string | undefined, at: string, note: string): string {
  const line = `[${at}] ${note.trim()}`;
  const combined = existing === undefined ? line : `${existing}\n${line}`;
  return combined.length > 20_000 ? combined.slice(combined.length - 20_000) : combined;
}

/** Deep link to the owning profile; `null` when a goal has no profile to open. */
function profileLink(profileId: string | null): string | null {
  return profileId === null ? null : `/CustomerSuccessProfile/view/${profileId}`;
}
