import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { DEFAULT_ONBOARDING_TEMPLATE_ID } from "./customer-success-defaults.js";
import {
  dayValue,
  PLAYBOOK_STEP_TYPES,
  PLAYBOOK_TRIGGER_MODES,
  readyPlaybookSteps,
  text,
  validatePlaybookSteps,
} from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessPlanService } from "./customer-success-plan.service.js";
import { CustomerSuccessRecords, type CustomerSuccessRow } from "./customer-success-records.js";
import { CustomerSuccessRiskService } from "./customer-success-risk.service.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.8 — playbooks and onboarding (PLAN_Phase_19_Customer_Success.md §5.11, §5.5).
 *
 * A template is validated configuration; a run snapshots the steps it started with, so editing the
 * template later cannot mutate in-flight work. Every trigger carries a deterministic idempotency key,
 * so an event retry cannot create a duplicate run or a duplicate task. Step types are an allow-list —
 * no raw SQL, no arbitrary JavaScript — and a completed step is never re-run by a retry.
 */

/** The record a step produced when it completed, if its type produces one. */
export interface ProducedRecord {
  readonly entityType: string;
  readonly id: string;
}

/** Counts one bounded job run reports (§11.1: processed / skipped / errors + duration). */
export interface PlaybookWaitScan {
  readonly processed: number;
  readonly skipped: number;
  readonly resumed: number;
  readonly errors: number;
  readonly durationMs: number;
}

/** Outcome of one bounded stale-run scan: repaired when provably safe, skipped when a person is needed. */
export interface StaleRunRepair {
  readonly processed: number;
  /** Live runs left untouched — they need a human, and a job must never skip their steps. */
  readonly skipped: number;
  readonly repaired: number;
  readonly errors: number;
  readonly durationMs: number;
}

export interface TemplateStepInput {
  readonly key: string;
  readonly name: string;
  readonly stepType: string;
  readonly order: number;
  readonly required?: boolean | undefined;
  readonly dueOffsetDays?: number | null | undefined;
  readonly assigneePolicy?: string | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly instructions?: string | undefined;
}

export interface CreateTemplateInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly playbookType?: string | undefined;
  readonly triggerMode?: string | undefined;
  readonly triggerConfig?: Record<string, unknown> | undefined;
  readonly isActive?: boolean | undefined;
  readonly steps: readonly TemplateStepInput[];
}

export interface StartRunInput {
  readonly profileId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly templateId: string;
  readonly triggerKey?: string | undefined;
  readonly triggerSource?: string | undefined;
  readonly onboarding?: boolean | undefined;
}

interface StepSnapshot {
  key: string;
  name: string;
  stepType: string;
  order: number;
  required: boolean;
  dueOffsetDays: number | null;
  assigneePolicy: string;
  dependsOn: string[];
  instructions: string | null;
}

export const DEFAULT_ONBOARDING_TEMPLATE_KEY = "onboardingDefault";

