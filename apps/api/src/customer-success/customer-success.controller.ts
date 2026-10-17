import { timingSafeEqual } from "node:crypto";

import {
  AuthenticationFailedError,
  AuthorizationDeniedError,
  InvalidQueryError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { ZodTypeAny } from "zod";

import { AclApiService } from "../acl/acl-api.service.js";
import { Public } from "../auth/auth.guard.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { type AppConfig, CONFIG_TOKEN } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { runAsSystem } from "./customer-success-authority.js";
import { CustomerSuccessDashletService } from "./customer-success-dashlet.service.js";
import { CustomerSuccessGoalService } from "./customer-success-goal.service.js";
import { CustomerSuccessHealthService } from "./customer-success-health.service.js";
import { CUSTOMER_SUCCESS_JOB_NAMES } from "./customer-success-jobs.js";
import { CustomerSuccessLifecycleService } from "./customer-success-lifecycle.service.js";
import { CustomerSuccessModuleHealthService } from "./customer-success-module-health.service.js";
import { CustomerSuccessPlanService } from "./customer-success-plan.service.js";
import { CustomerSuccessPlaybookService } from "./customer-success-playbook.service.js";
import { CustomerSuccessPortfolioService } from "./customer-success-portfolio.service.js";
import { CustomerSuccessProfileService } from "./customer-success-profile.service.js";
import { CustomerSuccessRenewalService } from "./customer-success-renewal.service.js";
import { CustomerSuccessRiskService } from "./customer-success-risk.service.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";
import { CustomerSuccessTouchpointService } from "./customer-success-touchpoint.service.js";
import {
  BulkRecalculateSchema,
  ClearOverrideSchema,
  ExpireOverridesSchema,
  GoalCreateSchema,
  GoalProgressSchema,
  HistorySchema,
  LifecycleBulkSchema,
  LifecyclePreviewSchema,
  LifecycleTransitionSchema,
  OnboardingCompleteSchema,
  OnboardingStartSchema,
  OverrideSchema,
  PlanCreateSchema,
  PlanDuplicateSchema,
  PlanTransitionSchema,
  PlaybookCancelSchema,
  PlaybookRetrySchema,
  PlaybookStartSchema,
  PlaybookStepCompleteSchema,
  PlaybookStepSkipSchema,
  PlaybookStepWaitSchema,
  PlaybookTemplateSchema,
  PortfolioQueueSchema,
  ProfileAssignSchema,
  ProfileCreateSchema,
  RecalculateSchema,
  RenewalSetSchema,
  RenewalSyncSchema,
  ReviewScheduleSchema,
  RiskCreateSchema,
  RiskEscalateSchema,
  RiskReopenSchema,
  RiskResolveSchema,
  RiskTransitionSchema,
  ScanSchema,
  SettingsPatchSchema,
} from "./dto/customer-success-shapes.js";

/**
 * A run that has not moved for this many days is "stale" for §11.1 `repairStalePlaybookRuns`.
 * It is a module constant rather than a setting because it describes when a run is *stuck*, not a
 * business policy an administrator tunes (§5.13).
 */
const STALE_RUN_DAYS = 30;

/**
 * Phase 19-CS — Customer Success domain commands (`/api/v1/CustomerSuccess`, §8.2).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API — a Profile, Plan, Goal, Risk or playbook
 * record is a metadata record, and the Entity Engine already serves list/detail/create/edit/delete for
 * it. These routes exist only for what a single record cannot express: module diagnostics, the
 * settings document, health recalculation and history, overrides, lifecycle transitions, onboarding
 * and playbook execution, plan/goal/risk commands, renewal readiness and the portfolio queues.
 *
 * This controller is registered before `ENTITY_CONTROLLERS`, so the static `CustomerSuccess` prefix
 * can never be swallowed by the generic `:entity` wildcard.
 */
@ApiTags("customer-success")
@Controller("api/v1/CustomerSuccess")
export class CustomerSuccessController {
  constructor(
    @Inject(CustomerSuccessModuleHealthService) private readonly health: CustomerSuccessModuleHealthService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(CustomerSuccessProfileService) private readonly profiles: CustomerSuccessProfileService,
    @Inject(CustomerSuccessHealthService) private readonly healthEngine: CustomerSuccessHealthService,
    @Inject(CustomerSuccessLifecycleService) private readonly lifecycle: CustomerSuccessLifecycleService,
    @Inject(CustomerSuccessPortfolioService) private readonly portfolio: CustomerSuccessPortfolioService,
    @Inject(CustomerSuccessPlanService) private readonly plans: CustomerSuccessPlanService,
    @Inject(CustomerSuccessGoalService) private readonly goals: CustomerSuccessGoalService,
    @Inject(CustomerSuccessRiskService) private readonly risks: CustomerSuccessRiskService,
    @Inject(CustomerSuccessPlaybookService) private readonly playbooks: CustomerSuccessPlaybookService,
    @Inject(CustomerSuccessRenewalService) private readonly renewals: CustomerSuccessRenewalService,
    @Inject(CustomerSuccessTouchpointService) private readonly touchpoints: CustomerSuccessTouchpointService,
    @Inject(CustomerSuccessDashletService) private readonly dashlets: CustomerSuccessDashletService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Module diagnostics and settings (§5.13, §8.2)
  // ---------------------------------------------------------------------------

  @Get("action/health")
  async moduleHealth() {
    this.requireAdmin("module diagnostics");
    return this.health.health();
  }

  @Get("action/settings")
  async readSettings() {
    return this.settings.read();
  }

  @HttpCode(200)
  @Post("action/settings")
  async updateSettings(@Body() body: unknown) {
    this.requireAdmin("changing Customer Success settings");
    parse(SettingsPatchSchema, body);
    return this.settings.update(body);
  }

  @Get("action/dashlets")
  dashletCatalog() {
    return { list: this.dashlets.definitions() };
  }

  // ---------------------------------------------------------------------------
  // Profiles, lifecycle and portfolio (§5.1, §5.2, §5.3)
  // ---------------------------------------------------------------------------

  @HttpCode(200)
  @Post("action/ensureProfile")
  async ensureProfile(@Body() body: unknown) {
    const input = parse(ProfileCreateSchema, body);
    await this.entities.get("Account", input.accountId);
    await this.acl.assertAccess("CustomerSuccessProfile", "create");
    return this.profiles.ensureForAccount(input);
  }

  @Get("action/profileSummary")
  async profileSummary(@Query("profileId") profileId?: string) {
    const id = requireQuery(profileId, "profileId");
    await this.assertProfile(id, "read");
    return this.profiles.summary(id);
  }

  @HttpCode(200)
  @Post("action/assignProfile")
  async assignProfile(@Query("profileId") profileId: string, @Body() body: unknown) {
    await this.assertProfile(profileId, "edit");
    const input = parse(ProfileAssignSchema, body);
    // §9.2: assigning requires permission to reach the destination user or team; an explicit
    // `null` clears the field instead and has no destination to check.
    if (typeof input.csmUserId === "string") await this.assertDestination("User", input.csmUserId, "csmUserId");
    if (typeof input.csmTeamId === "string") await this.assertDestination("Team", input.csmTeamId, "csmTeamId");
    return this.profiles.assign(profileId, input);
  }

  @HttpCode(200)
  @Post("action/transitionLifecycle")
  async transitionLifecycle(@Query("profileId") profileId: string, @Body() body: unknown) {
    await this.assertProfile(profileId, "edit");
    return this.lifecycle.transition(profileId, parse(LifecycleTransitionSchema, body));
  }

  @HttpCode(200)
  @Post("action/transitionLifecycleBulk")
  async transitionLifecycleBulk(@Body() body: unknown) {
    const input = parse(LifecycleBulkSchema, body);
    for (const id of input.ids) await this.assertProfile(id, "edit");
    return this.lifecycle.transitionBulk(input.ids, { to: input.to, reason: input.reason });
  }

  @HttpCode(200)
  @Post("action/transitionPreview")
  async transitionPreview(@Body() body: unknown) {
    const input = parse(LifecyclePreviewSchema, body);
    return this.lifecycle.transitionPreview(input.ids, input.to);
  }

  @Get("action/portfolioQueues")
  async portfolioQueues(
    @Query("queue") queue?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const input = parse(PortfolioQueueSchema, {
      queue,
      limit: numberOrUndefined(limit),
      offset: numberOrUndefined(offset),
    });
    return this.portfolio.queue(input.queue, { limit: input.limit, offset: input.offset });
  }

  @Get("action/portfolioSummary")
  async portfolioSummary() {
    return this.portfolio.summary();
  }

  // ---------------------------------------------------------------------------
  // Health (§5.4, §5.5)
  // ---------------------------------------------------------------------------

  @HttpCode(200)
  @Post("action/recalculateHealth")
  async recalculateHealth(@Body() body: unknown) {
    const input = parse(RecalculateSchema, body);
    await this.assertProfile(input.profileId, "edit");
    return this.healthEngine.recalculate(input.profileId, {
      source: "manual",
      force: input.force,
      triggerReason: input.triggerReason ?? null,
    });
  }

  /**
   * Batch recalculation across the portfolio (§8.2 `bulkRecalculateHealth`, administrator).
   *
   * It enqueues the registered `customerSuccess.recalculateHealthBatch` job instead of looping in the
   * request: the batch is bounded, it can cover every profile, and its progress, duration and
   * processed/skipped/error counts are visible in `/admin/jobs` like any other background job (§11.1,
   * §17). Returning the job row also gives the caller the id it needs to watch or cancel the run.
   */
  @HttpCode(200)
  @Post("action/bulkRecalculateHealth")
  async bulkRecalculateHealth(@Body() body: unknown) {
    this.requireAdmin("bulk health recalculation");
    const input = parse(BulkRecalculateSchema, body);
    const job = await this.jobs.enqueue({
      job: CUSTOMER_SUCCESS_JOB_NAMES.recalculateHealthBatch,
      data: { limit: input.limit, requestedBy: this.scope.userId ?? null },
    });
    return { job };
  }

  @Get("action/healthHistory")
  async healthHistory(@Query("profileId") profileId?: string, @Query("limit") limit?: string) {
    const input = parse(HistorySchema, {
      profileId: requireQuery(profileId, "profileId"),
      limit: numberOrUndefined(limit),
    });
    await this.assertProfile(input.profileId, "read");
    return { list: await this.healthEngine.history(input.profileId, input.limit) };
  }

  @Get("action/healthExplanation")
  async healthExplanation(@Query("profileId") profileId?: string) {
    const id = requireQuery(profileId, "profileId");
    await this.assertProfile(id, "read");
    return this.healthEngine.explanation(id);
  }

  @HttpCode(200)
  @Post("action/setHealthOverride")
  async setHealthOverride(@Body() body: unknown) {
    const input = parse(OverrideSchema, body);
    await this.requireElevated(input.profileId);
    return this.healthEngine.setOverride(input.profileId, {
      status: input.status,
      reason: input.reason,
      expiresAt: input.expiresAt ?? null,
    });
  }

  @HttpCode(200)
  @Post("action/clearHealthOverride")
  async clearHealthOverride(@Body() body: unknown) {
    const input = parse(ClearOverrideSchema, body);
    await this.requireElevated(input.profileId);
    return this.healthEngine.clearOverride(input.profileId, input.reason);
  }

  // ---------------------------------------------------------------------------
  // Success plans and goals (§5.6, §5.7)
  // ---------------------------------------------------------------------------

  @HttpCode(200)
  @Post("action/createPlan")
  async createPlan(@Body() body: unknown) {
    const input = parse(PlanCreateSchema, body);
    // §9.3 (IDOR): naming the account instead of the profile must not skip the record check.
    await this.assertProfile(await this.resolveProfileForCommand(input), "edit");
    return this.plans.create(input);
  }

  @HttpCode(200)
  @Post("action/activatePlan")
  async activatePlan(@Body() body: unknown) {
    const input = parse(PlanTransitionSchema, body);
    await this.assertRecord("CustomerSuccessPlan", input.planId, "edit");
    if (input.status === "active") return this.plans.activate(input.planId, input.allowSecondary);
    return this.plans.transition(input.planId, input.status);
  }

  @HttpCode(200)
  @Post("action/completePlan")
  async completePlan(@Body() body: unknown) {
    const input = parse(PlanTransitionSchema, body);
    await this.assertRecord("CustomerSuccessPlan", input.planId, "edit");
    return this.plans.complete(input.planId, input.closeOutSummary);
  }

  @HttpCode(200)
  @Post("action/duplicatePlan")
  async duplicatePlan(@Body() body: unknown) {
    const input = parse(PlanDuplicateSchema, body);
    await this.assertRecord("CustomerSuccessPlan", input.planId, "read");
    return this.plans.duplicate(input.planId);
  }

  @Get("action/planSummary")
  async planSummary(@Query("profileId") profileId?: string) {
    const id = requireQuery(profileId, "profileId");
    await this.assertProfile(id, "read");
    return this.plans.summary(id);
  }

  @HttpCode(200)
  @Post("action/createGoal")
  async createGoal(@Body() body: unknown) {
    const input = parse(GoalCreateSchema, body);
    await this.assertRecord("CustomerSuccessPlan", input.planId, "edit");
    // §9.3: a user cannot point a goal at a person they are not allowed to reach.
    if (input.ownerUserId !== undefined) await this.assertDestination("User", input.ownerUserId, "ownerUserId");
    return this.goals.create(input);
  }

  @HttpCode(200)
  @Post("action/updateGoalProgress")
  async updateGoalProgress(@Body() body: unknown) {
    const input = parse(GoalProgressSchema, body);
    await this.assertRecord("CustomerSuccessGoal", input.goalId, "edit");
    return this.goals.updateProgress(input.goalId, {
      currentValue: input.currentValue,
      manualProgress: input.manualProgress,
      note: input.note,
    });
  }

  // ---------------------------------------------------------------------------
  // Risks (§5.8)
  // ---------------------------------------------------------------------------

  @HttpCode(200)
  @Post("action/createRisk")
  async createRisk(@Body() body: unknown) {
    const input = parse(RiskCreateSchema, body);
    // §9.3 (IDOR): an account-named risk resolves to a profile first, and that profile is checked.
    await this.assertProfile(await this.resolveProfileForCommand(input), "edit");
    if (input.ownerUserId !== undefined) await this.assertDestination("User", input.ownerUserId, "ownerUserId");
    if (input.escalationTeamId !== undefined) {
      await this.assertDestination("Team", input.escalationTeamId, "escalationTeamId");
    }
    return this.risks.create(input);
  }

  @HttpCode(200)
  @Post("action/transitionRisk")
  async transitionRisk(@Body() body: unknown) {
    const input = parse(RiskTransitionSchema, body);
    await this.assertRecord("CustomerSuccessRisk", input.riskId, "edit");
    return this.risks.transition(input.riskId, input.status);
  }

  @HttpCode(200)
  @Post("action/escalateRisk")
  async escalateRisk(@Body() body: unknown) {
    const input = parse(RiskEscalateSchema, body);
    await this.assertRecord("CustomerSuccessRisk", input.riskId, "edit");
    return this.risks.escalate(input.riskId, { escalationTeamId: input.escalationTeamId, reason: input.reason });
  }

  @HttpCode(200)
  @Post("action/resolveRisk")
  async resolveRisk(@Body() body: unknown) {
    const input = parse(RiskResolveSchema, body);
    await this.assertRecord("CustomerSuccessRisk", input.riskId, "edit");
    return this.risks.resolve(input.riskId, input.outcome);
  }

  @HttpCode(200)
  @Post("action/reopenRisk")
  async reopenRisk(@Body() body: unknown) {
    const input = parse(RiskReopenSchema, body);
    await this.assertRecord("CustomerSuccessRisk", input.riskId, "edit");
    return this.risks.reopen(input.riskId, input.reason);
  }

  // ---------------------------------------------------------------------------
  // Onboarding and playbooks (§5.5, §5.11)
  // ---------------------------------------------------------------------------

  @HttpCode(200)
  @Post("action/createPlaybookTemplate")
  async createPlaybookTemplate(@Body() body: unknown) {
    this.requireAdmin("creating playbook templates");
    return this.playbooks.createTemplate(parse(PlaybookTemplateSchema, body));
  }

  @HttpCode(200)
  @Post("action/startPlaybook")
  async startPlaybook(@Body() body: unknown) {
    const input = parse(PlaybookStartSchema, body);
    if (input.profileId !== undefined) await this.assertProfile(input.profileId, "edit");
    return this.playbooks.startRun(input);
  }

  @Get("action/playbookRun")
  async playbookRun(@Query("runId") runId?: string) {
    const id = requireQuery(runId, "runId");
    await this.assertRecord("CustomerSuccessPlaybookRun", id, "read");
    return this.playbooks.run(id);
  }

  @HttpCode(200)
  @Post("action/completePlaybookStep")
  async completePlaybookStep(@Body() body: unknown) {
    const input = parse(PlaybookStepCompleteSchema, body);
    await this.assertRecord("CustomerSuccessPlaybookStepRun", input.stepRunId, "edit");
    return this.playbooks.completeStep(input.stepRunId, input.note);
  }

  @HttpCode(200)
  @Post("action/skipPlaybookStep")
  async skipPlaybookStep(@Body() body: unknown) {
    const input = parse(PlaybookStepSkipSchema, body);
    await this.assertRecord("CustomerSuccessPlaybookStepRun", input.stepRunId, "edit");
    if (input.overrideRequired) this.requireAdmin("overriding a required playbook step");
    return this.playbooks.skipStep(input.stepRunId, input.reason, input.overrideRequired);
  }

  @HttpCode(200)
  @Post("action/waitPlaybookStep")
  async waitPlaybookStep(@Body() body: unknown) {
    const input = parse(PlaybookStepWaitSchema, body);
    await this.assertRecord("CustomerSuccessPlaybookStepRun", input.stepRunId, "edit");
    return this.playbooks.waitUntil(input.stepRunId, input.until);
  }

  @HttpCode(200)
  @Post("action/cancelPlaybookRun")
  async cancelPlaybookRun(@Body() body: unknown) {
    const input = parse(PlaybookCancelSchema, body);
    await this.assertRecord("CustomerSuccessPlaybookRun", input.runId, "edit");
    return this.playbooks.cancelRun(input.runId, input.reason);
  }

  @HttpCode(200)
  @Post("action/retryFailedSteps")
  async retryFailedSteps(@Body() body: unknown) {
    const input = parse(PlaybookRetrySchema, body);
    await this.assertRecord("CustomerSuccessPlaybookRun", input.runId, "edit");
    return this.playbooks.retryFailedSteps(input.runId);
  }

  @HttpCode(200)
  @Post("action/startOnboarding")
  async startOnboarding(@Body() body: unknown) {
    const input = parse(OnboardingStartSchema, body);
    await this.assertProfile(input.profileId, "edit");
    return this.playbooks.startOnboarding(input.profileId, input.templateId);
  }

  @HttpCode(200)
  @Post("action/completeOnboarding")
  async completeOnboarding(@Body() body: unknown) {
    const input = parse(OnboardingCompleteSchema, body);
    await this.assertProfile(input.profileId, "edit");
    if (input.override) this.requireAdmin("overriding onboarding completion");
    return this.playbooks.completeOnboarding(input.profileId, input.override);
  }

  // ---------------------------------------------------------------------------
  // Renewal readiness, touchpoints and reviews (§5.9, §5.10)
  // ---------------------------------------------------------------------------

  @Get("action/renewalSummary")
  async renewalSummary(@Query("profileId") profileId?: string) {
    const id = requireQuery(profileId, "profileId");
    await this.assertProfile(id, "read");
    return this.renewals.summary(id);
  }

  @HttpCode(200)
  @Post("action/setRenewal")
  async setRenewal(@Body() body: unknown) {
    const input = parse(RenewalSetSchema, body);
    await this.assertProfile(input.profileId, "edit");
    return this.renewals.setManual(input.profileId, { renewalDate: input.renewalDate, status: input.status });
  }

  @HttpCode(200)
  @Post("action/syncRenewal")
  async syncRenewal(@Body() body: unknown) {
    const input = parse(RenewalSyncSchema, body);
    await this.assertProfile(input.profileId, "edit");
    return this.renewals.syncFromSource(input.profileId, input.force);
  }

  @Get("action/recentTouchpoints")
  async recentTouchpoints(@Query("profileId") profileId?: string) {
    const id = requireQuery(profileId, "profileId");
    await this.assertProfile(id, "read");
    return {
      list: await this.touchpoints.recent(id),
      lastMeaningfulTouchAt: await this.touchpoints.lastMeaningfulTouch(id),
    };
  }

  @HttpCode(200)
  @Post("action/scheduleReview")
  async scheduleReview(@Body() body: unknown) {
    const input = parse(ReviewScheduleSchema, body);
    await this.assertProfile(input.profileId, "edit");
    return this.touchpoints.scheduleReview(input);
  }

  @Get("action/reviews")
  async reviews(@Query("profileId") profileId?: string, @Query("limit") limit?: string) {
    const id = requireQuery(profileId, "profileId");
    await this.assertProfile(id, "read");
    return { list: await this.touchpoints.reviews(id, numberOrUndefined(limit) ?? 20) };
  }

  // ---------------------------------------------------------------------------
  // Worker-authorized operations (§11.1)
  //
  // The worker has no user session, so `@Public()` skips session authentication and the shared
  // worker→API capability in `x-worker-secret` is the authorisation — compared in constant time and
  // refused when no capability is configured. Each operation runs under the documented service
  // principal (a `system` user holding the built-in `sysAdmin` role) and is idempotent.
  // ---------------------------------------------------------------------------

  @Public()
  @HttpCode(200)
  @Post("action/recalculate-batch")
  async recalculateBatchForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(BulkRecalculateSchema, body);
    return runAsSystem(this.scope, "recalculate-batch", () =>
      this.healthEngine.recalculateBatch({ limit: input.limit, source: "scheduled" }),
    );
  }

  @Public()
  @HttpCode(200)
  @Post("action/expire-overrides")
  async expireOverridesForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ExpireOverridesSchema, body);
    const today = input.today ?? new Date().toISOString().slice(0, 10);
    return runAsSystem(this.scope, "expire-overrides", () => this.healthEngine.expireOverrides(today, input.limit));
  }

  @Public()
  @HttpCode(200)
  @Post("action/update-goal-overdue-state")
  async updateGoalOverdueStateForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ScanSchema, body);
    const today = input.today ?? todayIso();
    return runAsSystem(this.scope, "updateGoalOverdueState", () => this.goals.markOverdueState(today, input.limit));
  }

  @Public()
  @HttpCode(200)
  @Post("action/evaluate-renewal-windows")
  async evaluateRenewalWindowsForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ScanSchema, body);
    const today = input.today ?? todayIso();
    return runAsSystem(this.scope, "evaluateRenewalWindows", () => this.renewals.evaluateWindows(today, input.limit));
  }

  @Public()
  @HttpCode(200)
  @Post("action/evaluate-risk-escalations")
  async evaluateRiskEscalationsForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ScanSchema, body);
    const today = input.today ?? todayIso();
    return runAsSystem(this.scope, "evaluateRiskEscalations", () => this.risks.evaluateEscalations(today, input.limit));
  }

  @Public()
  @HttpCode(200)
  @Post("action/evaluate-review-reminders")
  async evaluateReviewRemindersForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ScanSchema, body);
    const today = input.today ?? todayIso();
    return runAsSystem(this.scope, "evaluateReviewReminders", () => this.touchpoints.evaluateReviewReminders(today, input.limit));
  }

  @Public()
  @HttpCode(200)
  @Post("action/process-playbook-wait-steps")
  async processPlaybookWaitStepsForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ScanSchema, body);
    const today = input.today ?? todayIso();
    return runAsSystem(this.scope, "processPlaybookWaitSteps", () => this.playbooks.processWaitSteps(today, input.limit));
  }

  @Public()
  @HttpCode(200)
  @Post("action/repair-stale-playbook-runs")
  async repairStalePlaybookRunsForWorker(@Body() body: unknown, @Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ScanSchema, body);
    return runAsSystem(this.scope, "repairStalePlaybookRuns", () => this.playbooks.repairStaleRuns(STALE_RUN_DAYS, input.limit));
  }

  // ---------------------------------------------------------------------------

  /** Loads a profile through the entity API (read ACL) and re-checks record ACL for `action`. */
  private async assertProfile(profileId: string, action: "read" | "edit"): Promise<Record<string, unknown>> {
    const dto = await this.entities.get("CustomerSuccessProfile", profileId);
    if (action === "read") return dto;
    await this.assertRecordOrThrow("CustomerSuccessProfile", profileId, "edit", dto);
    return dto;
  }

  /**
   * §9.2 — assigning requires permission to reach the *destination*: a CSM, team, goal owner or
   * escalation team the actor cannot see is refused, never written silently. Users and Teams are
   * identity rows in their own tables, not metadata records, so the destination is checked there —
   * the same read the Projects module performs for a member's user (§4.4). A missing or deleted
   * destination fails the same way, keeping the check both fail-closed and actionable.
   */
  private async assertDestination(entity: "User" | "Team", id: string, field: string): Promise<void> {
    const table = entity === "User" ? "users" : "teams";
    const row = await this.database.db
      .selectFrom(table)
      .select("id")
      .where("id", "=", id)
      .where("is_deleted", "=", false)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ValidationError(`The "${field}" destination is not available to you.`, { field, entity, id });
    }
  }

  /**
   * A plan/risk command may name the Account instead of the Profile (§5.6, §5.8). The Account is
   * resolved to its profile *before* the permission check, so naming an Account can never reach a
   * profile the actor may not edit (§8.3 IDOR) and an Account without a profile is an explicit
   * validation error rather than a record created with no owner.
   */
  private async resolveProfileForCommand(input: {
    readonly profileId?: string | undefined;
    readonly accountId?: string | undefined;
  }): Promise<string> {
    if (input.profileId !== undefined) return input.profileId;
    if (input.accountId === undefined) {
      throw new ValidationError("This request needs a profileId or an accountId.", {});
    }
    const profile = await this.profiles.byAccount(input.accountId);
    if (profile === undefined) {
      throw new ValidationError(`Account "${input.accountId}" has no Customer Success profile yet.`, {
        accountId: input.accountId,
      });
    }
    return profile.id;
  }

  private async assertRecord(entity: string, id: string, action: "read" | "edit"): Promise<void> {
    const dto = await this.entities.get(entity, id);
    if (action === "read") return;
    await this.assertRecordOrThrow(entity, id, action, dto);
  }

  private async assertRecordOrThrow(
    entity: string,
    id: string,
    action: "edit",
    dto: Record<string, unknown>,
  ): Promise<void> {
    const decision = await this.acl.canAccessRecord(entity, action, {
      id,
      data: dto,
      ...(typeof dto["assignedUserId"] === "string" ? { assignedUserId: dto["assignedUserId"] } : {}),
      ...(typeof dto["createdById"] === "string" ? { createdById: dto["createdById"] } : {}),
      ...(Array.isArray(dto["teams"]) ? { teams: dto["teams"] as string[] } : {}),
    });
    if (decision.allowed !== true) {
      throw new AuthorizationDeniedError(`No "${action}" access to this "${entity}" record.`, { entity, id });
    }
  }

  /** A health override is an elevated operation: an administrator, or the profile's own owner/CSM. */
  private async requireElevated(profileId: string): Promise<void> {
    if (this.scope.isAdmin) return;
    const profile = await this.entities.get("CustomerSuccessProfile", profileId);
    const userId = this.scope.userId;
    const isOwner =
      userId !== undefined &&
      (profile["csmUserId"] === userId || profile["assignedUserId"] === userId);
    if (!isOwner) {
      throw new AuthorizationDeniedError(
        "Setting a health override requires administrator access or ownership of the profile.",
      );
    }
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }

  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === "" || supplied === undefined) {
      throw new AuthenticationFailedError("Invalid worker capability.");
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError("Invalid worker capability.");
    }
  }
}

function requireQuery(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new InvalidQueryError(`The "${name}" query parameter is required.`, { parameter: name });
  }
  return value.trim();
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The evaluation day for a scan: UTC, so a scheduler and its API agree on "today". */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T["_output"] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError("The request is not valid.", {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}
