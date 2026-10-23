import type { DomainEventInput } from '@carocrm/core/domain-events/index.js';

import type { SignatureRequestStatus } from './esignature-domain.js';
import { ESIGNATURE_EVENT_TYPES,type ESignatureEventType } from './esignature-module.js';
import type { SignatureRequest } from './signature-request.repository.js';

/**
 * Phase 19-ES.18 — the ESignature domain-event contract
 * (`PLAN_Phase_19_ESignature.md` §15, §18 `19-ES.18`).
 *
 * Every lifecycle fact the CRM announces goes through the platform's transactional outbox (`EventBus`),
 * never through a provider-shaped payload or a direct module-to-module call. The contract is
 * deliberately poor in data:
 *
 *  - the **local request id** and its provider/connection/source references;
 *  - the normalized status at the moment of the event;
 *  - the occurrence time, correlation id and a schema version;
 *  - a **dedupe key** that a replaying consumer can use as its idempotency key.
 *
 * It never carries document bytes, provider tokens, signing URLs, recipient emails or free-form
 * message text. A downstream module that needs more reads it through the CRM with its own ACL.
 *
 * The dedupe key is deterministic from the event's meaning — the type, the request and a stable
 * discriminator (a digest, a send attempt, a provider event id, an artifact set). Re-emitting the same
 * fact therefore produces the same key even if the outbox row is redelivered, which is what makes
 * "event replay does not duplicate downstream actions" possible without a shared processed table here.
 */

export const ESIGNATURE_EVENT_SCHEMA_VERSION = 1;

export interface SignatureEventPayload {
  readonly requestId: string;
  readonly providerKey: string;
  readonly connectionId: string | null;
  readonly sourceEntityType: string | null;
  readonly sourceRecordId: string | null;
  readonly status: SignatureRequestStatus;
  readonly occurredAt: string;
  readonly correlationId: string | null;
  readonly schemaVersion: number;
  readonly dedupeKey: string;
  readonly recipientId?: string;
  readonly recipientStatus?: string;
  readonly artifactKinds?: readonly string[];
  readonly artifactCount?: number;
}

export interface BuildSignatureEventInput {
  readonly occurredAt?: string;
  readonly correlationId?: string | null;
  /** The stable fact discriminator: digest, attempt id, provider event id, artifact set, … */
  readonly discriminator: string;
  readonly extra?: Record<string, unknown>;
}

/** The event a terminal/in-flight normalized status announces, or `null` for an aggregate-only state. */
export function eventForStatus(status: SignatureRequestStatus): ESignatureEventType | null {
  switch (status) {
    case 'sent':
      return 'esignature.requestSent';
    case 'completed':
      return 'esignature.requestCompleted';
    case 'declined':
      return 'esignature.requestDeclined';
    case 'voided':
      return 'esignature.requestVoided';
    case 'expired':
      return 'esignature.requestExpired';
    case 'reconciliation_required':
      return 'esignature.requestNeedsReconciliation';
    default:
      return null;
  }
}

/** Build one outbox event for a request. The caller supplies the transaction that caused it. */
export function buildSignatureEvent(
  type: ESignatureEventType,
  request: SignatureRequest,
  input: BuildSignatureEventInput,
): DomainEventInput {
  if (!(ESIGNATURE_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown ESignature event type "${type}".`);
  }
  const payload: SignatureEventPayload = {
    requestId: request.id,
    providerKey: request.providerKey,
    connectionId: request.connectionId,
    sourceEntityType: request.sourceEntityType,
    sourceRecordId: request.sourceRecordId,
    status: request.status,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    correlationId: input.correlationId ?? null,
    schemaVersion: ESIGNATURE_EVENT_SCHEMA_VERSION,
    dedupeKey: `${type}:${request.id}:${input.discriminator}`,
    ...(input.extra ?? {}),
  };
  return { type, payload: payload as unknown as Record<string, unknown> };
}
