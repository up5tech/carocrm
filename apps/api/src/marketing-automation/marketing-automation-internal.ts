import { AsyncLocalStorage } from "node:async_hooks";

import {
  CAMPAIGN_ENTITY,
  CAMPAIGN_TRANSITION_ENTITY,
  MARKETING_AUDIENCE_SNAPSHOT_ENTITY,
  MARKETING_AUTOMATION_ENTITY_TYPES,
  MARKETING_CONSENT_ENTITY,
  MARKETING_CONSENT_EVENT_ENTITY,
  MARKETING_PUBLIC_TOKEN_ENTITY,
  MARKETING_SEND_ENTITY,
  MARKETING_SEND_TRANSITION_ENTITY,
  MARKETING_SUPPRESSION_ENTITY,
  MARKETING_TEMPLATE_REVISION_ENTITY,
  type MarketingAutomationEntityType,
  TARGET_LIST_ENTITY,
  TARGET_LIST_ENTRY_ENTITY,
} from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.2/MA.3 — the "this write comes from a Marketing Automation domain service" marker and the
 * field lists the `beforeValidate` write guard protects.
 *
 * Two callers write the same records: a marketer through the generic `/api/v1/Campaign` API, and a
 * Marketing Automation service through `EntityCrudService` (running a lifecycle transition, stamping a
 * validation report, refreshing an audience count). Their rules differ — the lifecycle service *must* set
 * `status`, a user must never be able to. The only honest way to tell them apart is for the domain services
 * to say so, exactly as `sales-internal.ts`, `customer-success-internal.ts` and `service-desk-internal.ts`
 * do. One async-local flag, no second entity layer (AGENTS.md §5.1).
 */

const storage = new AsyncLocalStorage<true>();

export function runAsMarketingInternal<T>(work: () => Promise<T>): Promise<T> {
  return storage.run(true, work);
}

export function isMarketingInternalWrite(): boolean {
  return storage.getStore() === true;
}

/** The records this module owns — the domain list, never a second copy that can drift. */
export const MARKETING_AUTOMATION_OWNED_ENTITIES = MARKETING_AUTOMATION_ENTITY_TYPES;
export type MarketingAutomationOwnedEntity = MarketingAutomationEntityType;

/**
 * Fields the server owns, per record. A client write that changes any of them is refused **by name**, which
 * is what keeps the module's promises enforceable:
 *
 *  - `Campaign.status` and its lifecycle stamps move only through a command that has validated the source
 *    state, the actor and the send-readiness report. §8.2 forbids a "generic unrestricted update of fields
 *    such as `status`" in as many words.
 *  - the validation report, hash and timestamp are the server's answer to "may this send"; a client that
 *    could write them could approve its own campaign.
 *  - `TargetList` refresh bookkeeping is produced by the resolver (MA.4); a hand-edited count or criteria
 *    fingerprint would corrupt every audience that reads it.
 *  - consent timestamps and the acting identity are derived from the state transition that happened, not
 *    typed in (§5.3 invariant 9). A `confirmedAt` someone could set is a forged opt-in.
 *  - suppression provenance (`provider*`, `effectiveAt`, `lastSeenAt`) and its revocation stamps come from
 *    provider facts and from a reviewed operator decision.
 */