@Injectable()
export class CustomerSuccessPlaybookService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessPlanService) private readonly plans: CustomerSuccessPlanService,
    @Inject(CustomerSuccessRiskService) private readonly risks: CustomerSuccessRiskService,
    @Inject(CustomerSuccessNotificationService) private readonly notifications: CustomerSuccessNotificationService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async createTemplate(input: CreateTemplateInput): Promise<Record<string, unknown>> {
    if (input.triggerMode !== undefined && !(PLAYBOOK_TRIGGER_MODES as readonly string[]).includes(input.triggerMode)) {
      throw new ValidationError(`"${input.triggerMode}" is not a supported trigger mode.`, { triggerMode: input.triggerMode });
    }
    const issues = validatePlaybookSteps(
      input.steps.map((step) => ({
        key: step.key,
        name: step.name,
        stepType: step.stepType,
        order: step.order,
        ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
      })),
    );
    if (issues.length > 0) throw new ValidationError("Invalid playbook template.", { issues });
    const version = await this.nextTemplateVersion(input.name);
    return runAsCustomerSuccessInternal(() =>
      this.entities.create("CustomerSuccessPlaybookTemplate", {
        name: input.name,
        playbookType: input.playbookType ?? "custom",
        triggerMode: input.triggerMode ?? "manual",
        triggerConfig: input.triggerConfig !== undefined ? JSON.stringify(input.triggerConfig) : null,
        isActive: input.isActive ?? true,
        version,
        steps: JSON.stringify(normalizeSteps(input.steps)),
        ...(input.description !== undefined ? { description: input.description } : {}),
      }),
    );
  }

  /**
   * Start a run (§5.11.2). The steps are snapshotted, step runs are created in the same transaction,
   * and a repeated trigger key returns the existing run instead of creating another.
   */
  async startRun(input: StartRunInput): Promise<{ runId: string; created: boolean; steps: number }> {
    const settings = await this.settings.settings();
    if (!settings.features.playbooks) {
      throw new ValidationError("Playbooks are disabled.", { module: "CustomerSuccess" });
    }
    const profile = await this.resolveProfile(input.profileId, input.accountId);
    const template = await this.records.byId("CustomerSuccessPlaybookTemplate", input.templateId);
    if (template === undefined) throw new NotFoundError(`CustomerSuccessPlaybookTemplate "${input.templateId}" does not exist.`);
    const steps = parseSteps(template.data["steps"]);
    if (settings.playbooks.enforceIdempotency && input.triggerKey !== undefined) {
      const existing = await this.records.find(
        "CustomerSuccessPlaybookRun",
        { triggerKey: input.triggerKey },
        { limit: 5 },
      );
      const found = existing[0];
      if (found !== undefined) return { runId: found.id, created: false, steps: steps.length };
    }
    const now = new Date();
    const profileId = profile.id;
    const accountId = text(profile.data["accountId"]) ?? null;
    const csmUserId = text(profile.data["csmUserId"]) ?? null;
    const stepSnapshot: StepSnapshot[] = steps.map((step) => ({
      key: step.key,
      name: step.name,
      stepType: step.stepType,
      order: step.order,
      required: step.required ?? true,
      dueOffsetDays: step.dueOffsetDays ?? null,
      assigneePolicy: step.assigneePolicy ?? "profileCsm",
      dependsOn: [...(step.dependsOn ?? [])],
      instructions: step.instructions ?? null,
    }));

    return runInTransaction(this.database.db, async () => {
      const run = await runAsCustomerSuccessInternal(() =>
        this.entities.create("CustomerSuccessPlaybookRun", {
          name: `${template.name ?? "Playbook"} run`,
          profileId,
          accountId,
          templateId: input.templateId,
          templateVersion: typeof template.data["version"] === "number" ? template.data["version"] : 1,
          status: "running",
          startedAt: now.toISOString(),
          stepSnapshot: JSON.stringify(stepSnapshot),
          stepCount: stepSnapshot.length,
          completedStepCount: 0,
          triggerKey: input.triggerKey ?? null,
          triggerSource: input.triggerSource ?? "manual",
          onboarding: input.onboarding ?? false,
        }),
      );
      const runId = String(run["id"]);
      for (const step of stepSnapshot) {
        await runAsCustomerSuccessInternal(() =>
          this.entities.create("CustomerSuccessPlaybookStepRun", {
            name: step.name,
            runId,
            profileId,
            accountId,
            stepKey: step.key,
            stepOrder: step.order,
            stepType: step.stepType,
            status: "pending",
            isRequired: step.required,
            dependsOn: JSON.stringify(step.dependsOn),
            dueDate: step.dueOffsetDays === null ? null : addDays(isoDay(now), step.dueOffsetDays),
            assigneeUserId: step.assigneePolicy === "none" ? null : csmUserId,
            instructions: step.instructions,
          }),
        );
      }
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.playbook.started",
        payload: { runId, profileId, accountId, templateId: input.templateId, steps: stepSnapshot.length },
      });
      return { runId, created: true, steps: stepSnapshot.length };
    });
  }

  async run(runId: string): Promise<Record<string, unknown>> {
    const run = await this.mustLoadRun(runId);
    const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { runId }, { orderBy: "stepOrder", limit: 500 });
    return {
      id: run.id,
      profileId: text(run.data["profileId"]) ?? null,
      accountId: text(run.data["accountId"]) ?? null,
      templateId: text(run.data["templateId"]) ?? null,
      status: text(run.data["status"]) ?? "running",
      onboarding: run.data["onboarding"] === true,
      startedAt: text(run.data["startedAt"]) ?? null,
      completedAt: text(run.data["completedAt"]) ?? null,
      stepCount: typeof run.data["stepCount"] === "number" ? run.data["stepCount"] : steps.length,
      completedStepCount: typeof run.data["completedStepCount"] === "number" ? run.data["completedStepCount"] : 0,
      steps: steps.map((step) => this.stepView(step)),
    };
  }

  /** Mark a step complete, running its allow-listed producer at most once (§5.11.3). */
  async completeStep(stepRunId: string, note?: string): Promise<Record<string, unknown>> {
    const step = await this.mustLoadStep(stepRunId);
    const status = text(step.data["status"]) ?? "pending";
    if (status === "completed") return { stepRunId, status: "completed", changed: false };
    if (status === "canceled") throw new ValidationError("A canceled step cannot be completed.", { stepRunId });

    const run = await this.mustLoadRun(text(step.data["runId"]) ?? "");
    const profile = await this.records.byId("CustomerSuccessProfile", text(run.data["profileId"]) ?? "");
    const stepType = text(step.data["stepType"]) ?? "manual";

    let produced: ProducedRecord | null;
    try {
      produced = await this.produceStep(stepType, step, run, profile, note);
    } catch (error: unknown) {
      // The producer failed (§5.11.3 "retry-safe failure state"). Record it on the step rather than
      // leaving it `pending` and unexplained: `attemptCount` and `errorSummary` say what happened,
      // `retryFailedSteps` gets something real to retry, and the owner hears about it (§11.2). The
      // original error is rethrown, so the caller still gets the real reason — nothing is swallowed.
      const reason = error instanceof Error ? error.message : String(error);
      await runInTransaction(this.database.db, async () => {
        await runAsCustomerSuccessInternal(() =>
          this.entities.update("CustomerSuccessPlaybookStepRun", stepRunId, {
            status: "failed",
            attemptCount: (typeof step.data["attemptCount"] === "number" ? step.data["attemptCount"] : 0) + 1,
            errorSummary: reason.slice(0, 2_000),
          }),
        );
        await this.events.dispatch(this.database.db, {
          type: "customerSuccess.playbook.failed",
          payload: {
            runId: run.id,
            stepRunId,
            status: "failed",
            reason,
            stepType,
          },
        });
      });
      await this.notifyStepFailure(run, step, reason);
      throw error;
    }

    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlaybookStepRun", stepRunId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          attemptCount: (typeof step.data["attemptCount"] === "number" ? step.data["attemptCount"] : 0) + 1,
          ...(produced !== null ? { linkedEntityType: produced.entityType, linkedEntityId: produced.id } : {}),
          ...(note !== undefined && note.trim() !== "" ? { completionNote: note.trim() } : {}),
        }),
      );
      await this.recountRun(run.id);
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.playbook.stepCompleted",
        payload: { runId: run.id, stepRunId, stepKey: text(step.data["stepKey"]) ?? null, stepType },
      });
    });
    return { stepRunId, status: "completed", produced };
  }

  async skipStep(stepRunId: string, reason: string, overrideRequired = false): Promise<Record<string, unknown>> {
    const step = await this.mustLoadStep(stepRunId);
    const required = step.data["isRequired"] !== false;
    if (required && !overrideRequired) {
      throw new ValidationError("This is a required step; skipping it needs an explicit override.", { stepRunId });
    }
    if (reason.trim() === "") throw new ValidationError("Skipping a step requires a reason.", { stepRunId });
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlaybookStepRun", stepRunId, {
          status: "skipped",
          completedAt: new Date().toISOString(),
          skipReason: reason,
        }),
      );
      await this.recountRun(text(step.data["runId"]) ?? "");
    });
    return { stepRunId, status: "skipped" };
  }

  /** Pause a waiting step until a date; the run stays running (§5.11.1 `waitUntil`). */
  async waitUntil(stepRunId: string, until: string): Promise<Record<string, unknown>> {
    const step = await this.mustLoadStep(stepRunId);
    if (text(step.data["stepType"]) !== "waitUntil") {
      throw new ValidationError("Only a waitUntil step can be parked on a date.", { stepRunId });
    }
    await runAsCustomerSuccessInternal(() =>
      this.entities.update("CustomerSuccessPlaybookStepRun", stepRunId, {
        status: "inProgress",
        waitUntil: until,
      }),
    );
    return { stepRunId, status: "inProgress", waitUntil: until };
  }

  async cancelRun(runId: string, reason: string): Promise<Record<string, unknown>> {
    const run = await this.mustLoadRun(runId);
    const status = text(run.data["status"]) ?? "running";
    if (status === "completed" || status === "canceled") return { runId, status, changed: false };
    const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { runId }, { limit: 500 });
    await runInTransaction(this.database.db, async () => {
      for (const step of steps) {
        const stepStatus = text(step.data["status"]) ?? "pending";
        if (stepStatus === "completed" || stepStatus === "skipped") continue;
        await runAsCustomerSuccessInternal(() =>
          this.entities.update("CustomerSuccessPlaybookStepRun", step.id, {
            status: "canceled",
            skipReason: reason,
          }),
        );
      }
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlaybookRun", runId, {
          status: "canceled",
          canceledAt: new Date().toISOString(),
          cancelReason: reason,
        }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.playbook.failed",
        payload: { runId, status: "canceled", reason },
      });
    });
    return { runId, status: "canceled" };
  }

  /** Retry only the failed steps; completed steps are never re-run (§5.11.3, §13.11). */
  async retryFailedSteps(runId: string): Promise<{ retried: number }> {
    const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { runId }, { limit: 500 });
    let retried = 0;
    for (const step of steps) {
      if (text(step.data["status"]) !== "failed") continue;
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlaybookStepRun", step.id, {
          status: "pending",
          errorSummary: null,
        }),
      );
      retried += 1;
    }
    if (retried > 0) {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlaybookRun", runId, { status: "running", errorSummary: null }),
      );
    }
    return { retried };
  }

  /** Resume runs whose wait steps are due (§11.1 `processPlaybookWaitSteps`). */
  async processWaitSteps(today: string, limit: number): Promise<PlaybookWaitScan> {
    const started = Date.now();
    const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { status: "inProgress" }, { limit: 5_000 });
    const result = { processed: 0, skipped: 0, resumed: 0, errors: 0 };
    for (const step of steps) {
      if (result.processed >= limit) break;
      result.processed += 1;
      const until = dayValue(step.data["waitUntil"]);
      if (until === undefined || until > today) {
        result.skipped += 1;
        continue;
      }
      try {
        await runAsCustomerSuccessInternal(() =>
          this.entities.update("CustomerSuccessPlaybookStepRun", step.id, { status: "pending", waitUntil: null }),
        );
        result.resumed += 1;
      } catch {
        // One un-writable step must not stop the rest of the batch (§11.1).
        result.errors += 1;
      }
    }
    return { ...result, durationMs: Date.now() - started };
  }

  /** Find runs that have made no progress for a long time and report them (§11.1 `repairStalePlaybookRuns`). */
  async staleRuns(olderThanDays: number, limit: number): Promise<{ runId: string; profileId: string | null }[]> {
    const runs = await this.records.find("CustomerSuccessPlaybookRun", { status: "running" }, { limit: 5_000 });
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const out: { runId: string; profileId: string | null }[] = [];
    for (const run of runs) {
      const startedAt = text(run.data["startedAt"]) ?? "";
      const completed = typeof run.data["completedStepCount"] === "number" ? run.data["completedStepCount"] : 0;
      if (startedAt !== "" && startedAt < cutoff && completed === 0) {
        out.push({ runId: run.id, profileId: text(run.data["profileId"]) ?? null });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Repair runs that made no progress (§11.1 `repairStalePlaybookRuns`).
   *
   * Only two outcomes are safe for a scheduled job:
   *   * every step is terminal but the run is still `running` — closing it loses no work, because
   *     there is nothing left to execute, so it is completed through the same `recountRun` path a
   *     human completion takes (same event, same onboarding roll-up);
   *   * anything else — the run still has live steps, so it needs a person: it is reported and the
   *     profile's CSM is notified. A job never cancels or skips a step on someone's behalf.
   */
  async repairStaleRuns(olderThanDays: number, limit: number): Promise<StaleRunRepair> {
    const started = Date.now();
    const stale = await this.staleRuns(olderThanDays, limit);
    const result = { processed: 0, skipped: 0, repaired: 0, errors: 0 };
    for (const entry of stale) {
      result.processed += 1;
      try {
        const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { runId: entry.runId }, { limit: 500 });
        const live = steps.filter((step) => {
          const status = text(step.data["status"]) ?? "pending";
          return status !== "completed" && status !== "skipped" && status !== "canceled";
        });
        if (live.length === 0) {
          await this.recountRun(entry.runId);
          result.repaired += 1;
          continue;
        }
        result.skipped += 1;
        const profileId = entry.profileId;
        const profile = profileId === null ? undefined : await this.records.byId("CustomerSuccessProfile", profileId);
        const recipient = profile === undefined ? undefined : text(profile.data["csmUserId"]);
        if (recipient !== undefined) {
          await this.notifications.notify({
            userId: recipient,
            type: "CustomerSuccessPlaybookRun",
            title: "Playbook run is stuck",
            body: `A run has made no progress for ${String(olderThanDays)} days and still has ${String(live.length)} live step(s).`,
            dedupKey: `playbookStalled:${entry.runId}`,
            link: profileId === null ? null : `/CustomerSuccessProfile/view/${profileId}`,
            severity: "warning",
          });
        }
      } catch {
        // A broken run is counted and the scan continues (§11.1).
        result.errors += 1;
      }
    }
    return { ...result, durationMs: Date.now() - started };
  }

  /** The next actionable step of a run, respecting dependencies (§5.11.3). */
  async nextSteps(runId: string): Promise<readonly string[]> {
    const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { runId }, { orderBy: "stepOrder", limit: 500 });
    return readyPlaybookSteps(
      steps.map((step) => ({
        key: text(step.data["stepKey"]) ?? step.id,
        status: text(step.data["status"]) ?? "pending",
        dependsOn: parseDependsOn(step.data["dependsOn"]),
      })),
    );
  }

  // ---------------------------------------------------------------------------
  // Onboarding (§5.5)
  // ---------------------------------------------------------------------------

  /** Start onboarding: a playbook run plus the profile's onboarding roll-up (§5.5, §8.2). */
  async startOnboarding(profileId: string, templateId?: string): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const existingRunId = text(profile.data["activePlaybookRunId"]);
    if (existingRunId !== undefined) {
      const existing = await this.records.byId("CustomerSuccessPlaybookRun", existingRunId);
      const status = existing === undefined ? undefined : text(existing.data["status"]);
      if (existing !== undefined && status !== "completed" && status !== "canceled" && status !== "failed") {
        return { runId: existingRunId, created: false, profileId };
      }
    }
    const template = templateId ?? (await this.defaultOnboardingTemplateId());
    if (template === undefined) {
      // With no template, onboarding is tracked manually rather than refused (§5.5).
      await runInTransaction(this.database.db, async () => {
        await runAsCustomerSuccessInternal(() =>
          this.entities.update("CustomerSuccessProfile", profileId, {
            onboardingStatus: "inProgress",
            onboardingStartedAt: new Date().toISOString().slice(0, 10),
          }),
        );
        await this.events.dispatch(this.database.db, {
          type: "customerSuccess.onboarding.started",
          payload: { profileId, runId: null },
        });
      });
      return { profileId, runId: null, created: true, manual: true };
    }
    const triggerKey = `onboarding:${profileId}:${template}`;
    const started = await this.startRun({
      profileId,
      templateId: template,
      triggerKey,
      triggerSource: "onboardingStarted",
      onboarding: true,
    });
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessProfile", profileId, {
          onboardingStatus: "inProgress",
          onboardingStartedAt: new Date().toISOString().slice(0, 10),
          activePlaybookRunId: started.runId,
        }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.onboarding.started",
        payload: { profileId, runId: started.runId },
      });
    });
    return { profileId, runId: started.runId, created: started.created, steps: started.steps };
  }

  /** Complete onboarding once mandatory steps are done, or with a permissioned override (§5.5). */
  async completeOnboarding(profileId: string, override = false): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const runId = text(profile.data["activePlaybookRunId"]);
    if (runId !== undefined) {
      const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { runId }, { limit: 500 });
      const incompleteRequired = steps.filter(
        (step) =>
          step.data["isRequired"] !== false &&
          (text(step.data["status"]) ?? "pending") !== "completed" &&
          (text(step.data["status"]) ?? "pending") !== "skipped",
      );
      if (incompleteRequired.length > 0 && !override) {
        throw new ValidationError("Onboarding has mandatory steps that are not complete.", {
          profileId,
          remaining: incompleteRequired.length,
        });
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessProfile", profileId, {
          onboardingStatus: "completed",
          onboardingCompletedAt: today,
        }),
      );
      if (runId !== undefined) {
        await runAsCustomerSuccessInternal(() =>
          this.entities.update("CustomerSuccessPlaybookRun", runId, {
            status: "completed",
            completedAt: new Date().toISOString(),
          }),
        );
      }
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.onboarding.completed",
        payload: { profileId, runId: runId ?? null, override },
      });
    });
    return { profileId, status: "completed" };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async produceStep(
    stepType: string,
    step: CustomerSuccessRow,
    run: CustomerSuccessRow,
    profile: CustomerSuccessRow | undefined,
    note: string | undefined,
  ): Promise<ProducedRecord | null> {
    if (!(PLAYBOOK_STEP_TYPES as readonly string[]).includes(stepType)) return null;
    const profileId = profile?.id ?? text(run.data["profileId"]) ?? "";
    const accountId = text(run.data["accountId"]);
    const csmUserId = profile === undefined ? undefined : text(profile.data["csmUserId"]);
    const name = text(step.data["name"]) ?? "Playbook step";
    if (stepType === "createTask" || stepType === "createActivity") {
      const created = await this.entities.create("Task", {
        name,
        status: "Planned",
        description: note ?? text(step.data["instructions"]) ?? undefined,
        ...(csmUserId !== undefined ? { assignedUserId: csmUserId } : {}),
      });
      const taskId = String(created["id"]);
      if (accountId !== undefined) {
        try {
          await this.entities.link("Task", taskId, "accounts", accountId);
        } catch {
          // Linking is supplementary: a missing relation must not fail the step it belongs to.
        }
      }
      return { entityType: "Task", id: taskId };
    }
    if (stepType === "createRisk") {
      const created = await this.risks.create({
        profileId,
        title: name,
        severity: "medium",
        riskType: "unknown",
        mitigationPlan: "Created by a playbook step; review and document the mitigation.",
      });
      return { entityType: "CustomerSuccessRisk", id: String(created["id"]) };
    }
    if (stepType === "createSuccessPlan") {
      const created = await this.plans.create({ profileId, name });
      return { entityType: "CustomerSuccessPlan", id: String(created["id"]) };
    }
    if (stepType === "notifyOwner" && csmUserId !== undefined) {
      await this.notifications.notify({
        userId: csmUserId,
        type: "CustomerSuccessPlaybookStep",
        title: name,
        body: note ?? text(step.data["instructions"]) ?? "A playbook step needs your attention.",
        dedupKey: `playbookStep:${step.id}`,
        link: `/CustomerSuccessProfile/view/${profileId}`,
        severity: "info",
      });
      return null;
    }
    return null;
  }

  private async recountRun(runId: string): Promise<void> {
    if (runId === "") return;
    const steps = await this.records.find("CustomerSuccessPlaybookStepRun", { runId }, { limit: 500 });
    const done = steps.filter((step) => {
      const status = text(step.data["status"]) ?? "pending";
      return status === "completed" || status === "skipped";
    }).length;
    const allDone = steps.length > 0 && done === steps.length;
    if (allDone) {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlaybookRun", runId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          completedStepCount: done,
        }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.playbook.completed",
        payload: { runId },
      });
      const run = await this.records.byId("CustomerSuccessPlaybookRun", runId);
      const profileId = text(run?.data["profileId"] ?? "");
      if (run?.data["onboarding"] === true && profileId !== undefined) {
        await runAsCustomerSuccessInternal(() =>
          this.entities.update("CustomerSuccessProfile", profileId, {
            onboardingStatus: "completed",
            onboardingCompletedAt: new Date().toISOString().slice(0, 10),
          }),
        );
      }
    } else {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessPlaybookRun", runId, { completedStepCount: done }),
      );
    }
  }

  /** Tell the person responsible for a step that it failed, once per step (§11.2). */
  private async notifyStepFailure(
    run: CustomerSuccessRow,
    step: CustomerSuccessRow,
    reason: string,
  ): Promise<void> {
    const profileId = text(run.data["profileId"]) ?? null;
    const profile = profileId === null ? undefined : await this.records.byId("CustomerSuccessProfile", profileId);
    const recipient =
      text(step.data["assigneeUserId"]) ?? (profile === undefined ? undefined : text(profile.data["csmUserId"]));
    if (recipient === undefined) return;
    await this.notifications.notify({
      userId: recipient,
      type: "CustomerSuccessPlaybookStep",
      title: "Playbook step failed",
      body: `${step.name ?? "A step"} failed and can be retried: ${reason.slice(0, 300)}`,
      dedupKey: `playbookFailed:${step.id}`,
      link: profileId === null ? null : `/CustomerSuccessProfile/view/${profileId}`,
      severity: "warning",
    });
  }

  private stepView(step: CustomerSuccessRow): Record<string, unknown> {
    return {
      id: step.id,
      stepKey: text(step.data["stepKey"]) ?? null,
      name: step.name,
      stepType: text(step.data["stepType"]) ?? "manual",
      stepOrder: typeof step.data["stepOrder"] === "number" ? step.data["stepOrder"] : 0,
      status: text(step.data["status"]) ?? "pending",
      isRequired: step.data["isRequired"] !== false,
      dueDate: text(step.data["dueDate"]) ?? null,
      assigneeUserId: text(step.data["assigneeUserId"]) ?? null,
      linkedEntityType: text(step.data["linkedEntityType"]) ?? null,
      linkedEntityId: text(step.data["linkedEntityId"]) ?? null,
      completedAt: text(step.data["completedAt"]) ?? null,
      skipReason: text(step.data["skipReason"]) ?? null,
      waitUntil: text(step.data["waitUntil"]) ?? null,
      // What a caller needs to see about a failed step: whether it can be retried and why it failed.
      attemptCount: typeof step.data["attemptCount"] === "number" ? step.data["attemptCount"] : 0,
      errorSummary: text(step.data["errorSummary"]) ?? null,
    };
  }

  private async defaultOnboardingTemplateId(): Promise<string | undefined> {
    // The installation's own default wins when it exists and is active: that makes the no-template
    // path predictable (§5.5, §6.6) instead of "whichever active template happens to sort first".
    // An operator takes it over by editing that record, deactivating it, or naming a template.
    const seeded = await this.records.byId("CustomerSuccessPlaybookTemplate", DEFAULT_ONBOARDING_TEMPLATE_ID);
    if (seeded !== undefined && seeded.data["isActive"] !== false) return seeded.id;
    const templates = await this.records.find("CustomerSuccessPlaybookTemplate", { isActive: "true" }, { limit: 100 });
    const preferred = templates.find((template) => text(template.data["playbookType"]) === "onboarding");
    return (preferred ?? templates[0])?.id;
  }

  private async nextTemplateVersion(name: string): Promise<number> {
    const existing = await this.records.find("CustomerSuccessPlaybookTemplate", { name }, { limit: 50 });
    return existing.length + 1;
  }

  private async mustLoadRun(runId: string) {
    const run = await this.records.byId("CustomerSuccessPlaybookRun", runId);
    if (run === undefined) throw new NotFoundError(`CustomerSuccessPlaybookRun "${runId}" does not exist.`);
    return run;
  }

  private async mustLoadStep(stepRunId: string) {
    const step = await this.records.byId("CustomerSuccessPlaybookStepRun", stepRunId);
    if (step === undefined) throw new NotFoundError(`CustomerSuccessPlaybookStepRun "${stepRunId}" does not exist.`);
    return step;
  }

  private async resolveProfile(profileId: string | undefined, accountId: string | undefined) {
    if (profileId !== undefined) {
      const profile = await this.records.byId("CustomerSuccessProfile", profileId);
      if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
      return profile;
    }
    if (accountId === undefined) throw new ValidationError("A playbook run needs a profile or an account.", {});
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

function normalizeSteps(steps: readonly TemplateStepInput[]): StepSnapshot[] {
  return [...steps]
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((step) => ({
      key: step.key,
      name: step.name,
      stepType: step.stepType,
      order: step.order,
      required: step.required ?? true,
      dueOffsetDays: step.dueOffsetDays ?? null,
      assigneePolicy: step.assigneePolicy ?? "profileCsm",
      dependsOn: [...(step.dependsOn ?? [])],
      instructions: step.instructions ?? null,
    }));
}

function parseSteps(raw: unknown): StepSnapshot[] {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      key: String(item["key"] ?? ""),
      name: String(item["name"] ?? ""),
      stepType: String(item["stepType"] ?? "manual"),
      order: typeof item["order"] === "number" ? item["order"] : 0,
      required: item["required"] !== false,
      dueOffsetDays: typeof item["dueOffsetDays"] === "number" ? item["dueOffsetDays"] : null,
      assigneePolicy: String(item["assigneePolicy"] ?? "profileCsm"),
      dependsOn: Array.isArray(item["dependsOn"]) ? (item["dependsOn"] as unknown[]).map(String) : [],
      instructions: typeof item["instructions"] === "string" ? item["instructions"] : null,
    }));
}

function parseDependsOn(raw: unknown): string[] {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  return Array.isArray(value) ? value.map(String) : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return day;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}
