import type { Logger } from "@carocrm/core/logger/index.js";
import type { JobContext, JobHandler, JobRegistry } from "@carocrm/jobs";

/**
 * Phase 19-CS.11 — the Customer Success module's scheduled work, registered in the worker composition
 * root (PLAN_Phase_19_Customer_Success.md §11.1).
 *
 * Like `registerSalesJobs`, a handler deliberately does **not** touch the Customer Success tables
 * itself. Recalculating health, expiring an override or advancing a playbook run is a domain
 * operation: it moves a state machine, writes audit and stream rows and emits a domain event, and the
 * only place that happens correctly is the application layer. So each job calls the API's
 * worker-authorised endpoint with the shared capability (`x-worker-secret`), and that endpoint runs
 * exactly the operation an administrator would — under the documented service principal.
 *
 * Idempotency is what makes a retry safe, and it comes from the domain rules rather than from a flag:
 * a snapshot is deduplicated by a material-change signature, an override is cleared only while it is
 * past its date, and a playbook step waits until its date has passed.
 */

export const CS_JOB_NAMES = {
  recalculateHealthBatch: "customerSuccess.recalculateHealthBatch",
  expireHealthOverrides: "customerSuccess.expireHealthOverrides",
  updateGoalOverdueState: "customerSuccess.updateGoalOverdueState",
  evaluateRenewalWindows: "customerSuccess.evaluateRenewalWindows",
  evaluateRiskEscalations: "customerSuccess.evaluateRiskEscalations",
  evaluateReviewReminders: "customerSuccess.evaluateReviewReminders",
  processPlaybookWaitSteps: "customerSuccess.processPlaybookWaitSteps",
  repairStalePlaybookRuns: "customerSuccess.repairStalePlaybookRuns",
} as const;

export interface CustomerSuccessJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

/**
 * One endpoint per job (§11.1), so a run reports *its own* processed/skipped/error counts and
 * duration instead of the aggregate of every scan. Each mirrors a route declared in
 * `apps/api/src/customer-success/customer-success.controller.ts`; the kebab-case suffix is the
 * established shape for a worker twin of a PascalCase admin route (`expireQuotes` / `expire-quotes`).
 */
const JOB_PATHS = {
  recalculateHealthBatch: "/api/v1/CustomerSuccess/action/recalculate-batch",
  expireHealthOverrides: "/api/v1/CustomerSuccess/action/expire-overrides",
  updateGoalOverdueState: "/api/v1/CustomerSuccess/action/update-goal-overdue-state",
  evaluateRenewalWindows: "/api/v1/CustomerSuccess/action/evaluate-renewal-windows",
  evaluateRiskEscalations: "/api/v1/CustomerSuccess/action/evaluate-risk-escalations",
  evaluateReviewReminders: "/api/v1/CustomerSuccess/action/evaluate-review-reminders",
  processPlaybookWaitSteps: "/api/v1/CustomerSuccess/action/process-playbook-wait-steps",
  repairStalePlaybookRuns: "/api/v1/CustomerSuccess/action/repair-stale-playbook-runs",
} as const;

/** Internal signal: the run was cancelled before the API was called. Never escapes a handler. */
class CancelledBeforeCall extends Error {}

async function callWorkerOperation(
  deps: CustomerSuccessJobDeps,
  context: JobContext,
  operation: { readonly path: string; readonly label: string; readonly body: Record<string, unknown> },
): Promise<{ disabled: true } | { disabled: false; payload: Record<string, unknown> }> {
  if (deps.secret.trim() === "") return { disabled: true };
  if (await context.shouldStop()) throw new CancelledBeforeCall();
  context.progress(20, operation.label);
  const fetcher = deps.fetcher ?? fetch;
  const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, "")}${operation.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": deps.secret },
    body: JSON.stringify(operation.body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`${operation.label} failed with HTTP ${String(response.status)}.`);
  }
  return { disabled: false, payload: (await response.json()) as Record<string, unknown> };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function batchJob(
  deps: CustomerSuccessJobDeps,
  job: string,
  operation: { readonly path: string; readonly label: string; readonly body: () => Record<string, unknown> },
): JobHandler {
  return async (context: JobContext) => {
    let outcome: Awaited<ReturnType<typeof callWorkerOperation>>;
    try {
      outcome = await callWorkerOperation(deps, context, {
        path: operation.path,
        label: operation.label,
        body: operation.body(),
      });
    } catch (error: unknown) {
      if (error instanceof CancelledBeforeCall) {
        return { status: "cancelled", message: `Cancelled before ${operation.label}.` };
      }
      throw error;
    }
    if (outcome.disabled) {
      return {
        status: "completed",
        message: `${job} is disabled: no worker capability is configured.`,
        result: { disabled: true },
      };
    }
    context.progress(100, `${operation.label} finished`);
    // Safe diagnostics only: counts, never customer content (§17).
    deps.log.info({ job, result: outcome.payload }, "customer success job finished");
    return {
      status: "completed",
      message: `${operation.label} finished`,
      result: outcome.payload,
    };
  };
}

