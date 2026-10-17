/**
 * Phase 19-CS request shapes (PLAN_Phase_19_Customer_Success.md §8.2).
 *
 * The controller parses these; the domain services receive already-validated values, so no service
 * has to second-guess a payload. `.strict()` rejects unknown fields, exactly like
 * `apps/api/src/sales/dto/sales-shapes.ts`.
 *
 * A shape failure is rendered by the controllers' shared `parse()` helper as the kernel error
 * envelope with `400 INVALID_QUERY` and an issue list — that is what the Sales, Projects and
 * Document controllers do with the same helper, and this module deliberately does not invent a
 * second convention. A *domain* rule that the shape cannot express (an invalid transition, a
 * mitigation required for a Critical risk, a stale version) is a `ValidationError` and comes back
 * as `422 VALIDATION_FAILED`. Both are documented in
 * `docs/modules/customer-success/compatibility.md`.
 */
import { z } from "zod";

import {
  GOAL_DIRECTIONS,
  HEALTH_STATUSES,
  LIFECYCLE_STAGES,
  PLAYBOOK_STEP_TYPES,
  PLAYBOOK_TRIGGER_MODES,
  PORTFOLIO_QUEUES,
  RENEWAL_STATUSES,
  RISK_SEVERITIES,
  RISK_TYPES,
} from "../customer-success-domain.js";

const id = z.string().trim().min(1).max(64);
const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().trim().min(1).max(255);

const optId = id.nullish().transform((value) => value ?? undefined);
const optDay = day.nullish().transform((value) => value ?? undefined);
const optText = z
  .string()
  .trim()
  .max(60_000)
  .nullish()
  .transform((value) => (value === null || value === "" ? undefined : value));

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export const ProfileCreateSchema = z.object({
  accountId: id,
  csmUserId: optId,
  csmTeamId: optId,
  segment: optText,
  lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
  renewalDate: optDay,
  customerSince: optDay,
}).strict();

/**
 * `.nullish()` without a transform keeps *absent* and an explicit `null` apart: absent means "leave
 * this field alone", `null` means "clear it". A `value ?? null` transform would turn a missing key
 * into `null`, so assigning a CSM would silently clear the team as well.
 */
export const ProfileAssignSchema = z.object({
  csmUserId: id.nullish(),
  csmTeamId: id.nullish(),
}).strict();

export const LifecycleTransitionSchema = z.object({
  to: z.enum(LIFECYCLE_STAGES),
  reason: optText,
  version: z.number().int().nonnegative().optional(),
}).strict();

export const LifecycleBulkSchema = z.object({
  ids: z.array(id).min(1).max(200),
  to: z.enum(LIFECYCLE_STAGES),
  reason: optText,
}).strict();

export const LifecyclePreviewSchema = z.object({
  ids: z.array(id).min(1).max(200),
  to: z.enum(LIFECYCLE_STAGES),
}).strict();

export const ProfileIdSchema = z.object({ profileId: id }).strict();

export const RecalculateSchema = z.object({
  profileId: id,
  force: z.boolean().default(false),
  triggerReason: optText,
}).strict();

export const BulkRecalculateSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(200),
}).strict();

export const OverrideSchema = z.object({
  profileId: id,
  status: z.enum(
    HEALTH_STATUSES.filter((status) => status !== "unknown") as unknown as [string, ...string[]],
  ),
  reason: z.string().trim().min(1).max(2000),
  expiresAt: optDay,
}).strict();

export const ClearOverrideSchema = z.object({
  profileId: id,
  reason: z.string().trim().max(2000).default(""),
}).strict();

export const HistorySchema = z.object({
  profileId: id,
  limit: z.number().int().min(1).max(500).default(50),
}).strict();

export const PlanCreateSchema = z.object({
  profileId: optId,
  accountId: optId,
  name,
  planType: optText,
  ownerUserId: optId,
  startDate: optDay,
  endDate: optDay,
  nextReviewDate: optDay,
  outcomes: optText,
  baselineSummary: optText,
  executiveSponsorContactId: optId,
  projectId: optId,
  contactIds: z.array(id).max(200).optional(),
}).strict();

export const PlanTransitionSchema = z.object({
  planId: id,
  status: z.enum(["draft", "active", "onHold", "completed", "canceled"]),
  allowSecondary: z.boolean().default(false),
  closeOutSummary: optText,
}).strict();

