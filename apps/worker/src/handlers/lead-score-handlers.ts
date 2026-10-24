import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';

import { type DomainEventBus, subscribeToMutation } from '../events/domain-event-bus.js';

/**
 * Phase 19-LS.6 — the Lead Score worker side
 * (`PLAN_Phase_19_LeadScore.md` §4.2, §9.3, §10.2, §11.1, §16 `19-LS.6`; audit §5.4).
 *
 * Three pieces, and none of them decides anything about scoring:
 *
 * - **the Lead-change subscriber** turns a committed `entity.created`/`entity.updated` outbox row into one
 *   call to the API, which answers whether that change could move a score at all. The subscriber does not
 *   read the Lead, does not know a model exists, and does not own a rule — plan §4.2 puts the decision in
 *   the domain, and this file is the transport.
 * - **`leadScore.recalculateLead`** runs the debounced job the API queued, for one Lead.
 * - **`leadScore.batchRecalculate`** runs one chunk of a rebuild and reports the counts the API produced.
 *
 * The handler deliberately does not touch the `entity_records` tables itself. Scoring writes a projection
 * onto a Lead, and only the application layer does that correctly — ACL, validation, the LS.2 write guard,
 * audit, stream and the outbox event that LS.9's notifications will one day need. So each job calls a
 * `@Public()` worker route under the shared capability and that route runs the same service an
 * administrator's button runs (`sales-handlers.ts` and `customer-success-handlers.ts` are the precedent).
 *
 * **Retries are the reason the three response classes below are separate.** The queue gives at-least-once
 * delivery, and the outbox poller retries an event whose subscriber throws:
 *
 * - a transport or server failure **throws**, so the work is retried;
 * - `401`/`403` **throws** too — an installation whose capability is wrong should show a failing job rather
 *   than a quiet success, because the score an operator expects would silently never arrive;
 * - a refusal the module *means* (`LEADSCORE_MODULE_DISABLED`, `LEADSCORE_NO_ACTIVE_MODEL`, a phase that has
 *   been switched off mid-run) and a Lead that no longer exist **complete**: retrying them cannot change the
 *   answer, and a job that fails forever over a switch is a queue full of noise.
 *
 * What makes a retry *safe* is not in this file: LS.5 keys an evaluation on the inputs it read, so a second
 * attempt at unchanged data records nothing and leaves the Lead row alone.
 */

/** Job names, matching `LEADSCORE_JOB_NAMES` in `apps/api/src/lead-score/lead-score-recalculation.service.ts`. */
export const RECALCULATE_LEAD_JOB = 'leadScore.recalculateLead';
export const BATCH_RECALCULATE_JOB = 'leadScore.batchRecalculate';

export const LEAD_CHANGED_PATH = '/api/v1/LeadScore/action/work/lead-changed';
export const RECALCULATE_PATH = '/api/v1/LeadScore/action/work/recalculate';
export const BATCH_CHUNK_PATH = '/api/v1/LeadScore/action/work/recalculate-batch-chunk';

/** One worker→API call is bounded by the chunk it belongs to, not by how many Leads the database holds. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface LeadScoreJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the work is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable, so a handler test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

interface WorkerResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly payload: Record<string, unknown>;
  /** The stable refusal code of an error envelope, when the call did not succeed. */
  readonly code: string | null;
}

/**
 * Call a Lead Score worker route.
 *
 * A non-2xx still returns rather than throwing, because the caller has to tell "the module refused, on
 * purpose" from "the network broke" — and only the second one deserves a retry. `code` is read out of the
 * platform's error envelope for exactly that comparison.
 */
async function call(deps: LeadScoreJobDeps, path: string, body: Record<string, unknown>): Promise<WorkerResponse> {
  const fetcher = deps.fetcher ?? fetch;
  const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': deps.secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  // A failure page from a proxy is not JSON, and an unparseable body must not become the reason a job fails:
  // the status and the code are what the handler decides on.
  let parsed: unknown = {};
  try {
    parsed = text.trim() === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    parsed = {};
  }
  const payload = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const error = payload['error'];
  const envelope = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : payload;
  const code = typeof envelope['code'] === 'string' ? envelope['code'] : null;
  return { status: response.status, ok: response.ok, payload, code };
}

/**
 * What a response means to the queue.
 *
 * The decision is made on the module's **stable code** rather than the status number, because 403 carries two
 * very different things here: `LEADSCORE_MODULE_DISABLED` is an operator's switch and retrying it changes
 * nothing, while `AUTHORIZATION_DENIED` means the service principal itself is wrong and must be visible.
 *
 * - `retry` throws, so at-least-once delivery does what it promises;
 * - `refused` completes with the code, because the answer is final;
 * - `missing` completes for a Lead that is no longer there.
 */
type Outcome = 'ok' | 'retry' | 'refused' | 'missing';

