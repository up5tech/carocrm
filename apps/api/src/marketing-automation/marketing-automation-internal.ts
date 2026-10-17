import { AsyncLocalStorage } from "node:async_hooks";

import {
  MARKETING_AUTOMATION_ENTITY_TYPES,
  type MarketingAutomationEntityType,
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
 * Fields on a `CampaignTransition` the server owns. History is written by the lifecycle command inside its
 * own transaction and is append-only: a client that could set `fromStatus` or `actorUserId` could rewrite the
 * campaign's operational story, which is the one thing §5.1's "immutable execution history" forbids.
 */
export const SERVER_OWNED_TRANSITION_FIELDS: readonly string[] = [
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
];

/**
 * Fields on a `Campaign` the server owns (§5.1, §8.4):
 *
 *  - `status` moves only through a named lifecycle command, which validates the source state, the actor's
 *    permission and the send-readiness report before writing it. A bare field write would be a way around
 *    all three, which is precisely what §8.2 forbids ("commands … rather than generic unrestricted updates
 *    of fields such as `status`").
 *  - the lifecycle stamps are derived from the command that ran, never typed in.
 *  - the validation report, its hash and its timestamp are the server's answer to "may this send"; a client
 *    that could write them could approve its own campaign.
 *  - `failureReason` names why a system transition happened, and `duplicatedFromId` records the origin of a
 *    draft copy — both are facts about an execution, not configuration.
 */
export const SERVER_OWNED_CAMPAIGN_FIELDS: readonly string[] = [
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
];

/**
 * Fields on a `TargetList` the server owns: refresh bookkeeping is produced by the resolver (MA.4) and a
 * hand-edited count or criteria fingerprint would silently corrupt every audience that reads it.
 */
export const SERVER_OWNED_TARGET_LIST_FIELDS: readonly string[] = [
  "refreshStatus",
  "lastRefreshedAt",
  "lastErrorCode",
  "resolvedCount",
  "criteriaHash",
];

/** A `TargetListEntry` is membership evidence: who added it, when, from where. Never hand-typed. */
export const SERVER_OWNED_TARGET_LIST_ENTRY_FIELDS: readonly string[] = [
  "addedById",
  "addedAt",
  "source",
  "removedAt",
  "removedById",
];
