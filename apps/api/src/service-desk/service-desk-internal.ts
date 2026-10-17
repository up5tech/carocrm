import { AsyncLocalStorage } from "node:async_hooks";

import { CASE_ENTITY } from "./service-desk-domain.js";

/**
 * Phase 19-SD — the "this write comes from a Service Desk domain service" marker, and the field list
 * the `beforeValidate` write guard protects.
 *
 * Two callers write the same records: a user through the generic `/api/v1/Case` API, and a Service
 * Desk domain service through `EntityCrudService` (allocating a case number, resolving a case,
 * stamping a response timestamp in a later sub-phase). Their rules differ — the numbering service
 * *must* set `caseNumber`, a user must never be able to forge it. The only honest way to tell them
 * apart is for the domain services to say so, exactly as `sales-internal.ts` and
 * `customer-success-internal.ts` do. One async-local flag, no second entity layer (AGENTS.md §5.1).
 */

const storage = new AsyncLocalStorage<true>();

export function runAsServiceDeskInternal<T>(work: () => Promise<T>): Promise<T> {
  return storage.run(true, work);
}

export function isServiceDeskInternalWrite(): boolean {
  return storage.getStore() === true;
}

/** The Service Desk entities the write guard applies to. */
export const SERVICE_DESK_ENTITY_TYPES = [CASE_ENTITY] as const;
export type ServiceDeskEntityType = (typeof SERVICE_DESK_ENTITY_TYPES)[number];

/**
 * Fields on a `Case` the server owns (§5.1 "Required invariants", §6.1):
 *
 *  - `caseNumber` is allocated once, at creation, from a transaction-safe sequence, and is immutable
 *    afterwards — a client must not choose it.
 *  - the timing/timeline stamps are derived from real events (a qualifying public reply, a resolution
 *    transition), never typed in.
 *  - SLA summary, escalation state and resolution actor are computed by the domain services that own
 *    those workflows (SD.4, SD.8, SD.9) and are surfaced read-only here.
 *
 * A client write that sets any of these is refused by name; a domain service marked with
 * `runAsServiceDeskInternal` may set them.
 */
export const SERVER_OWNED_CASE_FIELDS: readonly string[] = [
  "caseNumber",
  "lastActivityAt",
  "firstResponseAt",
  "lastCustomerResponseAt",
  "lastAgentResponseAt",
  "resolvedAt",
  "closedAt",
  "reopenedAt",
  "resolvedById",
  "slaPolicyId",
  "slaState",
  "isEscalated",
  "escalationLevel",
  "escalatedAt",
];

export { changedKeys } from "./service-desk-domain.js";