export const SERVER_OWNED_FIELDS_BY_ENTITY: Readonly<Record<string, readonly string[]>> = {
  [CAMPAIGN_ENTITY]: [
    "status",
    "scheduledAt",
    "startedAt",
    "pausedAt",
    "resumedAt",
    "completedAt",
    "cancelledAt",
    "archivedAt",
    "failureReason",
    "validationReport",
    "validationHash",
    "lastValidatedAt",
    "duplicatedFromId",
    "lastErrorCode",
  ],
  [TARGET_LIST_ENTITY]: [
    "refreshStatus",
    "lastRefreshedAt",
    "lastErrorCode",
    "resolvedCount",
    "criteriaHash",
  ],
  [TARGET_LIST_ENTRY_ENTITY]: ["addedById", "addedAt", "source", "removedAt", "removedById"],
  [CAMPAIGN_TRANSITION_ENTITY]: [
    "campaignId",
    "campaignCode",
    "fromStatus",
    "toStatus",
    "command",
    "actorUserId",
    "actorType",
    "occurredAt",
    "validationHash",
    "idempotencyKey",
  ],
  [MARKETING_CONSENT_ENTITY]: [
    "confirmedAt",
    "withdrawnAt",
    "actorUserId",
    "confirmedTokenId",
  ],
  [MARKETING_CONSENT_EVENT_ENTITY]: [
    "consentId",
    "emailHash",
    "channel",
    "purpose",
    "fromStatus",
    "toStatus",
    "source",
    "basis",
    "actorUserId",
    "actorType",
    "occurredAt",
    "idempotencyKey",
  ],
  [MARKETING_SUPPRESSION_ENTITY]: [
    "effectiveAt",
    "lastSeenAt",
    "provider",
    "providerEventId",
    "revokedAt",
    "revokedById",
  ],
  [MARKETING_PUBLIC_TOKEN_ENTITY]: [
    "tokenHash",
    "scope",
    "status",
    "emailHash",
    "channel",
    "purpose",
    "campaignId",
    "targetListId",
    "issuedAt",
    "expiresAt",
    "usedAt",
    "attempts",
  ],
  [MARKETING_AUDIENCE_SNAPSHOT_ENTITY]: [
    "campaignId",
    "sendId",
    "mode",
    "status",
    "includeTargetListId",
    "excludeTargetListId",
    "compositionHash",
    "resolvedCount",
    "eligibleCount",
    "entryCount",
    "categories",
    "purpose",
    "generatedById",
    "generatedAt",
    "invalidatedAt",
    "previousSnapshotId",
  ],
  [MARKETING_TEMPLATE_REVISION_ENTITY]: [
    // §6.2: a revision is what a send is traced to, so its identity and content are the server's record
    // of the template as it stood at sealing time — a client that could write them could forge provenance.
    "templateId",
    "revisionNumber",
    "contentHash",
    "subject",
    "body",
    "bodyHtml",
    "campaignId",
    "sealedById",
    "sealedAt",
  ],
  [MARKETING_SEND_ENTITY]: [
    // A send definition *is* the decision (§5.5): status, the snapshot and content it was validated
    // against, the hash an approval is bound to, the counts derived from the ledger, and every lifecycle
    // stamp. A client that could write any of them could authorise its own send without a validation or an
    // approval — the record API refuses the whole entity anyway (see `INTERNAL_ONLY_ENTITIES`), and this list
    // is what makes the refusal explainable field by field.
    "campaignId",
    "slot",
    "status",
    "purpose",
    "templateId",
    "templateRevisionId",
    "contentHash",
    "snapshotId",
    "compositionHash",
    "senderAccountId",
    "providerKey",
    "recipientCount",
    "eligibleCount",
    "blockedCount",
    "skippedCount",
    "sentCount",
    "failedCount",
    "validationHash",
    "validationReport",
    "lastValidatedAt",
    "validatedById",
    "validationCount",
    "approvedById",
    "approvedAt",
    "approvalHash",
    "approvalNote",
    "scheduledAt",
    "queuedAt",
    "pausedAt",
    "startedSendingAt",
    "sentAt",
    "completedAt",
    "cancelledAt",
    "cancelReason",
    "failedAt",
    "failureReason",
    "lastErrorCode",
    "lastErrorAt",
  ],
  [MARKETING_SEND_TRANSITION_ENTITY]: [
    "sendId",
    "campaignId",
    "snapshotId",
    "fromStatus",
    "toStatus",
    "command",
    "reason",
    "actorUserId",
    "actorType",
    "validationHash",
    "approvalHash",
    "occurredAt",
    "idempotencyKey",
  ],
};

/**
 * Records that exist only because the module wrote them: campaign history, audience membership, consent
 * history, public tokens and snapshots. A client-authored row would be a fabricated audit trail —
 * `TargetListEntry` is evidence of who put a record in an audience, and `MarketingPublicToken` is a
 * credential. They are written by commands, and MA.4/MA.5 expose those commands as endpoints.
 */
export const INTERNAL_ONLY_ENTITIES: readonly MarketingAutomationEntityType[] = [
  TARGET_LIST_ENTRY_ENTITY,
  CAMPAIGN_TRANSITION_ENTITY,
  MARKETING_CONSENT_EVENT_ENTITY,
  MARKETING_PUBLIC_TOKEN_ENTITY,
  MARKETING_AUDIENCE_SNAPSHOT_ENTITY,
  MARKETING_TEMPLATE_REVISION_ENTITY,
  // A send definition and its history are authored by the send state machine, which is where the dry run,
  // the snapshot, the approval and the transition checks live (§5.5). A client-created send would be a
  // campaign send somebody authorised by hand.
  MARKETING_SEND_ENTITY,
  MARKETING_SEND_TRANSITION_ENTITY,
];

/** The capability that must be on before a record of this kind may be written by a caller. */
export const FEATURE_BY_ENTITY: Readonly<Record<string, string>> = {
  [CAMPAIGN_ENTITY]: "campaigns",
  [CAMPAIGN_TRANSITION_ENTITY]: "campaigns",
  [TARGET_LIST_ENTITY]: "audience",
  [TARGET_LIST_ENTRY_ENTITY]: "audience",
  [MARKETING_AUDIENCE_SNAPSHOT_ENTITY]: "audience",
  [MARKETING_TEMPLATE_REVISION_ENTITY]: "templates",
  // Sending is campaign management: a send definition belongs to the campaign lifecycle, not to the
  // optional audience or template capabilities a deployment may leave off (§13).
  [MARKETING_SEND_ENTITY]: "campaigns",
  [MARKETING_SEND_TRANSITION_ENTITY]: "campaigns",
};
