import { createHash } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-ES.2 — the immutable snapshot envelope
 * (`PLAN_Phase_19_ESignature.md` §4.3, §6.2, §11.2; audit §1 "immutable snapshot precedent").
 *
 * Two things must stay true after an envelope is sent, and both are decided by this file rather than
 * by remembering to be careful:
 *
 * 1. **What was sent is recorded.** The documents, their content hashes, the recipients as submitted,
 *    the routing, the message and the account context are copied *by value* into a frozen envelope
 *    with a digest of their canonical form. Editing the CRM attachment afterwards cannot change what
 *    the record says was sent (plan §1.2 "no silent document substitution").
 * 2. **A decision binds to a state of the review.** The digest is the only sane identity for "the
 *    exact thing I approved". When a document, a recipient or a mapping changes, the digest changes,
 *    and the stored `approved_digest` no longer matches — so the approval is invalid rather than
 *    quietly stale (plan §11.2, §17).
 *
 * The pattern is the platform's own (Sales issues its commercial snapshots the same way); it is
 * reimplemented here because ESignature must not import Sales, and the payloads differ (§2.3).
 */

/** Envelope format version. A stored envelope of an unknown version is refused, not guessed. */
export const SNAPSHOT_VERSION = 1;

export interface DocumentSnapshotEntry {
  readonly documentSnapshotId: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHashSha256: string;
  readonly documentOrder: number;
  readonly sourceAttachmentId: string | null;
}

export interface RecipientSnapshotEntry {
  readonly recipientId: string;
  /** What was submitted, not what the Contact says today (plan §6.4). */
  readonly name: string;
  readonly email: string;
  readonly recipientType: string;
  readonly routingOrder: number;
  readonly roleName: string | null;
  readonly authenticationMethod: string | null;
}

/** The shape of the send snapshot: the whole request as the provider saw it. */
export interface OutgoingSnapshotData {
  readonly providerKey: string;
  readonly connectionId: string;
  readonly environment: string;
  readonly accountId: string | null;
  readonly templateId: string | null;
  readonly subject: string | null;
  readonly message: string | null;
  readonly emailBlurb: string | null;
  readonly expiresAt: string | null;
  readonly documents: readonly DocumentSnapshotEntry[];
  readonly recipients: readonly RecipientSnapshotEntry[];
  /** The policy that was in force when the send was confirmed (plan §11.2). */
  readonly policy: Readonly<Record<string, unknown>>;
}

export interface SnapshotEnvelope<T> {
  readonly version: 1;
  /** What the snapshot belongs to, e.g. `SignatureRequest:esr_1`. */
  readonly source: string;
  readonly capturedAt: string;
  readonly digest: string;
  readonly data: T;
}

/**
 * Deterministic JSON: keys sorted at every depth, arrays in order, no whitespace.
 *
 * The digest is only usable as an identity if two equal payloads always produce the same bytes, so
 * this is the single place that decides what "equal" means. `undefined` is dropped, and anything a
 * JSON document cannot hold — a function, a symbol, a non-finite number — is refused rather than
 * silently flattened.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('A signature snapshot cannot contain a non-finite number.');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new ValidationError(`A signature snapshot cannot contain a ${typeof value} value.`);
}

export function snapshotDigest(data: unknown): string {
  return createHash('sha256').update(canonicalJson(data)).digest('hex');
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Capture a snapshot of `data`.
 *
 * The payload is deep-copied and the copy frozen, so mutating the object that was passed in cannot
 * change what the envelope says. That is the invariant the rest of the module depends on and the one
 * the unit tests pin down.
 */
export function buildSnapshot<T>(source: string, data: T, capturedAt: string = new Date().toISOString()): SnapshotEnvelope<T> {
  if (source.trim() === '') throw new ValidationError('A signature snapshot needs a source identifier.');
  const copy = deepFreeze(deepClone(data));
  return Object.freeze({
    version: SNAPSHOT_VERSION as 1,
    source,
    capturedAt,
    digest: snapshotDigest(copy),
    data: copy,
  });
}

/**
 * Read a stored envelope, verifying its digest before the data is handed to a caller.
 *
 * A mismatch is not a warning: it means the row and the evidence disagree, which is precisely what
 * plan §4.7 calls a reconciliation case. The refusal carries the two digests and nothing else — the
 * payload may hold signer identities.
 */
export function readSnapshot<T>(value: unknown): SnapshotEnvelope<T> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('A signature snapshot must be an envelope object.');
  }
  const envelope = value as Partial<SnapshotEnvelope<T>>;
  if (envelope.version !== SNAPSHOT_VERSION) {
    throw new ValidationError(`Unsupported signature snapshot version ${String(envelope.version)}.`, {
      version: envelope.version,
    });
  }
  if (typeof envelope.digest !== 'string' || typeof envelope.data !== 'object' || envelope.data === null) {
    throw new ValidationError('A signature snapshot needs a digest and a payload.');
  }
  const computed = snapshotDigest(envelope.data);
  if (computed !== envelope.digest) {
    throw new ValidationError('The stored signature snapshot does not match its digest.', {
      expected: envelope.digest,
      computed,
    });
  }
  return Object.freeze({
    version: SNAPSHOT_VERSION as 1,
    source: typeof envelope.source === 'string' ? envelope.source : '',
    capturedAt: typeof envelope.capturedAt === 'string' ? envelope.capturedAt : '',
    digest: envelope.digest,
    data: envelope.data,
  });
}

/**
 * Whether a stored approval still applies.
 *
 * Equality of digests is the whole test, and it is deliberately strict: any change to a document, a
 * recipient, the routing, the message or the policy that was in force produces a different digest,
 * so the reviewer is asked again rather than being assumed to agree (plan §11.2, §17).
 */
export function approvalStillApplies(approvedDigest: string | null, currentDigest: string | null): boolean {
  if (approvedDigest === null || approvedDigest === '' || currentDigest === null || currentDigest === '') return false;
  return approvedDigest === currentDigest;
}

/** The stable digest of one outgoing payload, for storing as `approved_digest`. */
export function outgoingSnapshotDigest(data: OutgoingSnapshotData): string {
  return snapshotDigest(data);
}