function classify(response: WorkerResponse): Outcome {
  if (response.ok) return 'ok';
  if (response.status === 404) return 'missing';
  if (response.code !== null && response.code.startsWith('LEADSCORE_')) return 'refused';
  if (response.status >= 500 || response.status === 401 || response.status === 403) return 'retry';
  return 'refused';
}

/** The message an operator reads in `/admin/jobs` when the call did not run. */
function failureMessage(label: string, response: WorkerResponse): string {
  return `${label} failed with HTTP ${String(response.status)}${response.code === null ? '' : ` (${response.code})`}.`;
}

/**
 * A capability that is not configured makes the work inert rather than failing forever.
 *
 * An installation that has not set the shared secret cannot run background scoring — and a job that fails on
 * every attempt would bury that fact in the queue. The answer says what is missing.
 */
function inert(label: string): JobHandler {
  return async () => ({ status: 'completed', message: `${label} is disabled: no worker capability is configured.`, result: { disabled: true } });
}

/** The one Lead the job was queued for, or the shape error it was not. */
function leadIdOf(context: JobContext): string | null {
  const value = context.data?.['leadId'];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function recalculateLeadJob(deps: LeadScoreJobDeps): JobHandler {
  if (deps.secret.trim() === '') return inert('Lead Score recalculation');
  return async (context: JobContext) => {
    const leadId = leadIdOf(context);
    if (leadId === null) {
      // A payload without a Lead is a broken row, not a transient failure: failing once, visibly, is the
      // honest answer, and it cannot be retried into correctness.
      return { status: 'failed', message: 'Lead Score recalculation job has no leadId.' };
    }
    if (await context.shouldStop()) {
      return { status: 'cancelled', message: 'Cancelled before the score was recalculated.' };
    }

    context.progress(20, 'recalculating one Lead score');
    const response = await call(deps, RECALCULATE_PATH, { leadId });
    const outcome = classify(response);
    if (outcome === 'retry') throw new Error(failureMessage('Lead Score recalculation', response));
    if (outcome === 'missing') {
      context.progress(100, 'Lead no longer exists');
      return { status: 'completed', message: 'Lead no longer exists; nothing to score.', result: { leadId, missing: true } };
    }
    if (outcome === 'refused') {
      // A refusal the module means (§8.4): the switch was turned off, no model is active, the record is not
      // scoreable. Retrying cannot change any of them, and a job that fails forever hides the real answer.
      context.log(`recalculation refused: ${String(response.code ?? `HTTP ${String(response.status)}`)}`, 'warn');
      deps.log.warn({ leadId, status: response.status, code: response.code }, 'lead score recalculation refused');
      return {
        status: 'completed',
        message: `Recalculation refused: ${String(response.code ?? 'unknown reason')}`,
        result: { leadId, refused: response.code, httpStatus: response.status },
      };
    }
    if (response.code !== null) {
      // A 2xx carrying a refusal code cannot happen on this route; if it ever did, saying so beats reporting a
      // score that was never written.
      throw new Error(`Lead Score recalculation returned an unexpected refusal (${response.code}).`);
    }

    const recorded = response.payload['recorded'] === true;
    const projectionWritten = response.payload['projectionWritten'] === true;
    const evaluation = (response.payload['evaluation'] ?? {}) as Record<string, unknown>;
    context.progress(100, recorded ? 'score recorded' : 'score unchanged');
    deps.log.info({ leadId, recorded, projectionWritten }, 'lead score recalculated');
    return {
      status: 'completed',
      message: recorded ? `Recorded score ${String(evaluation['scoreValue'] ?? 'n/a')}` : 'Score unchanged; nothing recorded',
      result: {
        leadId,
        recorded,
        projectionWritten,
        scoreValue: evaluation['scoreValue'] ?? null,
        band: evaluation['band'] ?? null,
        resultState: evaluation['resultState'] ?? null,
      },
    };
  };
}

/** The chunk coordinates a batch job row must carry — validated on the worker, not discovered mid-run. */
interface ChunkPayload {
  readonly runId: string;
  readonly limit: number;
  readonly chunkSize: number;
  readonly processed: number;
  readonly cursor: string | null;
  readonly where: readonly Record<string, unknown>[];
}

function chunkPayloadOf(context: JobContext): ChunkPayload | null {
  const data = context.data;
  const runId = data?.['runId'];
  const limit = data?.['limit'];
  const chunkSize = data?.['chunkSize'];
  const processed = data?.['processed'];
  if (typeof runId !== 'string' || runId.trim() === '') return null;
  if (typeof limit !== 'number' || typeof chunkSize !== 'number' || typeof processed !== 'number') return null;
  const cursor = data?.['cursor'];
  const where = data?.['where'];
  return {
    runId,
    limit,
    chunkSize,
    processed,
    cursor: typeof cursor === 'string' ? cursor : null,
    where: Array.isArray(where) ? (where as Record<string, unknown>[]) : [],
  };
}

export function batchRecalculateJob(deps: LeadScoreJobDeps): JobHandler {
  if (deps.secret.trim() === '') return inert('Lead Score batch recalculation');
  return async (context: JobContext) => {
    const payload = chunkPayloadOf(context);
    if (payload === null) {
      return { status: 'failed', message: 'Lead Score batch job has no run coordinates.' };
    }
    if (await context.shouldStop()) {
      return { status: 'cancelled', message: 'Cancelled before the chunk ran.' };
    }

    context.progress(10, `batch chunk from cursor ${payload.cursor ?? 'start'}`);
    const response = await call(deps, BATCH_CHUNK_PATH, { ...payload });
    const outcome = classify(response);
    if (outcome === 'retry') throw new Error(failureMessage('Lead Score batch chunk', response));
    if (outcome === 'refused' || outcome === 'missing') {
      deps.log.warn({ runId: payload.runId, status: response.status, code: response.code }, 'lead score batch chunk refused');
      return {
        status: 'completed',
        message: `Batch chunk refused: ${String(response.code ?? `HTTP ${String(response.status)}`)}`,
        result: { runId: payload.runId, refused: response.code, httpStatus: response.status },
      };
    }

    const view = response.payload as Record<string, unknown>;
    const processed = numberOf(view['processed']);
    const scored = numberOf(view['scored']);
    const failed = numberOf(view['failed']);
    const cancelled = view['cancelled'] === true;
    const nextJobId = typeof view['nextJobId'] === 'string' ? view['nextJobId'] : null;
    context.progress(100, `${String(processed)} Lead(s) in this chunk`);
    deps.log.info({ runId: payload.runId, processed, scored, failed, cancelled }, 'lead score batch chunk finished');

    // The operator sees the whole shape of the run in this row's result, including which codes failed — plan
    // §10.2 asks that a failure be diagnosable without a second query, and one Lead's problem must not look
    // like a failed rebuild.
    return {
      status: cancelled ? 'cancelled' : 'completed',
      message: cancelled
        ? `Rebuild cancelled; chunk stopped after ${String(processed)} Lead(s)`
        : `${String(scored)} scored, ${String(processed - scored - failed)} unchanged, ${String(failed)} failed`,
      result: {
        runId: payload.runId,
        processed,
        scored,
        unchanged: numberOf(view['unchanged']),
        failed,
        errorCodes: Array.isArray(view['errorCodes']) ? view['errorCodes'] : [],
        cursor: view['cursor'] ?? null,
        done: view['done'] === true,
        cancelled,
        remaining: numberOf(view['remaining']),
        nextJobId,
        processedTotal: numberOf(view['processedTotal']),
      },
    };
  };
}

/** Registers both Lead Score jobs in the worker's job registry. */
export function registerLeadScoreJobs(registry: JobRegistry, deps: LeadScoreJobDeps): void {
  registry.register(RECALCULATE_LEAD_JOB, recalculateLeadJob(deps));
  registry.register(BATCH_RECALCULATE_JOB, batchRecalculateJob(deps));
}

/**
 * Subscribe the score to committed Lead changes.
 *
 * One call per mutation, and the API answers whether it means anything — so the rule that decides ("did this
 * change touch a field the active model reads?") is written once, in the domain, and an operator who changes
 * it never has to redeploy a worker. A created Lead goes through the same door, because a Lead that has never
 * been scored is the case a first score matters for.
 *
 * A transport or server failure **throws** so the poller retries the event; a refusal does not, because a
 * switch that is off would otherwise wedge the outbox behind it. The debounce and the duplicate-job collapse
 * are the API's job, which is what makes this safe under at-least-once delivery.
 */
export function registerLeadScoreDomainEvents(bus: DomainEventBus, deps: LeadScoreJobDeps): void {
  if (deps.secret.trim() === '') return;
  for (const operation of ['create', 'update'] as const) {
    subscribeToMutation({
      bus,
      name: `lead-score:lead-${operation}`,
      operation,
      entityType: 'Lead',
      handler: async (event) => {
        const entity = event.entity;
        if (entity === undefined) return;
        const response = await call(deps, LEAD_CHANGED_PATH, {
          leadId: entity.entityId,
          revision: entity.version,
          changed: entity.changed,
        });
        const outcome = classify(response);
        if (outcome === 'retry') throw new Error(failureMessage('Lead change hand-off', response));
        if (outcome !== 'ok') {
          deps.log.warn({ eventId: event.id, leadId: entity.entityId, status: response.status, code: response.code }, 'lead change hand-off refused');
          return;
        }
        const decision = typeof response.payload['reason'] === 'string' ? response.payload['reason'] : 'unknown';
        deps.log.debug({ eventId: event.id, leadId: entity.entityId, decision }, 'lead change handed to Lead Score');
      },
    });
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
