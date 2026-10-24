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
