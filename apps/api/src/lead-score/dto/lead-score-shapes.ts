import { z } from 'zod';

import { MAX_HISTORY_PAGE } from '../lead-score-explanation.service.js';
import { LEADSCORE_OPERATIONS } from '../lead-score-feature-gate.service.js';
import { MAX_PREVIEW_SAMPLE } from '../lead-score-preview.service.js';

/**
 * Phase 19-LS.1 — request shapes (`PLAN_Phase_19_LeadScore.md` §8.4, §16 `19-LS.1`; AGENTS.md §5.4).
 *
 * Every shape is strict: an unknown key is rejected instead of silently ignored, so a typo in a switch
 * name cannot be stored and quietly do nothing. The controller parses shape only; policy lives in the
 * settings service and the gate.
 *
 * No shape here carries a Lead id, a record body or a credential — a score model may not become an
 * export path around Lead ACL (plan §9.2), and this module holds no secret to leak.
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
