/**
 * Phase 19-CS.11 — the Customer Success module's job names (PLAN_Phase_19_Customer_Success.md §11.1).
 *
 * The API and the worker are separate packages, so each side declares the same names: the worker
 * registers handlers under them (`apps/worker/src/handlers/customer-success-handlers.ts`) and the API
 * enqueues them here. Mirroring `SALES_JOB_NAMES` in `apps/api/src/sales/job-monitoring/monitor.ts`.
 *
 * Every name is also a `scheduled_jobs.job` row installed by `database/seed.ts`; the scheduler picks
 * them up by name, so a rename here must be a migration, not just an edit.
 */
export const CUSTOMER_SUCCESS_JOB_NAMES = {
  recalculateHealthBatch: "customerSuccess.recalculateHealthBatch",
  expireHealthOverrides: "customerSuccess.expireHealthOverrides",
  updateGoalOverdueState: "customerSuccess.updateGoalOverdueState",
  evaluateRenewalWindows: "customerSuccess.evaluateRenewalWindows",
  evaluateRiskEscalations: "customerSuccess.evaluateRiskEscalations",
  evaluateReviewReminders: "customerSuccess.evaluateReviewReminders",
  processPlaybookWaitSteps: "customerSuccess.processPlaybookWaitSteps",
  repairStalePlaybookRuns: "customerSuccess.repairStalePlaybookRuns",
} as const;
