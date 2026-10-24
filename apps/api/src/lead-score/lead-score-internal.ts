import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Phase 19-LS.2 — the "this write comes from a Lead Score domain service" marker, and the field lists
 * the write guard protects (`PLAN_Phase_19_LeadScore.md` §5, §7.6; audit §4, §6).
 *
 * Two different callers write the same rows: a user through the generic `/api/v1/Lead/:id` API, and a
 * Lead Score domain service through `EntityCrudService` (storing a score projection, appending an
 * evaluation, recording a conversion operation). Their rules differ — the scoring engine *must* move
 * `scoreValue`, a user must never be able to — and the only honest way to tell them apart is for the
 * domain services to say so. This mirrors `customer-success-internal.ts` and `sales-internal.ts`
 * exactly: one async-local flag, no second entity layer.
 *
 * Why a flag rather than field-level ACL: `AclApiService.assertFieldWrites` does block a `edit: 'no'`
 * field, but an administrator bypasses it (`acl-api.service.ts:172-185`) and a *role* cannot be told
 * apart from a *service*. Plan §0.1-8 and §7.6 require that a Lead reaches `Converted` only through the
 * conversion command, so the rule has to survive an admin caller too.
 */

const storage = new AsyncLocalStorage<true>();

export function runAsLeadScoreInternal<T>(work: () => Promise<T>): Promise<T> {
  return storage.run(true, work);
}

export function isLeadScoreInternalWrite(): boolean {
  return storage.getStore() === true;
}

/**
 * The metadata entities this module owns, registered in `database/seed-metadata.ts` and indexed by
 * `database/migrations/073_phase19_lead_score.sql`.
 *
 * `LeadScoreEvaluation` is append-only and `LeadConversionOperation` is command-written: neither is a
 * record anybody edits through the generic API. `LeadScoreModel` and `LeadScoreRule` are ordinary draft
 * records whose *publication* fields the 19-LS.3 service owns.
 */
export const LEADSCORE_ENTITY_TYPES = ['LeadScoreModel', 'LeadScoreRule', 'LeadScoreEvaluation', 'LeadConversionOperation'] as const;

export type LeadScoreEntityType = (typeof LEADSCORE_ENTITY_TYPES)[number];

/** Records the generic API may not write at all; they exist because a Lead Score command created them. */
export const MODULE_WRITTEN_ENTITY_TYPES: readonly LeadScoreEntityType[] = ['LeadScoreEvaluation', 'LeadConversionOperation'];

/**
 * The `Lead` attributes Lead Score computes.
 *
 * A score is the output of a versioned model evaluated against a data snapshot (plan §0.1-5), and the
 * `Converted` references are the result of a conversion command (§7.6) — in both cases the value is a
 * record of *what the system did*, not something a caller may assert. Letting a client write them would
 * also let one fabricate a conversion by naming a Contact id it can already see.
 */
export const SERVER_OWNED_LEAD_FIELDS = [
  'scoreValue',
  'scoreBand',
  'scoreStatus',
  'scoreModelId',
  'scoreModelVersion',
  'scoreCalculatedAt',
  'scoreInputsAsOf',
  'scorePreviousValue',
  'scoreCoverage',
  'scoreReasonCodes',
  'convertedAt',
  'convertedById',
  'convertedAccountId',
  'convertedContactId',
  'convertedOpportunityId',
  'conversionOperationId',
] as const;

/**
 * The `LeadScoreModel` attributes the publication lifecycle owns, delivered in 19-LS.3.
 *
 * `status` is one of them: a draft becomes `published` only by passing the validator in the publish
 * command, so a client that could write the field could publish an invalid model and freeze it as a
 * version. The four stamps name who published or archived and when, and belong to the same command.
 *
 * `modelVersion` is deliberately **not** here. A draft has to declare the version it is going to be — the
 * `(name, modelVersion)` unique index makes that identity hold — and once the row is published the whole
 * row is frozen by `MODEL_FROZEN_STATUSES`, which covers the version too.
 */
export const SERVER_OWNED_MODEL_FIELDS = ['status', 'publishedById', 'publishedAt', 'archivedById', 'archivedAt'] as const;

/** Model states a client may not write at all: the version is immutable once it exists (plan §5.1). */
export const MODEL_FROZEN_STATUSES: readonly string[] = ['published', 'archived'];

/** The state a draft is created in, and the only one a client-supplied `status` may name. */
export const MODEL_DRAFT_STATUS = 'draft';

/**
 * Keys the caller actually changed, not keys it resent.
 *
 * A record API sends the whole editable form, so "the client touched a server-owned field" is a
 * comparison against the stored row — the same reading `record-logic.service.ts:134-151` uses to refuse
 * a write to a computed field. Resending an unchanged value is not an attempt to set it.
 */
export function changedKeys(data: Readonly<Record<string, unknown>>, previous: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(data).filter((key) => !sameValue(data[key], previous[key]));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date || right instanceof Date) {
    const leftTime = left instanceof Date ? left.getTime() : Date.parse(String(left));
    const rightTime = right instanceof Date ? right.getTime() : Date.parse(String(right));
    return Number.isFinite(leftTime) && leftTime === rightTime;
  }
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
