import { z } from 'zod';

import { MAX_HISTORY_PAGE } from '../lead-score-explanation.service.js';
import { LEADSCORE_OPERATIONS } from '../lead-score-feature-gate.service.js';
import { MAX_PREVIEW_SAMPLE } from '../lead-score-preview.service.js';
import { MAX_BATCH_CHUNK, MAX_BATCH_TOTAL } from '../lead-score-recalculation.service.js';
import { CONVERSION_TARGETS } from '../lead-score-vocabulary.js';

/**
 * Phase 19-LS.1 — request shapes (`PLAN_Phase_19_LeadScore.md` §8.4, §16 `19-LS.1`; AGENTS.md §5.4).
 *
 * Every shape is strict: an unknown key is rejected instead of silently ignored, so a typo in a switch
 * name cannot be stored and quietly do nothing. The controller parses shape only; policy lives in the
 * settings service and the gate.
 *
 * No shape here carries a record body or a credential — a score model may not become an export path
 * around Lead ACL (plan §9.2), and this module holds no secret to leak. A shape that names a Lead names
 * its **id** and nothing more.
 */

/**
 * The settings patch: an object of any shape, whose *fields* are enforced by `LeadScoreSettingsSchema`
 * in the settings service — that service, not this file, is where an unknown key is refused. Keeping
 * the permissive shape here means one validator, so the API and a stored row can never disagree about
 * what a valid switch is.
 */
export const SettingsPatchSchema = z.record(z.string(), z.unknown());

