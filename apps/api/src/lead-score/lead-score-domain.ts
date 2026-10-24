/**
 * Phase 19-LS.1 — the module's stable identifiers
 * (`PLAN_Phase_19_LeadScore.md` §4.1, §16 `19-LS.1`; audit `docs/implementation/lead-score-audit.md` §2, §9).
 *
 * Nothing in this file computes a score or converts a lead. These are the names the rest of the
 * module — and the platform's ACL, settings, job and event registries — address `LeadScore` by, so
 * they live in one place: a renamed settings row or permission resource is a silent authorization
 * and configuration break, not a compile error.
 *
 * Naming rule (plan §0.1-1): no `Ua` prefix anywhere. Module id `LeadScore`, settings row `leadScore`,
 * API prefix `/api/v1/LeadScore`, job/event namespace `leadScore`.
 */

/** The module's own row in `app_settings` — one validated, versioned document (AGENTS.md §5, audit §1). */
export const LEADSCORE_SETTINGS_ROW = 'leadScore';

/** The key the navigation gate and the module descriptor use for this module. */
export const LEADSCORE_MODULE_KEY = 'leadScore';

/** The generic job/event namespace: `leadScore.<action>` matches `JOB_NAME` and `EVENT_TYPE`. */
export const LEADSCORE_EVENT_NAMESPACE = 'leadScore';

/**
 * Synthetic ACL resources for the module's own rights.
 *
 * `LeadScore` owns no metadata entity until 19-LS.2, so a right that is not an entity permission is
 * evaluated as a permission on a named synthetic resource — the pattern `AIAgents`, `ESignature` and
 * `CRMChat` already use, and it keeps one authorization engine (AGENTS.md §5.3). `AclApiService` reads
 * `roles.permissions[<resource>][<action>]`, so a role grants these exactly like an entity.
 */
export const LEADSCORE_VIEW_PERMISSION_ENTITY = 'LeadScore';
export const LEADSCORE_EXPLAIN_PERMISSION_ENTITY = 'LeadScoreExplain';
export const LEADSCORE_RECALCULATE_PERMISSION_ENTITY = 'LeadScoreRecalculate';
export const LEADSCORE_MODEL_PERMISSION_ENTITY = 'LeadScoreModel';
export const LEADSCORE_MODEL_PUBLISH_PERMISSION_ENTITY = 'LeadScoreModelPublish';
export const LEADSCORE_BATCH_PERMISSION_ENTITY = 'LeadScoreBatch';
export const LEADSCORE_SETTINGS_PERMISSION_ENTITY = 'LeadScoreSettings';
export const LEADCONVERSION_PREVIEW_PERMISSION_ENTITY = 'LeadConversionPreview';
export const LEADCONVERSION_EXECUTE_PERMISSION_ENTITY = 'LeadConversion';
export const LEADCONVERSION_OVERRIDE_PERMISSION_ENTITY = 'LeadConversionOverride';
export const LEADCONVERSION_FIELD_MERGE_PERMISSION_ENTITY = 'LeadConversionFieldMerge';
export const LEADCONVERSION_RECOVER_PERMISSION_ENTITY = 'LeadConversionRecover';

/**
 * The metadata entities 19-LS.2 registers, declared here so the module health view can report the
 * difference between *planned* and *present* instead of asserting an entity exists.
 */
export const LEADSCORE_PLANNED_ENTITY_TYPES = [
  'LeadScoreModel',
  'LeadScoreRule',
  'LeadScoreEvaluation',
  'LeadConversionOperation',
] as const;

/** The CRM entities this module extends but never owns (plan §0.1-2, §2.3). */
export const LEADSCORE_CORE_ENTITY_TYPES = ['Lead', 'Contact', 'Account', 'Opportunity'] as const;

/** The Lead lifecycle value conversion sets; it already exists in the core enum (decision D1). */
export const LEAD_CONVERTED_STATUS = 'Converted';

/** The Lead lifecycle value an explicit disqualification signal uses instead of a low score (D1). */
export const LEAD_DEAD_STATUS = 'Dead';
