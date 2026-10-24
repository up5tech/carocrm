import { createHash, randomUUID } from 'node:crypto';

import { AppError, DuplicateRecordError, NotFoundError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import type { JobView } from '../jobs/job.views.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { ScoreWriteView } from './lead-score-calculation.service.js';
import { LeadScoreCalculationService } from './lead-score-calculation.service.js';
import { MAX_EVALUATED_RULES, requiredInputFields } from './lead-score-evaluator.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { runAsLeadScoreInternal } from './lead-score-internal.js';
import { LeadScoreModelService, toModelAttributes, toRuleAttributes } from './lead-score-model.service.js';
import { LeadScoreRecords } from './lead-score-records.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';
import type { ModelAttributes } from './lead-score-validator.js';

/**
 * Phase 19-LS.6 — deciding *when* to score, in the background
 * (`PLAN_Phase_19_LeadScore.md` §4.2, §9.3–§9.4, §10.2, §11.1, §16 `19-LS.6`; audit §5.4, §11).
 *
 * LS.5 could score a Lead only when somebody asked for that one Lead. This phase adds the two things plan
 * §16 asks for — a subscription to committed Lead changes, and a bounded rebuild over a set — and both are
 * built from machinery the platform already has: a committed `entity.updated` outbox row, one `jobs` row per
 * unit of work, and the worker calling back into an API route under the documented service authority
 * (`lead-score-authority.ts`). No queue, scheduler or retry policy is invented here.
 *
 * Four properties carry the phase's acceptance — *"repeat events do not create duplicate history or unbounded
 * jobs; list reads remain performant"* — and each is enforced somewhere a test can reach:
 *
 * 1. **Nothing is scored inside a read.** No code in this file runs during a list or detail request; the
 *    projection LS.5 writes is what a list column reads. That is plan §4.2's cost rule, and it is why the
 *    trigger has to be an event and a job rather than a computed-on-read field.
 * 2. **The change has to be able to change the score.** A job is queued only when the committed `changed`
 *    list touches a field the active model actually reads (`requiredInputFields`). That single test is also
 *    the loop break: LS.3 refuses scoring outputs and protected names as rule inputs, so a projection write
 *    — whose `changed` list is `scoreValue`, `scoreBand`, … — can never re-trigger a recalculation of itself
 *    (plan §10.4). No marker, no in-process flag, nothing to forget on a new code path.
 * 3. **One unit of work per Lead per model version, while it is still outstanding.** The row id is a digest
 *    of the Lead, the version and the revision that triggered it, and a `pending`/`active` job already
 *    waiting for the same Lead+version is not duplicated; a clash on insert is treated as "already queued",
 *    not as a failure. Delivery is at-least-once by design, so idempotency has to live in the data, which is
 *    exactly where LS.5 put it (`inputsHash`): a recalculation of unchanged data writes no history row and
 *    does not move the Lead.
 * 4. **A rebuild is chunked, counted and stoppable.** One job row evaluates at most `MAX_BATCH_CHUNK` Leads
 *    and enqueues its own continuation with the cursor it reached, so no HTTP call or worker slot is held by
 *    "every Lead in the database", cancellation stops the chain (the next row is never created), and a
 *    failure of one Lead is counted with a code rather than ending the run (plan §10.2).
 */

/** Job names, registered in `apps/worker/src/handlers/lead-score-handlers.ts`. */
export const LEADSCORE_JOB_NAMES = {
  recalculateLead: 'leadScore.recalculateLead',
  batchRecalculate: 'leadScore.batchRecalculate',
} as const;

/** Leads one batch chunk evaluates, and therefore one worker→API call holds. */
export const MAX_BATCH_CHUNK = 50;
/** Ceiling on one requested rebuild, whatever the caller asks for (plan §9.4). */
export const MAX_BATCH_TOTAL = 2_000;

/** Why a Lead change did or did not produce work. Stable, so a test and a log line can agree. */
export type RecalculationDecision =
  | 'queued'
  | 'alreadyQueued'
  | 'inputsUnaffected'
  | 'leadGone'
  | 'noActiveModel'
  | 'disabled';

export interface RecalculationEnqueueView {
  readonly queued: boolean;
  readonly reason: RecalculationDecision;
  readonly jobId: string | null;
  readonly modelVersion: number | null;
  readonly debounceMs: number;
}

export interface BatchChunkView {
  readonly runId: string;
  readonly processed: number;
  readonly scored: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly errorCodes: readonly string[];
  readonly cursor: string | null;
  readonly done: boolean;
  /** `done` because somebody cancelled the run, not because the Leads ran out. */
  readonly cancelled: boolean;
  readonly remaining: number;
  readonly nextJobId: string | null;
  /** Leads this run has now walked past, including this chunk. */
  readonly processedTotal: number;
}

/**
 * One condition of a rebuild filter — the platform's own list-DSL shape, carried unchanged into
 * `EntityCrudService.list`, which is where a field name or operator is actually validated against metadata.
 */
export interface BatchFilterCondition {
  readonly field: string;
  readonly operator: string;
  readonly value?: unknown;
}

export interface BatchStartView {
  readonly job: JobView;
  readonly runId: string;
  readonly limit: number;
  readonly chunkSize: number;
}

@Injectable()
export class LeadScoreRecalculationService {
  constructor(
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(LeadScoreRecords) private readonly store: LeadScoreRecords,
    @Inject(LeadScoreModelService) private readonly models: LeadScoreModelService,
    @Inject(LeadScoreCalculationService) private readonly calculation: LeadScoreCalculationService,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * A committed Lead change arrived (outbox → worker → this route). Decide, then queue at most one job.
   *
   * This never throws for a configuration or switch reason: an outbox subscriber that fails makes the poller
   * retry the whole event, so "scoring is off" or "no model is active" has to be an **answer** that lets the
   * event be marked processed. A Lead that does not exist any more is the same kind of answer, not an error.
   */
  async handleLeadChanged(input: { leadId: string; revision: number; changed: readonly string[] }): Promise<RecalculationEnqueueView> {
    const view = await this.settings.read();
    if (view.settings.enabled !== true || view.effective.eventRecalculation !== true) {
      return { queued: false, reason: 'disabled', jobId: null, modelVersion: null, debounceMs: 0 };
    }

    const active = await this.activeModel();
    if (active === undefined) {
      return { queued: false, reason: 'noActiveModel', jobId: null, modelVersion: null, debounceMs: 0 };
    }

    const inputs = active.inputFields.filter((field) => input.changed.includes(field));
    if (inputs.length === 0) {
      return { queued: false, reason: 'inputsUnaffected', jobId: null, modelVersion: active.model.modelVersion, debounceMs: 0 };
    }

    const debounceMs = view.settings.scoring.debounceSeconds * 1_000;
    // A Lead deleted after the commit has nothing to score and no projection to mark, and a job for it would
    // fail exactly the way a hand-off for a vanished record should not: loudly, and then again on retry.
    if (await this.isGone(input.leadId)) {
      return { queued: false, reason: 'leadGone', jobId: null, modelVersion: active.model.modelVersion, debounceMs };
    }
    const outstanding = await this.outstandingJob(input.leadId, active.model.modelVersion);
    if (outstanding !== undefined) {
      return { queued: false, reason: 'alreadyQueued', jobId: outstanding, modelVersion: active.model.modelVersion, debounceMs };
    }

    const id = digest(`${LEADSCORE_JOB_NAMES.recalculateLead}|${input.leadId}|${active.model.modelVersion}|${input.revision}`);
    try {
      const job = await this.jobs.enqueue({
        job: LEADSCORE_JOB_NAMES.recalculateLead,
        id,
        delayMs: debounceMs,
        data: {
          leadId: input.leadId,
          modelVersion: active.model.modelVersion,
          revision: input.revision,
          // Which inputs the change touched: safe metadata (field names), and enough for an operator to see
          // why a job exists at all. No Lead values — a job payload is readable in the admin jobs screen.
          triggers: inputs,
          source: 'event',
        },
      });
      await this.markPending(input.leadId);
      return { queued: true, reason: 'queued', jobId: job.id, modelVersion: active.model.modelVersion, debounceMs };
    } catch (error) {
      // Another trigger won the race for this Lead+version+revision. Same work, same row: the caller that
      // lost gets the id, and the event is still answered rather than retried forever.
      if (error instanceof DuplicateRecordError) {
        return { queued: false, reason: 'alreadyQueued', jobId: id, modelVersion: active.model.modelVersion, debounceMs };
      }
      throw error;
    }
  }

  /**
   * Recalculate one Lead from a job, under the **event** switch rather than the interactive one.
   *
   * The gate still applies on the job path: an operator who turns event-driven recalculation off has to stop
   * the work already queued, not only the work that would be queued next (plan §9.3). Naming the operation
   * `eventRecalculate` is what makes that true, and it is why the job's answer differs from the button's.
   *
   * The stored trigger is `lead_change`, not `manual_recalculate`: this row can only ever be created by a
   * committed Lead change, and history that says "someone pressed recalculate" about an edit the user made
   * themselves is a provenance lie (plan §5.4). The calculation service asserts the gate, so the check
   * happens once, on the way to the write it governs.
   */
  async recalculateQueued(leadId: string): Promise<ScoreWriteView> {
    return this.calculation.recalculate(leadId, { operation: 'eventRecalculate', trigger: 'lead_change' });
  }

  /**
   * Queue a bounded rebuild of the Leads a validated filter names (plan §8.2 `recalculate-batch`).
   *
   * The filter is the platform's own query DSL — `EntityCrudService` validates fields and operators against
   * metadata — and it is carried inside the job payload, so an operator watching `/admin/jobs` can see what a
   * run was selecting. Only the chunk size is chosen here, and a caller can lower it, never raise it.
   */
  async startBatch(input: { limit?: number; chunkSize?: number; where?: readonly BatchFilterCondition[] }): Promise<BatchStartView> {
    await this.gate.assertOperation('batchRecalculate');
    const active = await this.activeModel();
    if (active === undefined) {
      throw new ValidationError('No published Lead Score model is active, so there is nothing to rebuild.', { state: 'noActiveModel' });
    }

    const limit = Math.max(1, Math.min(input.limit ?? MAX_BATCH_TOTAL, MAX_BATCH_TOTAL));
    const chunkSize = Math.max(1, Math.min(input.chunkSize ?? MAX_BATCH_CHUNK, MAX_BATCH_CHUNK, limit));
    const runId = randomUUID();
    const job = await this.jobs.enqueue({
      job: LEADSCORE_JOB_NAMES.batchRecalculate,
      data: {
        runId,
        limit,
        chunkSize,
        processed: 0,
        cursor: null,
        where: input.where ?? [],
        modelVersion: active.model.modelVersion,
        requestedBy: this.scope.userId ?? null,
        source: 'manual_batch',
      },
    });
    return { job, runId, limit, chunkSize };
  }

  /**
   * Evaluate one chunk of a rebuild and queue the next one.
   *
   * The cursor is the last Lead id the chunk saw, ordered by `id`, which is stable under concurrent edits in
   * a way an `offset` is not: a row that stops matching the filter mid-run cannot make the next chunk skip a
   * Lead. A failed Lead is counted with a stable code and the run continues, because one bad record must not
   * turn a rebuild into a partial failure nobody can see the shape of (plan §10.2).
   *
   * Re-running a chunk is harmless by construction: LS.5 stores no duplicate evaluation for unchanged
   * inputs and leaves a matching projection alone, so a retry after a crash re-scans and writes nothing for
   * the Leads that already finished. That is what "idempotent" has to mean here — the same reason Customer
   * Success resumes by re-selecting rather than by trusting a cursor of completed work.
   *
   * **Cancellation is per chunk, and the view says so.** An admin cancel marks a `jobs` row
   * (`JobsService.cancel`), so this checks the run's rows before it lists Leads and again before it hands
   * the cursor on; a cancelled run stops at the next chunk boundary and never forks a successor. What it
   * cannot promise is a stop between two Leads: the worker's own `context.shouldStop()` is per attempt, and a
   * chunk deliberately holds ≤ `MAX_BATCH_CHUNK` records, so the worst case after a cancel is one chunk of
   * work that LS.5 makes a no-op anyway.
   */
  async runBatchChunk(input: {
    runId: string;
    limit: number;
    chunkSize: number;
    processed: number;
    cursor: string | null;
    where: readonly BatchFilterCondition[];
  }): Promise<BatchChunkView> {
    if (await this.runCancelled(input.runId)) {
      return this.chunkView(input, { cancelled: true, done: true });
    }
    const remainingBudget = input.limit - input.processed;
    if (remainingBudget <= 0) {
      return this.chunkView(input, { done: true });
    }
    const chunk = Math.max(1, Math.min(input.chunkSize, remainingBudget));

    const listed = await this.records.list('Lead', {
      where: [
        ...input.where,
        ...(input.cursor === null ? [] : [{ field: 'id', operator: 'gt', value: input.cursor }]),
      ],
      orderBy: 'id',
      order: 'asc',
      maxSize: chunk,
      total: false,
    });

    let scored = 0;
    let unchanged = 0;
    let failed = 0;
    const codes = new Set<string>();
    for (const row of listed.list) {
      const leadId = String(row['id'] ?? '');
      if (leadId === '') continue;
      try {
        const result = await this.calculation.recalculate(leadId, { operation: 'batchRecalculate', trigger: 'batch_rebuild' });
        if (result.recorded) scored += 1;
        else unchanged += 1;
      } catch (error) {
        failed += 1;
        codes.add(codeOf(error));
      }
    }

    const lastId = listed.list.length > 0 ? String(listed.list[listed.list.length - 1]?.['id'] ?? input.cursor) : input.cursor;
    const processed = input.processed + listed.list.length;
    const exhausted = listed.list.length < chunk;
    const reachedLimit = processed >= input.limit;
    const cancelled = exhausted || reachedLimit ? false : await this.runCancelled(input.runId);
    const done = exhausted || reachedLimit || cancelled;

    let nextJobId: string | null = null;
    if (!done) {
      nextJobId = await this.enqueueContinuation({
        runId: input.runId,
        limit: input.limit,
        chunkSize: input.chunkSize,
        processed,
        cursor: lastId,
        where: input.where,
      });
    }

    return this.chunkView(
      { ...input, processed, cursor: lastId },
      { processedThisChunk: listed.list.length, scored, unchanged, failed, errorCodes: [...codes].sort(), done, cancelled, nextJobId },
    );
  }

  /**
   * The one shape a chunk answer takes, so the counts, the cursor and the budget cannot be reported
   * inconsistently by the four places that return early.
   */
  private chunkView(
    input: { runId: string; limit: number; processed: number; cursor: string | null },
    outcome: {
      processedThisChunk?: number;
      scored?: number;
      unchanged?: number;
      failed?: number;
      errorCodes?: readonly string[];
      done: boolean;
      cancelled?: boolean;
      nextJobId?: string | null;
    },
  ): BatchChunkView {
    const processedThisChunk = outcome.processedThisChunk ?? 0;
    return {
      runId: input.runId,
      processed: processedThisChunk,
      scored: outcome.scored ?? 0,
      unchanged: outcome.unchanged ?? 0,
      failed: outcome.failed ?? 0,
      errorCodes: outcome.errorCodes ?? [],
      cursor: input.cursor,
      done: outcome.done,
      cancelled: outcome.cancelled ?? false,
      remaining: Math.max(0, input.limit - input.processed),
      nextJobId: outcome.nextJobId ?? null,
      processedTotal: input.processed,
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Mark the projection as waiting, so a reader is shown "pending" rather than a stale number presented as
   * current. Only the status moves: the value stays until the engine replaces it (plan §5.3).
   *
   * A Lead that vanished between the event and this write is skipped in silence — there is nothing left to
   * describe — and a Lead already marked pending is not rewritten, so a burst of events cannot churn rows.
   */
  private async markPending(leadId: string): Promise<void> {
    try {
      await runAsLeadScoreInternal(async () => {
        const lead = await this.records.get('Lead', leadId);
        // Already waiting: the reader is told the truth already, and rewriting the row would bump the
        // Lead's version for a marker nothing changed behind.
        if (lead['scoreStatus'] === 'pending') return null;
        return this.records.update('Lead', leadId, { scoreStatus: 'pending' });
      });
    } catch (error) {
      // The Lead went away between the event and this write; the job will find nothing and the score is
      // moot. That is a normal outcome for an asynchronous marker, not a failed hand-off.
      if (isMissingRecordError(error)) return;
      throw error;
    }
  }

  /** The active published model, with the fields it reads. `undefined` when nothing is usable. */
  private async activeModel(): Promise<{ model: ModelAttributes; inputFields: string[] } | undefined> {
    const activeId = (await this.settings.settings()).scoring.activeModelId;
    if (activeId === null || activeId === undefined) return undefined;
    const row = await this.store.modelById(activeId);
    if (row === undefined || row.data['status'] !== 'published') return undefined;
    const model = toModelAttributes(row.id, row.data);
    const rules = (await this.store.rulesOfModel(row.id, MAX_EVALUATED_RULES + 1)).map((entry) => toRuleAttributes(row.id, entry.data));
    return { model, inputFields: requiredInputFields(model, rules, this.models.scoredFields()) };
  }

  /** Whether this Lead can no longer be read — deleted, or deleted and then hard-purged. */
  private async isGone(leadId: string): Promise<boolean> {
    try {
      await this.records.get('Lead', leadId);
      return false;
    } catch (error) {
      if (isMissingRecordError(error)) return true;
      throw error;
    }
  }

  /**
   * Whether somebody cancelled this rebuild through `/admin/jobs`.
   *
   * The run is the thing an operator cancels, not the chunk, so the check spans every row carrying the same
   * `runId` — cancelling the chunk that is running *or* a successor that has not started yet both stop the
   * chain at its next boundary. It is two indexed-enough lookups per chunk rather than one per Lead: the
   * `jobs` table is small and bounded, and a per-Lead scan of a JSON key would trade a real cost for a
   * cancellation latency nobody can perceive inside a 50-record chunk.
   */
  private async runCancelled(runId: string): Promise<boolean> {
    const row = await this.database.db
      .selectFrom('jobs')
      .select('id')
      .where('job', '=', LEADSCORE_JOB_NAMES.batchRecalculate)
      .where(sql`target ->> 'runId'`, '=', runId)
      .where((eb) => eb.or([eb('cancel_requested', '=', true), eb('status', '=', 'cancelled')]))
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** A job for this Lead and model version that has not finished yet. */
  private async outstandingJob(leadId: string, modelVersion: number): Promise<string | undefined> {
    const rows = await this.database.db
      .selectFrom('jobs')
      .select('id')
      .where('job', '=', LEADSCORE_JOB_NAMES.recalculateLead)
      .where('status', 'in', ['pending', 'active'])
      .where(sql`target ->> 'leadId'`, '=', leadId)
      .where(sql`target ->> 'modelVersion'`, '=', String(modelVersion))
      .limit(1)
      .execute();
    return rows[0]?.id;
  }

  /**
   * The next chunk's job row, with an id that makes a repeated hand-off collapse: two workers finishing the
   * same chunk cannot fork the run into two chains.
   */
  private async enqueueContinuation(input: { runId: string; limit: number; chunkSize: number; processed: number; cursor: string | null; where: readonly BatchFilterCondition[] }): Promise<string> {
    const id = digest(`${LEADSCORE_JOB_NAMES.batchRecalculate}|${input.runId}|${input.cursor ?? 'start'}`);
    try {
      const job = await this.jobs.enqueue({
        job: LEADSCORE_JOB_NAMES.batchRecalculate,
        id,
        data: {
          runId: input.runId,
          limit: input.limit,
          chunkSize: input.chunkSize,
          processed: input.processed,
          cursor: input.cursor,
          where: input.where,
          source: 'manual_batch',
        },
      });
      return job.id;
    } catch (error) {
      if (error instanceof DuplicateRecordError) return id;
      throw error;
    }
  }
}

/** 64 hex characters: the shape `JobsService` accepts as a deterministic job id, and enough to be one. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Whether an error means "this record is not there to read".
 *
 * The entity layer raises `RecordNotFoundError` and the ACL layer raises `NotFoundError` for the same fact,
 * and a background hand-off has to treat both as the ordinary race it is: the Lead went away, so there is
 * nothing to score and nothing to mark. Anything else is a real failure and must still throw.
 */
function isMissingRecordError(error: unknown): boolean {
  return error instanceof RecordNotFoundError || error instanceof NotFoundError;
}

/**
 * A safe code for a failed Lead. Plan §10.2 asks that a job failure be recorded with diagnostic context, and
 * AGENTS.md §5.3 forbids putting a payload, a query or a stack into a row an operator reads — so the code is
 * what is kept, never the message.
 *
 * Every platform error already names itself with a stable code (`AppError.code`, plan §8.4), which is why a
 * Lead that was deleted mid-run, a field this caller may not read, and a model that stopped being
 * publishable are three different answers here rather than three `INTERNAL_ERROR`s.
 */
function codeOf(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_ERROR';
}
