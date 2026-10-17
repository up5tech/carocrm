import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Phase 19-CS — the "this write comes from a Customer Success domain service" marker, and the
 * field lists the `beforeValidate` write guard protects.
 *
 * Two different callers write the same records: a user through the generic `/api/v1/:entity` API,
 * and a Customer Success domain service through `EntityCrudService` (recalculating a health score,
 * advancing a playbook run, transitioning a lifecycle). Their rules differ — the score engine
 * *must* move `healthScore`, a user must never be able to — and the only honest way to tell them
 * apart is for the domain services to say so. This mirrors `sales-internal.ts` exactly: one
 * async-local flag, no second entity layer.
 */

const storage = new AsyncLocalStorage<true>();

export function runAsCustomerSuccessInternal<T>(work: () => Promise<T>): Promise<T> {
  return storage.run(true, work);
}

export function isCustomerSuccessInternalWrite(): boolean {
  return storage.getStore() === true;
}

/**
 * The Customer Success entities this module owns.
 *
 * `CustomerSuccessHealthSnapshot` is append-only and module-written; every other entity is an
 * ordinary metadata record whose *lifecycle* fields the guard protects, not whose whole body is
 * off-limits.
 */
export const CUSTOMER_SUCCESS_ENTITY_TYPES = [
  "CustomerSuccessProfile",
  "CustomerSuccessHealthSnapshot",
  "CustomerSuccessPlan",
  "CustomerSuccessGoal",
  "CustomerSuccessRisk",
  "CustomerSuccessPlaybookTemplate",
  "CustomerSuccessPlaybookRun",
  "CustomerSuccessPlaybookStepRun",
  "CustomerSuccessReview",
] as const;

export type CustomerSuccessEntityType = (typeof CUSTOMER_SUCCESS_ENTITY_TYPES)[number];

/**
 * Fields the server computes on a `CustomerSuccessProfile` (§5.1, §9.3): the latest health summary,
 * the override trail, the derived touch/review timestamps, the onboarding roll-up and the portfolio
 * aggregates. A client write that sets any of these is refused by name.
 */
export const SERVER_OWNED_PROFILE_FIELDS: readonly string[] = [
  "healthStatus",
  "calculatedHealthStatus",
  "healthScore",
  "healthScoreAt",
  "healthOverrideByUserId",
  "healthOverrideAt",
  "lastMeaningfulTouchAt",
  "lastHealthReviewAt",
  "scoreTrend",
  "openRiskCount",
  "activePlanProgress",
  "onboardingStatus",
  "onboardingStartedAt",
  "onboardingCompletedAt",
  "activePlaybookRunId",
  "renewalSyncedAt",
];

/**
 * Fields the server computes on a plan or a goal. A plan's progress roll-up and a goal's computed
 * progress/status come from the goal service, never from a payload.
 */
export const SERVER_OWNED_PLAN_FIELDS: readonly string[] = ["progress"];
export const SERVER_OWNED_GOAL_FIELDS: readonly string[] = [
  "progress",
  "progressAt",
  "status",
];

/** A risk's resolved date and its status transitions belong to the risk service. */
export const SERVER_OWNED_RISK_FIELDS: readonly string[] = ["resolvedDate"];

/** A playbook template's steps are validated configuration, never an arbitrary body. */
export const SERVER_OWNED_PLAYBOOK_TEMPLATE_FIELDS: readonly string[] = ["steps"];

/**
 * Fields a playbook run/step run computes: status, progress counters and the template snapshot all
 * come from the execution service.
 */
export const SERVER_OWNED_PLAYBOOK_RUN_FIELDS: readonly string[] = [
  "status",
  "startedAt",
  "completedAt",
  "canceledAt",
  "stepSnapshot",
  "completedStepCount",
  "errorSummary",
];
export const SERVER_OWNED_PLAYBOOK_STEP_RUN_FIELDS: readonly string[] = [
  "status",
  "completedAt",
  "errorSummary",
  "attemptCount",
  "linkedEntityType",
  "linkedEntityId",
];

/** A review's link to the Activity it documents is set by the service, not typed freely. */
export const SERVER_OWNED_REVIEW_FIELDS: readonly string[] = ["activityId", "activityType"];

/** Keys whose value actually differs from the stored record — a no-op save is not a change. */
export function changedKeys(
  data: Record<string, unknown>,
  previous: Record<string, unknown>,
): string[] {
  return Object.keys(data).filter((key) => !sameValue(data[key], previous[key]));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}