export const PlanDuplicateSchema = z.object({ planId: id }).strict();

export const GoalCreateSchema = z.object({
  planId: id,
  name,
  description: optText,
  category: optText,
  direction: z.enum(GOAL_DIRECTIONS),
  baselineValue: z.number().finite().nullish().transform((value) => value ?? undefined),
  baselineDate: optDay,
  targetValue: z.number().finite().nullish().transform((value) => value ?? undefined),
  targetDate: optDay,
  currentValue: z.number().finite().nullish().transform((value) => value ?? undefined),
  currentDate: optDay,
  unit: optText,
  ownerUserId: optId,
  contactId: optId,
  tolerance: z.number().finite().nonnegative().nullish().transform((value) => value ?? undefined),
  manualProgress: z.number().finite().min(0).max(100).nullish().transform((value) => value ?? undefined),
}).strict();

export const GoalProgressSchema = z.object({
  goalId: id,
  currentValue: z.number().finite().nullish().transform((value) => value ?? undefined),
  manualProgress: z.number().finite().min(0).max(100).nullish().transform((value) => value ?? undefined),
  note: optText,
}).strict();

export const RiskCreateSchema = z.object({
  profileId: optId,
  accountId: optId,
  planId: optId,
  title: name,
  description: optText,
  riskType: z.enum(RISK_TYPES).optional(),
  severity: z.enum(RISK_SEVERITIES),
  ownerUserId: optId,
  escalationTeamId: optId,
  detectedDate: optDay,
  nextReviewDate: optDay,
  targetResolutionDate: optDay,
  evidenceSummary: optText,
  mitigationPlan: optText,
  nextAction: optText,
  contributesToHealth: z.boolean().optional(),
  contactId: optId,
  opportunityId: optId,
  subscriptionId: optId,
  probability: z.number().finite().min(0).max(100).optional(),
  impact: z.number().finite().min(0).max(100).optional(),
}).strict();

export const RiskTransitionSchema = z.object({
  riskId: id,
  status: z.enum(["open", "mitigating", "escalated", "resolved", "accepted", "closed"]),
}).strict();

export const RiskEscalateSchema = z.object({
  riskId: id,
  escalationTeamId: optId,
  reason: optText,
}).strict();

export const RiskResolveSchema = z.object({
  riskId: id,
  outcome: z.string().trim().min(1).max(4000),
}).strict();

export const RiskReopenSchema = z.object({
  riskId: id,
  reason: z.string().trim().max(4000).default(""),
}).strict();

export const PlaybookTemplateSchema = z.object({
  name,
  description: optText,
  playbookType: optText,
  triggerMode: z.enum(PLAYBOOK_TRIGGER_MODES).optional(),
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  steps: z
    .array(
      z
        .object({
          key: z.string().trim().regex(/^[a-z][A-Za-z0-9_]{0,63}$/),
          name,
          stepType: z.enum(PLAYBOOK_STEP_TYPES),
          order: z.number().int().min(0).max(1000),
          required: z.boolean().optional(),
          dueOffsetDays: z.number().int().min(0).max(3650).nullish().transform((value) => value ?? undefined),
          assigneePolicy: z.enum(["profileCsm", "accountOwner", "none"]).optional(),
          dependsOn: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
          instructions: optText,
        })
        .strict(),
    )
    .min(1)
    .max(200),
}).strict();

export const PlaybookStartSchema = z.object({
  profileId: optId,
  accountId: optId,
  templateId: id,
  triggerKey: optText,
  triggerSource: optText,
}).strict();

export const PlaybookStepCompleteSchema = z.object({
  stepRunId: id,
  note: optText,
}).strict();

export const PlaybookStepSkipSchema = z.object({
  stepRunId: id,
  reason: z.string().trim().min(1).max(2000),
  overrideRequired: z.boolean().default(false),
}).strict();

export const PlaybookStepWaitSchema = z.object({
  stepRunId: id,
  until: day,
}).strict();

export const PlaybookCancelSchema = z.object({
  runId: id,
  reason: z.string().trim().min(1).max(2000),
}).strict();

export const PlaybookRetrySchema = z.object({ runId: id }).strict();

export const OnboardingStartSchema = z.object({
  profileId: id,
  templateId: optId,
}).strict();

