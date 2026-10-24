import { z } from 'zod';

import { LEADSCORE_OPERATIONS } from '../lead-score-feature-gate.service.js';

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
