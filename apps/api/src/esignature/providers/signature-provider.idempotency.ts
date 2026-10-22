import { createHash } from 'node:crypto';

import { getRequestId } from '@carocrm/core/context/index.js';

/**
 * Phase 19-ES.3 — correlation ids and idempotency keys for provider calls
 * (`PLAN_Phase_19_ESignature.md` §4.3, §5.2, §16; audit §5.3; `19-ES.3` task "define provider error
 * categories, capabilities, correlation IDs and idempotency behavior").
 *
 * One rule, applied to every mutating call: **the key is derived from the platform's intent, never
 * from a random value generated at call time.** A random per-attempt key would make a retry a new
 * request, which is precisely how a timed-out send becomes two signature invitations to a real
 * person. Deriving it from the request id plus the request's own send-attempt token means the same
 * human action always maps to the same key, however many times the process retries it (plan §4.3).
 *
 * The derivation mirrors the platform's existing idempotency convention — a SHA-256 over a
 * colon-joined tuple of already-validated identifiers, as
 * `apps/api/src/advanced-integrations/outbound-sync.service.ts:330-345` does with a unique DB key —
 * so a provider-side key and a database-side uniqueness constraint mean the same thing here.
 *
 * The correlation id is the platform's request id (`request.id` → `RequestContext`), which is what
 * joins an audit row, a log line and an operator's report without any of them carrying a secret.
 */

/** The purposes that need an idempotency key. A read does not: a repeated GET is not a side effect. */
export const IDEMPOTENT_PURPOSES = [
  'prepareEnvelope',
  'sendEnvelope',
  'resendNotifications',
  'voidEnvelope',
  'correctEnvelope',
  'downloadArtifacts',
] as const;
export type IdempotentPurpose = (typeof IDEMPOTENT_PURPOSES)[number];

export interface CallIdentityInput {
  readonly purpose: IdempotentPurpose;
  readonly connectionId: string;
  readonly signatureRequestId?: string | null;
  /** The request's own send-attempt token, when the purpose is a send (plan §4.3). */
  readonly sendAttemptId?: string | null;
  readonly providerEnvelopeId?: string | null;
  /** Anything else that makes this intent distinct, e.g. a recipient id for a reminder. */
  readonly discriminator?: string | null;
}

/** The stable parts of an intent, in a fixed order. */
export function identityTuple(input: CallIdentityInput): readonly string[] {
  return [
    input.purpose,
    input.connectionId,
    input.signatureRequestId ?? 'no-request',
    input.sendAttemptId ?? 'no-attempt',
    input.providerEnvelopeId ?? 'no-envelope',
    input.discriminator ?? 'no-discriminator',
  ];
}

/**
 * The idempotency key for one intent.
 *
 * Hex SHA-256, so it is safe to put in a URL, a header or a provider text field: it can never carry a
 * name, an email or a document title even when the inputs came from a person's draft.
 */
export function idempotencyKey(input: CallIdentityInput): string {
  return createHash('sha256').update(identityTuple(input).join(':')).digest('hex');
}

/**
 * The correlation id for the current call.
 *
 * Read from the platform's request context rather than generated: one incident therefore has one id
 * across the API log, the audit row, the provider request and any job that follows. Outside a request
 * (a job, a reconciliation sweep) the platform's sentinel is `unknown`, so a caller in a job passes its
 * own durable id as `fallback` instead of inventing one.
 */
export function correlationId(fallback?: string): string {
  const fromRequest = getRequestId();
  if (fromRequest !== 'unknown') return fromRequest.slice(0, 120);
  return (fallback ?? fromRequest).slice(0, 120);
}

/**
 * The send's own identity: the pair the reconciliation path (ES.12) needs to ask the provider
 * "did you take this request".
 *
 * A send without a `sendAttemptId` is refused rather than keyed by the request alone — two deliberate
 * send actions on one draft must not collapse into one key, and an un-attempted send is a caller
 * bug the platform should surface immediately (plan §4.3).
 */
export function sendIdentity(input: {
  connectionId: string;
  signatureRequestId: string;
  sendAttemptId: string;
  providerEnvelopeId?: string | null;
  fallbackCorrelationId?: string;
}): { readonly idempotencyKey: string; readonly correlationId: string } {
  const attempt = input.sendAttemptId.trim();
  if (attempt === '') {
    throw new Error('A signature send requires the request\'s send attempt token.');
  }
  return {
    idempotencyKey: idempotencyKey({
      purpose: 'sendEnvelope',
      connectionId: input.connectionId,
      signatureRequestId: input.signatureRequestId,
      sendAttemptId: attempt,
      providerEnvelopeId: input.providerEnvelopeId ?? null,
    }),
    correlationId: correlationId(input.fallbackCorrelationId),
  };
}

/** The preparation's identity: one draft plus its snapshot digest is one provider draft envelope. */
export function prepareIdentity(input: {
  connectionId: string;
  signatureRequestId: string;
  /** The outgoing snapshot digest, so a changed draft prepares a different envelope. */
  snapshotDigest: string;
  fallbackCorrelationId?: string;
}): { readonly idempotencyKey: string; readonly correlationId: string } {
  return {
    idempotencyKey: idempotencyKey({
      purpose: 'prepareEnvelope',
      connectionId: input.connectionId,
      signatureRequestId: input.signatureRequestId,
      discriminator: input.snapshotDigest,
    }),
    correlationId: correlationId(input.fallbackCorrelationId),
  };
}

/**
 * The artifact-retrieval identity.
 *
 * Keyed by the envelope and the artifact kind rather than by the job: re-running the download job
 * therefore maps to the same intent, and dedupe happens on the artifact's content hash and provider
 * document id in `signature_document_snapshots` (plan §16).
 */
export function artifactIdentity(input: {
  connectionId: string;
  providerEnvelopeId: string;
  artifactKind: string;
}): { readonly idempotencyKey: string; readonly correlationId: string } {
  return {
    idempotencyKey: idempotencyKey({
      purpose: 'downloadArtifacts',
      connectionId: input.connectionId,
      providerEnvelopeId: input.providerEnvelopeId,
      discriminator: input.artifactKind,
    }),
    correlationId: correlationId(),
  };
}