export const OnboardingCompleteSchema = z.object({
  profileId: id,
  override: z.boolean().default(false),
}).strict();

export const RenewalSetSchema = z.object({
  profileId: id,
  renewalDate: day.nullish().transform((value) => value ?? null),
  status: z.enum(RENEWAL_STATUSES).optional(),
}).strict();

export const RenewalSyncSchema = z.object({
  profileId: id,
  force: z.boolean().default(false),
}).strict();

export const ReviewScheduleSchema = z.object({
  profileId: id,
  name,
  activityType: z.enum(["Call", "Meeting", "Task", "Email"]).optional(),
  dateStart: day,
  duration: z.number().int().min(15).max(480).optional(),
  ownerUserId: optId,
  objectives: optText,
  outcomes: optText,
  openRisks: optText,
  goalProgressNote: optText,
  sentiment: z.enum(["positive", "neutral", "negative", "unknown"]).optional(),
  actionItems: optText,
  nextReviewDate: optDay,
  contactIds: z.array(id).max(200).optional(),
}).strict();

export const PortfolioQueueSchema = z.object({
  queue: z.enum(PORTFOLIO_QUEUES).default("myPortfolio"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
}).strict();

/**
 * Body of a worker-authorised scan endpoint (§11.1): an optional evaluation day and a bounded batch
 * size. Every scheduled scan takes the same body, so a scheduler can drive any of them the same way.
 */
export const ScanSchema = z.object({
  today: day.optional(),
  limit: z.number().int().min(1).max(1000).default(500),
}).strict();

export type ScanInput = z.infer<typeof ScanSchema>;

export const ExpireOverridesSchema = z.object({
  today: day.optional(),
  limit: z.number().int().min(1).max(1000).default(200),
}).strict();

export type SettingsPatchInput = z.infer<typeof SettingsPatchSchema>;
export type ProfileCreateInput = z.infer<typeof ProfileCreateSchema>;
export type ProfileAssignInput = z.infer<typeof ProfileAssignSchema>;
export type LifecycleTransitionInput = z.infer<typeof LifecycleTransitionSchema>;
export type LifecycleBulkInput = z.infer<typeof LifecycleBulkSchema>;
export type RecalculateInput = z.infer<typeof RecalculateSchema>;
export type BulkRecalculateInput = z.infer<typeof BulkRecalculateSchema>;
export type OverrideInput = z.infer<typeof OverrideSchema>;
export type ClearOverrideInput = z.infer<typeof ClearOverrideSchema>;
export type HistoryInput = z.infer<typeof HistorySchema>;
export type PlanCreateInput = z.infer<typeof PlanCreateSchema>;
export type PlanTransitionInput = z.infer<typeof PlanTransitionSchema>;
export type GoalCreateInput = z.infer<typeof GoalCreateSchema>;
export type GoalProgressInput = z.infer<typeof GoalProgressSchema>;
export type RiskCreateInput = z.infer<typeof RiskCreateSchema>;
export type RiskTransitionInput = z.infer<typeof RiskTransitionSchema>;
export type RiskEscalateInput = z.infer<typeof RiskEscalateSchema>;
export type RiskResolveInput = z.infer<typeof RiskResolveSchema>;
export type RiskReopenInput = z.infer<typeof RiskReopenSchema>;
export type PlaybookTemplateInput = z.infer<typeof PlaybookTemplateSchema>;
export type PlaybookStartInput = z.infer<typeof PlaybookStartSchema>;
export type PlaybookStepCompleteInput = z.infer<typeof PlaybookStepCompleteSchema>;
export type PlaybookStepSkipInput = z.infer<typeof PlaybookStepSkipSchema>;
export type PlaybookStepWaitInput = z.infer<typeof PlaybookStepWaitSchema>;
export type PlaybookCancelInput = z.infer<typeof PlaybookCancelSchema>;
export type OnboardingStartInput = z.infer<typeof OnboardingStartSchema>;
export type OnboardingCompleteInput = z.infer<typeof OnboardingCompleteSchema>;
export type RenewalSetInput = z.infer<typeof RenewalSetSchema>;
export type RenewalSyncInput = z.infer<typeof RenewalSyncSchema>;
export type ReviewScheduleInput = z.infer<typeof ReviewScheduleSchema>;
export type PortfolioQueueInput = z.infer<typeof PortfolioQueueSchema>;
