import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';

/**
 * Phase 19-S.7 — the Sales module's scheduled work, registered in the worker composition root.
 *
 * The handler deliberately does **not** touch the Sales tables itself. Expiring a quote is a domain
 * operation: it moves a state machine, writes audit and stream rows and emits a domain event, and the
 * only place that happens correctly is the application layer. So the job calls the API's
 * worker-authorized endpoint with the shared capability — the same shape `reports.deliver` uses — and
 * that endpoint runs exactly the operation an administrator would.
 *
 * Idempotency is what makes a retry safe, and it comes from the state machine rather than from a flag:
 * only a quote in `sent` is a candidate, and expiring takes it out of that state, so a second attempt
 * (or a second worker racing the first) changes nothing.
 */

export const EXPIRE_QUOTES_JOB = 'sales.expireQuotes';

export interface SalesJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

export const EXPIRE_QUOTES_PATH = '/api/v1/Sales/action/expire-quotes';

/** 19-S.9 — the same shape, for invoices whose due date has passed. */
export const MARK_OVERDUE_INVOICES_JOB = 'sales.markOverdueInvoices';
export const MARK_OVERDUE_INVOICES_PATH = '/api/v1/Sales/action/mark-overdue-invoices';

/** 19-S.16 — generate due recurring invoices. */
export const GENERATE_SUBSCRIPTION_INVOICES_JOB = 'sales.generateSubscriptionInvoices';
export const GENERATE_SUBSCRIPTION_INVOICES_PATH = '/api/v1/Sales/action/generate-subscription-invoices';

/**
 * Call a worker-authorized Sales operation and return what it reported.
 *
 * Shared by both jobs so the capability check, the timeout, the failure semantics and the
 * cancellation check exist once. A missing capability makes the caller inert rather than failed: an
 * installation that never configured it simply does not run the job, and should not accumulate
 * retries.
 */
async function callWorkerOperation(
  deps: SalesJobDeps,
  context: JobContext,
  operation: { readonly path: string; readonly label: string },
): Promise<{ disabled: true } | { disabled: false; payload: Record<string, unknown> }> {
  if (deps.secret.trim() === '') return { disabled: true };
  if (await context.shouldStop()) throw new CancelledBeforeCall();

  context.progress(20, operation.label);
  const fetcher = deps.fetcher ?? fetch;
  const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}${operation.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': deps.secret },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${operation.label} failed with HTTP ${String(response.status)}.`);
  }
  return { disabled: false, payload: (await response.json()) as Record<string, unknown> };
}

/** Internal signal: the run was cancelled before the API was called. Never escapes a handler. */
class CancelledBeforeCall extends Error {}

export function expireQuotesJob(deps: SalesJobDeps): JobHandler {
  return async (context: JobContext) => {
    let outcome: Awaited<ReturnType<typeof callWorkerOperation>>;
    try {
      outcome = await callWorkerOperation(deps, context, { path: EXPIRE_QUOTES_PATH, label: 'expiring quotes past their validity date' });
    } catch (error: unknown) {
      if (error instanceof CancelledBeforeCall) return { status: 'cancelled', message: 'Cancelled before quote expiry.' };
      throw error;
    }
    if (outcome.disabled) {
      return {
        status: 'completed',
        message: 'Quote expiry is disabled: no worker capability is configured.',
        result: { disabled: true },
      };
    }

    const expired = Array.isArray(outcome.payload['expired']) ? outcome.payload['expired'].length : 0;
    const skipped = typeof outcome.payload['skipped'] === 'number' ? outcome.payload['skipped'] : 0;
    context.progress(100, `${String(expired)} quote(s) expired`);
    context.log(`expired ${String(expired)} quote(s); ${String(skipped)} still inside their validity window`, 'info');
    deps.log.info({ expired, skipped }, 'sales quote expiry finished');
    return { status: 'completed', message: `Expired ${String(expired)} quote(s)`, result: { expired, skipped } };
  };
}