/** Recalculate profiles whose score is missing or older than the configured refresh interval. */
export function recalculateHealthBatchJob(deps: CustomerSuccessJobDeps): JobHandler {
  return batchJob(deps, CS_JOB_NAMES.recalculateHealthBatch, {
    path: JOB_PATHS.recalculateHealthBatch,
    label: "recalculating customer health",
    body: () => ({}),
  });
}

/** Expire health overrides whose date has passed, restoring the calculated status. */
export function expireHealthOverridesJob(deps: CustomerSuccessJobDeps): JobHandler {
  return batchJob(deps, CS_JOB_NAMES.expireHealthOverrides, {
    path: JOB_PATHS.expireHealthOverrides,
    label: "expiring health overrides",
    body: () => ({ today: today() }),
  });
}

/**
 * Every remaining §11.1 job is a bounded scan with the same body — the evaluation day — and its own
 * endpoint, so its own counts. Each factory exists so a job can be built and asserted on its own.
 */
function scanJob(
  deps: CustomerSuccessJobDeps,
  job: (typeof CS_JOB_NAMES)[keyof typeof CS_JOB_NAMES],
  path: string,
  label: string,
): JobHandler {
  return batchJob(deps, job, { path, label, body: () => ({ today: today() }) });
}

/** Mark goals past their target date overdue, without churning rows that are already right. */
export function updateGoalOverdueStateJob(deps: CustomerSuccessJobDeps): JobHandler {
  return scanJob(deps, CS_JOB_NAMES.updateGoalOverdueState, JOB_PATHS.updateGoalOverdueState, "updating overdue goal state");
}

/** Detect profiles newly entering a configured renewal window. */
export function evaluateRenewalWindowsJob(deps: CustomerSuccessJobDeps): JobHandler {
  return scanJob(deps, CS_JOB_NAMES.evaluateRenewalWindows, JOB_PATHS.evaluateRenewalWindows, "evaluating renewal windows");
}

/** Find overdue and Critical risks that need a review, and tell their owners. */
export function evaluateRiskEscalationsJob(deps: CustomerSuccessJobDeps): JobHandler {
  return scanJob(deps, CS_JOB_NAMES.evaluateRiskEscalations, JOB_PATHS.evaluateRiskEscalations, "evaluating risk escalations");
}

/** Remind owners about reviews that are due or overdue. */
export function evaluateReviewRemindersJob(deps: CustomerSuccessJobDeps): JobHandler {
  return scanJob(deps, CS_JOB_NAMES.evaluateReviewReminders, JOB_PATHS.evaluateReviewReminders, "evaluating review reminders");
}

/** Resume playbook steps whose wait date has passed. */
export function processPlaybookWaitStepsJob(deps: CustomerSuccessJobDeps): JobHandler {
  return scanJob(deps, CS_JOB_NAMES.processPlaybookWaitSteps, JOB_PATHS.processPlaybookWaitSteps, "processing playbook wait steps");
}

/** Close runs whose steps are all terminal; report the ones that still need a person. */
export function repairStalePlaybookRunsJob(deps: CustomerSuccessJobDeps): JobHandler {
  return scanJob(deps, CS_JOB_NAMES.repairStalePlaybookRuns, JOB_PATHS.repairStalePlaybookRuns, "repairing stale playbook runs");
}

export function registerCustomerSuccessJobs(registry: JobRegistry, deps: CustomerSuccessJobDeps): void {
  registry.register(CS_JOB_NAMES.recalculateHealthBatch, recalculateHealthBatchJob(deps));
  registry.register(CS_JOB_NAMES.expireHealthOverrides, expireHealthOverridesJob(deps));
  registry.register(CS_JOB_NAMES.updateGoalOverdueState, updateGoalOverdueStateJob(deps));
  registry.register(CS_JOB_NAMES.evaluateRenewalWindows, evaluateRenewalWindowsJob(deps));
  registry.register(CS_JOB_NAMES.evaluateRiskEscalations, evaluateRiskEscalationsJob(deps));
  registry.register(CS_JOB_NAMES.evaluateReviewReminders, evaluateReviewRemindersJob(deps));
  registry.register(CS_JOB_NAMES.processPlaybookWaitSteps, processPlaybookWaitStepsJob(deps));
  registry.register(CS_JOB_NAMES.repairStalePlaybookRuns, repairStalePlaybookRunsJob(deps));
}
