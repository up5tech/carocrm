import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';

/**
 * Phase 19-MA.9/MA.13 — the Marketing Automation module's scheduled work, registered in the worker
 * composition root.
 *
 * The handlers deliberately do **not** touch the marketing tables themselves. Claiming recipients,
 * rendering content, handing messages to a provider and advancing enrollments are domain operations:
 * they move state machines, write audit rows and emit domain events, and the only place that happens
 * correctly is the application layer. So each job calls the API's worker-authorized endpoint with the
 * shared capability — the same shape `reports.deliver`, `sales.*`, `customerSuccess.*` and
 * `serviceDesk.*` use — and that endpoint runs exactly the operation an administrator would.
 *
 * Idempotency comes from the domain records, not from flags: delivery rows are claimed with
 * `FOR UPDATE SKIP LOCKED` under a per-recipient idempotency key, and journey steps run under their
 * enrollment's own claim — so a retry (or a second worker racing the first) changes nothing.
 *
 * A missing capability makes the caller inert rather than failed: an installation that never
 * configured it simply does not run the job, and must not accumulate retries.
 */

/** MA.9 — claim open delivery work (`Queued`/`Sending` sends) and submit it through the provider gate. */
export const DELIVERY_BATCH_JOB = 'marketing.deliveryBatch';
export const DELIVERY_BATCH_PATH = '/api/v1/MarketingAutomation/action/delivery/run-scheduled-batch';

/** MA.13 — advance due journey wait/condition/action steps with recovery for stale claims. */
export const JOURNEY_RUN_BATCH_JOB = 'marketing.journeyRunBatch';
export const JOURNEY_RUN_BATCH_PATH = '/api/v1/MarketingAutomation/action/journey/run-batch';

export interface MarketingJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

async function callWorkerOperation(
  deps: MarketingJobDeps,
  context: JobContext,
  operation: { readonly path: string; readonly label: string; readonly body: Record<string, unknown> },
): Promise<{ disabled: true } | { disabled: false; payload: Record<string, unknown> }> {
  if (deps.secret.trim() === '') return { disabled: true };
  if (await context.shouldStop()) return { disabled: true };
  context.progress(20, operation.label);
  const fetcher = deps.fetcher ?? fetch;
  const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}${operation.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': deps.secret },
    body: JSON.stringify(operation.body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`${operation.label} failed with HTTP ${String(response.status)}.`);
  }
  return { disabled: false, payload: (await response.json()) as Record<string, unknown> };
}

function deliveryBatchJob(deps: MarketingJobDeps): JobHandler {
  return async (context: JobContext) => {
    const data = (context.data ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    if (typeof data['sendId'] === 'string' && data['sendId'] !== '') body['sendId'] = data['sendId'];
    if (typeof data['slot'] === 'number' && Number.isInteger(data['slot'])) body['slot'] = data['slot'];
    const called = await callWorkerOperation(deps, context, {
      path: DELIVERY_BATCH_PATH,
      label: 'delivering marketing batch',
      body,
    });
    if (called.disabled) {
      return { status: 'completed', message: 'Marketing delivery is disabled: no worker capability is configured.', result: { disabled: true } };
    }
    const totals = called.payload['totals'] as Record<string, unknown> | undefined;
    const sent = typeof totals?.['sent'] === 'number' ? totals['sent'] : 0;
    const claimed = typeof totals?.['claimed'] === 'number' ? totals['claimed'] : 0;
    context.progress(100, `claimed ${String(claimed)}, sent ${String(sent)}`);
    deps.log.info({ job: DELIVERY_BATCH_JOB, claimed, sent }, 'marketing delivery batch finished');
    return { status: 'completed', message: `Claimed ${String(claimed)} recipient(s); ${String(sent)} sent`, result: { claimed, sent } };
  };
}

function journeyRunBatchJob(deps: MarketingJobDeps): JobHandler {
  return async (context: JobContext) => {
    const data = (context.data ?? {}) as Record<string, unknown>;
    const called = await callWorkerOperation(deps, context, {
      path: JOURNEY_RUN_BATCH_PATH,
      label: 'advancing due journey steps',
      body: typeof data['limit'] === 'number' ? { limit: data['limit'] } : {},
    });
    if (called.disabled) {
      return { status: 'completed', message: 'Journey step scan is disabled: no worker capability is configured.', result: { disabled: true } };
    }
    const ran = typeof called.payload['ran'] === 'number' ? called.payload['ran'] : 0;
    context.progress(100, `ran ${String(ran)} step(s)`);
    deps.log.info({ job: JOURNEY_RUN_BATCH_JOB, ran }, 'marketing journey step scan finished');
    return { status: 'completed', message: `Ran ${String(ran)} due journey step(s)`, result: { ran } };
  };
}

export function registerMarketingJobs(registry: JobRegistry, deps: MarketingJobDeps): void {
  registry.register(DELIVERY_BATCH_JOB, deliveryBatchJob(deps));
  registry.register(JOURNEY_RUN_BATCH_JOB, journeyRunBatchJob(deps));
}