export function markOverdueInvoicesJob(deps: SalesJobDeps): JobHandler {
  return async (context: JobContext) => {
    let outcome: Awaited<ReturnType<typeof callWorkerOperation>>;
    try {
      outcome = await callWorkerOperation(deps, context, { path: MARK_OVERDUE_INVOICES_PATH, label: 'marking overdue invoices' });
    } catch (error: unknown) {
      if (error instanceof CancelledBeforeCall) return { status: 'cancelled', message: 'Cancelled before overdue detection.' };
      throw error;
    }
    if (outcome.disabled) {
      return {
        status: 'completed',
        message: 'Overdue detection is disabled: no worker capability is configured.',
        result: { disabled: true },
      };
    }

    const overdue = Array.isArray(outcome.payload['overdue']) ? outcome.payload['overdue'].length : 0;
    const checked = typeof outcome.payload['checked'] === 'number' ? outcome.payload['checked'] : 0;
    context.progress(100, `${String(overdue)} invoice(s) marked overdue`);
    context.log(`marked ${String(overdue)} of ${String(checked)} issued invoice(s) overdue`, 'info');
    deps.log.info({ overdue, checked }, 'sales overdue detection finished');
    return { status: 'completed', message: `Marked ${String(overdue)} invoice(s) overdue`, result: { overdue, checked } };
  };
}

/**
 * Phase 19-S.16 — the recurring billing run.
 *
 * The job itself holds no billing logic: it asks the API to run the billing service and reports what
 * it did. Two things are reported rather than swallowed — a run on an installation where the
 * `subscriptions` feature is off comes back `enabled: false` (a configuration fact, not a failure),
 * and a `truncated` run says work is still waiting for the next one.
 */
export function generateSubscriptionInvoicesJob(deps: SalesJobDeps): JobHandler {
  return async (context: JobContext) => {
    let outcome: Awaited<ReturnType<typeof callWorkerOperation>>;
    try {
      outcome = await callWorkerOperation(deps, context, { path: GENERATE_SUBSCRIPTION_INVOICES_PATH, label: 'generating subscription invoices' });
    } catch (error: unknown) {
      if (error instanceof CancelledBeforeCall) return { status: 'cancelled', message: 'Cancelled before subscription billing.' };
      throw error;
    }
    if (outcome.disabled) {
      return {
        status: 'completed',
        message: 'Subscription billing is disabled: no worker capability is configured.',
        result: { disabled: true },
      };
    }
    if (outcome.payload['enabled'] === false) {
      return {
        status: 'completed',
        message: 'Subscription billing is disabled in the Sales settings: nothing was billed.',
        result: { enabled: false },
      };
    }
    const invoiced = typeof outcome.payload['invoiced'] === 'number' ? outcome.payload['invoiced'] : 0;
    const failed = typeof outcome.payload['failed'] === 'number' ? outcome.payload['failed'] : 0;
    const truncated = outcome.payload['truncated'] === true;
    context.progress(100, `generated ${String(invoiced)} invoice(s)`);
    deps.log.info(
      { invoiced, failed, truncated, subscriptions: outcome.payload['subscriptions'] },
      'sales subscription billing finished',
    );
    const message = truncated
      ? `Generated ${String(invoiced)} invoice(s); more periods are still waiting for the next run`
      : `Generated ${String(invoiced)} invoice(s)`;
    return { status: 'completed', message, result: outcome.payload };
  };
}

export function registerSalesJobs(registry: JobRegistry, deps: SalesJobDeps): void {
  registry.register(EXPIRE_QUOTES_JOB, expireQuotesJob(deps));
  registry.register(MARK_OVERDUE_INVOICES_JOB, markOverdueInvoicesJob(deps));
  registry.register(GENERATE_SUBSCRIPTION_INVOICES_JOB, generateSubscriptionInvoicesJob(deps));
}