/** The operation the caller asks the gate to admit, as a probe of the module's security contract. */
export const OperationProbeSchema = z
  .object({
    operation: z.enum(LEADSCORE_OPERATIONS),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-LS.3 — the model lifecycle commands (plan §6.1, §8.1)
// ---------------------------------------------------------------------------

/**
 * A model version identifier. Shape only: the service asks the entity layer whether *this caller* may see
 * that record, so an id that exists but is not theirs answers the same way as one that does not.
 */
const ModelIdSchema = z.string().trim().min(1).max(64);

/** A Lead id named in a preview request. Shape only; the record ACL decides whether the caller may score it. */
const LeadIdSchema = z.string().trim().min(1).max(64);

/**
 * The stored record's concurrency token, sent back by an editor that loaded the model first.
 *
 * Publishing or archiving without it is allowed but risky in two hands at once, so the editor sends what
 * it read (plan §5.1 immutability, §7.8 concurrency). A mismatch is refused with a concurrency conflict
 * rather than overwriting the version someone else just froze.
 */
const ExpectedVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * The editor catalog request: optionally the model whose allowlist should annotate the answer.
 *
 * A model id here changes only what is *labelled* as granted; the built-in denylists and the type matrix are
 * the same either way, so an unknown id cannot widen what a rule may read (and the record read of that id is
 * ACL-gated, so a model the caller may not see answers `RECORD_NOT_FOUND`).
 */
export const EditorCatalogQuerySchema = z
  .object({
    modelId: ModelIdSchema.optional(),
  })
  .strict();

export const ModelValidateSchema = z
  .object({
    modelId: ModelIdSchema,
  })
  .strict();

export const ModelPublishSchema = z
  .object({
    modelId: ModelIdSchema,
    expectedVersion: ExpectedVersionSchema.optional(),
  })
  .strict();

/** Archiving takes the same two fields: which version, and the revision the editor last read. */
export const ModelArchiveSchema = ModelPublishSchema;

export const ModelNewVersionSchema = z
  .object({
    modelId: ModelIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-LS.4 — the model preview (plan §6.1, §8.1, §9.4, §15.2 stage 3)
// ---------------------------------------------------------------------------

/**
 * A preview scores Leads and writes nothing, so its shape carries no score, no band and no setting: only
 * which model and which Leads.
 *
 * `leadIds` is bounded here rather than trusted from an editor, because plan §9.4 asks that a preview never
 * become a way to make the server evaluate the Lead table, and `maxSize` can only narrow the bound — a
 * caller cannot raise it above `MAX_PREVIEW_SAMPLE` by asking.
 */
export const ModelPreviewSchema = z
  .object({
    modelId: ModelIdSchema,
    leadIds: z.array(LeadIdSchema).min(1).max(MAX_PREVIEW_SAMPLE).optional(),
    maxSize: z.number().int().min(1).max(MAX_PREVIEW_SAMPLE).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-LS.5 — scoring one Lead, and reading its score back (plan §8.2)
// ---------------------------------------------------------------------------

/**
 * Recalculating one Lead is the write half of 19-LS.5: it stores an evaluation and moves the projection, so
 * it names one record and no filters. A batch rebuild is 19-LS.6's bounded job with its own validated
 * filter DSL (plan §8.2), and letting a single-Lead command grow into a loop here would be that job arriving
 * without checkpoints, progress or a rate story.
 */
export const ScoreRecalculateSchema = z
  .object({
    leadId: LeadIdSchema,
  })
  .strict();

export const ScoreReadSchema = z
  .object({
    leadId: LeadIdSchema,
  })
  .strict();

/**
 * The history page. Both bounds are enforced here and the service applies the same ceilings again — a paging
 * contract the client alone polices is a way to ask for a Lead's whole evaluation history in one response
 * (plan §8.2).
 */
export const ScoreHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_HISTORY_PAGE).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-LS.6 — event-driven and manual recalculation (plan §8.2, §9.3, §10.2, §11.1)
// ---------------------------------------------------------------------------

/**
 * One condition of a rebuild filter.
 *
 * Shape only, on purpose: a field name and an operator are validated by the query engine against Lead
 * metadata when the chunk runs (`packages/query-engine/src/index.ts:220,319`), which is also where a field
 * this caller may not filter on is refused. What this file bounds is the *size* of the request — an
 * unbounded condition list is a way to build an enormous query through a scoring endpoint.
 * `value` is optional because the engine's no-value operators (`isEmpty`, `isClosed`, …) need none.
 */
const BatchFilterConditionSchema = z
  .object({
    field: z.string().trim().min(1).max(64),
    operator: z.string().trim().min(1).max(32),
    value: z.unknown(),
  })
  .strict();

/** Conditions one rebuild may name — enough for a real segment, far below a query that needs its own review. */
const MAX_BATCH_FILTERS = 8;

/**
 * A manual rebuild: how many Leads at most, how many per job, and which ones.
 *
 * `limit` and `chunkSize` can only be *lowered* by the caller — the ceilings are the service's constants, so
 * a request cannot raise the amount of work one worker→API call holds (plan §9.4).
 */
export const BatchRecalculateSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_BATCH_TOTAL).optional(),
    chunkSize: z.number().int().min(1).max(MAX_BATCH_CHUNK).optional(),
    where: z.array(BatchFilterConditionSchema).max(MAX_BATCH_FILTERS).optional(),
  })
  .strict();

/**
 * The model-scoped rebuild (plan §8.1 `POST /models/:modelId/recalculate`).
 *
 * The same bounds as a manual rebuild apply, because it *is* one: the only difference is the provenance —
 * the run and the evaluations it writes name `model_publish` as the trigger, so history can tell "the
 * administrator rebuilt because this version became what scores are read from" apart from an ad-hoc sweep.
 */
export const ModelRecalculateSchema = z
  .object({
    modelId: ModelIdSchema,
    limit: z.number().int().min(1).max(MAX_BATCH_TOTAL).optional(),
    chunkSize: z.number().int().min(1).max(MAX_BATCH_CHUNK).optional(),
  })
  .strict();

/**
 * The payload a batch job carries, checked again on the way in.
 *
 * A worker builds this from a stored job row, so a malformed or hand-edited row must not be able to ask for
 * more Leads than a client could have requested through `action/recalculate-batch`: the same bounds apply on
 * both doors, and the run cursor is validated as an id rather than trusted as one.
 */
export const RecalculateBatchChunkSchema = z
  .object({
    runId: z.string().trim().min(1).max(64),
    limit: z.number().int().min(1).max(MAX_BATCH_TOTAL),
    chunkSize: z.number().int().min(1).max(MAX_BATCH_CHUNK),
    processed: z.number().int().min(0).max(MAX_BATCH_TOTAL),
    cursor: z.string().trim().min(1).max(64).nullable(),
    where: z.array(BatchFilterConditionSchema).max(MAX_BATCH_FILTERS),
    /** Why the run exists; the evaluation rows a chunk writes name it (plan §5.4). Job rows without one predate it. */
    trigger: z.enum(['batch_rebuild', 'model_publish']).default('batch_rebuild'),
    /** Who asked for the run, as the job row stated it — carried on so `/admin/jobs` stays truthful mid-run. */
    source: z.string().trim().min(1).max(32).default('manual_batch'),
  })
  .strict();

/**
 * The committed-change notification the outbox subscriber sends.
 *
 * `changed` is the event's own list of keys that moved, which is the whole input to the loop break: only a
 * change that touches a field the active model reads can produce work (plan §10.4). It is bounded so a
 * notification cannot carry a synthetic huge list, and `revision` is the Lead's version at commit time —
 * the trigger half of the deterministic job id that collapses duplicate deliveries.
 */
export const LeadChangedSchema = z
  .object({
    leadId: LeadIdSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    changed: z.array(z.string().trim().min(1).max(64)).max(512),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-LS.11 — duplicate candidate review (plan §7.3, §9.2; contract §9)
// ---------------------------------------------------------------------------

/**
 * Ask who this Lead may already be.
 *
 * One Lead per call, and the Lead is the only input: a caller cannot name a stage, a limit or a wider
 * search, because the bounds belong to the answer (contract §9.4, §12.3). A candidate list for a *set* of
 * Leads would be a searchable map of who-knows-whom across the database, and this endpoint deliberately
 * cannot be turned into one.
 */
export const ConversionCandidatesSchema = z.object({ leadId: LeadIdSchema }).strict();

/**
 * Ask what a conversion would do (19-LS.12, contract §8.1).
 *
 * Every choice is a *type plus a create-or-link decision*, and the shapes are strict for the same reason the
 * settings patch is: a misspelled `existingId` must be a refusal, not a link that silently created a record.
 * The target list is bounded by the vocabulary, the merge list is bounded by a constant, and the two
 * revision pins are optional — omitting them means "the current state", while sending one is how a client
 * asks the server to confirm the preview it is holding is still true.
 */
export const ConversionPreviewSchema = z
  .object({
    leadId: LeadIdSchema,
    targets: z
      .array(
        z
          .object({
            type: z.enum(CONVERSION_TARGETS),
            action: z.enum(['create', 'link']),
            existingId: z.string().trim().min(1).max(64).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(CONVERSION_TARGETS.length),
    fieldMerge: z
      .array(z.object({ target: z.enum(CONVERSION_TARGETS), field: z.string().trim().min(1).max(64), value: z.unknown() }).strict())
      .max(20)
      .optional(),
    expectedLeadRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    mappingVersion: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-LS.13 — the convert command and its operation record (contract §3, §4, §11.3)
// ---------------------------------------------------------------------------

const ConfirmationTypeSchema = z.enum(['simple', 'duplicates_present', 'values_will_be_skipped', 'field_merge', 'contact_reparent', 'opportunity_created']);

/**
 * Confirm and run a conversion.
 *
 * `previewHash` is required, not optional: the command re-runs the preview and refuses when the fingerprint it
 * is handed no longer matches, so a caller cannot confirm a plan the server would not produce today. The
 * acknowledgements must be exactly the set the current preview asks for — more is a lie about what was shown,
 * fewer is a warning nobody read (contract §8.4).
 */
export const ConvertSchema = z
  .object({
    leadId: LeadIdSchema,
    /** 8–128 characters, caller-generated, never derived from the Lead (contract §4.1). */
    operationKey: z.string().trim().min(8).max(128),
    targets: z
      .array(
        z
          .object({
            type: z.enum(CONVERSION_TARGETS),
            action: z.enum(['create', 'link']),
            existingId: z.string().trim().min(1).max(64).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(CONVERSION_TARGETS.length),
    fieldMerge: z
      .array(z.object({ target: z.enum(CONVERSION_TARGETS), field: z.string().trim().min(1).max(64), value: z.unknown() }).strict())
      .max(20)
      .optional(),
    previewHash: z.string().trim().regex(/^[0-9a-f]{64}$/),
    acknowledged: z.array(ConfirmationTypeSchema).max(6),
    /** Types the caller explicitly chose to create despite a duplicate warning (needs `duplicateOverride`). */
    overrideDuplicateFor: z.array(z.enum(CONVERSION_TARGETS)).max(3).optional(),
    /** The explicit decision that lets a link move a Contact to another Account (contract §6.3). */
    allowReparent: z.boolean().optional(),
  })
  .strict();

export const ConversionOperationsQuerySchema = z
  .object({
    status: z.enum(['processing', 'succeeded', 'failed_retryable', 'failed_final', 'needs_review']).optional(),
    staleAfterMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ConversionOperationIdSchema = z.object({ operationId: z.string().trim().min(1).max(64) }).strict();

export const ConversionCloseSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

/** The conversion affordance for one Lead: may this caller convert it, and is it already converted? */
export const ConversionAffordanceQuerySchema = z.object({ leadId: LeadIdSchema }).strict();

// ---------------------------------------------------------------------------
// Phase 19-LS.17 — the optional AI fit insight (plan §6.7)
// ---------------------------------------------------------------------------

/**
 * Ask for one AI explanation of a Lead's fit.
 *
 * The only inputs are the Lead and an optional caller-generated key. The evidence, the agent, the budgets
 * and the output shape are the server's — a caller cannot widen what the model sees, choose a provider or
 * ask for a second explanation of the same key. The key's bounds match the conversion command's, because
 * it is the same replay promise: 8–128 characters, never derived from the record.
 */
export const InsightRequestSchema = z
  .object({
    leadId: LeadIdSchema,
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  })
  .strict();
