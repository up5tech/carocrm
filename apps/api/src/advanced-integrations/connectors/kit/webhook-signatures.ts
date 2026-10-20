import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Phase 19-INT.16–19-INT.24 — provider webhook signature verification
 * (`PLAN_Phase_19_Advanced_Integrations.md` §10.2; `19-INT.12`, `19-INT.16`–`19-INT.24`).
 *
 * A provider webhook is **unauthenticated by design** — the provider holds no CRM session — so the
 * provider's own signature is the only thing that makes a delivery trustworthy. Getting that
 * verification right is the single most security-critical thing a connector does, which is why it
 * lives here, once, and why every rule below is deliberate:
 *
 *  - **The signature is computed over the exact bytes the provider sent.** A signature over a
 *    re-serialized body is not the provider's signature, so the *raw* body is required. A connector
 *    that cannot have the raw body must refuse rather than guess.
 *  - **The comparison is constant-time.** A byte-by-byte comparison leaks the position of the
 *    first difference, which is enough to forge a signature one byte at a time.
 *  - **A timestamp is checked inside the window.** Without it, a captured delivery can be replayed
 *    forever, however well signed.
 *  - **A missing header is a rejection, not a "no signature" pass.** A provider that always signs
 *    must always be asked for its signature.
 *
 * Each provider's algorithm is implemented as a named function so a reviewer can read the exact
 * bytes each one covers. The vendor's algorithm is the vendor's: where a provider mandates a weak
 * primitive, this file says so instead of pretending otherwise.
 */

/** The default replay window. A delivery older than this is refused. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** A verification outcome. `valid` is the only thing a caller may branch on. */
export interface SignatureVerification {
  readonly valid: boolean;
  /** A stable reason code: `missing_signature`, `stale_timestamp`, `signature_mismatch`, … */
  readonly reason: string | null;
}

/**
 * Compare two strings in constant time.
 *
 * The lengths are compared first — a length difference is not secret — and the buffers are only
 * compared when they are the same size, so `timingSafeEqual` never throws on unequal input.
 */
export function timingSafeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The HMAC-SHA256 of `message`, in lower-case hex. */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** The HMAC-SHA256 of `message`, in base64. */
export function hmacSha256Base64(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64');
}

/**
 * The HMAC-SHA256 of `message`, in base64, with a `=` suffix.
 *
 * Zoom's `encryptedToken` challenge answer is documented with the padding, so the answer is
 * reproduced exactly as documented rather than re-padded.
 */
export function hmacSha256Base64Padded(secret: string, message: string): string {
  return `${hmacSha256Base64(secret, message)}=`;
}

/**
 * Verify a `timestamp.signature` style header.
 *
 * The covered message is `<version>:<timestamp>:<rawBody>`, which is the shape Zoom and several
 * other providers use.
 */
export function verifyTimestampedHmacSha256Hex(input: {
  readonly rawBody: string | null;
  readonly secret: string | null;
  readonly header: string | undefined;
  readonly timestampToleranceSeconds?: number | undefined;
  readonly now?: number | undefined;
  /** The version prefix the provider uses, e.g. `v1`. */
  readonly version?: string | undefined;
  /** The separator between the timestamp and the signature. */
  readonly separator?: string | undefined;
}): SignatureVerification {
  const version = input.version ?? 'v1';
  const separator = input.separator ?? ':';
  if (input.rawBody === null) return { valid: false, reason: 'raw_body_required' };
  if (input.secret === null || input.secret === '') return { valid: false, reason: 'no_secret' };
  if (input.header === undefined || input.header.trim() === '') return { valid: false, reason: 'missing_signature' };

  const parsed = parseVersionedSignature(input.header, version, separator);
  if (parsed === null) return { valid: false, reason: 'malformed_signature' };

  const tolerance = input.timestampToleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const now = input.now ?? Date.now();
  const timestampMs = parsed.timestamp * 1000;
  if (Math.abs(now - timestampMs) > tolerance * 1000) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const expected = hmacSha256Hex(input.secret, `${version}:${String(parsed.timestamp)}:${input.rawBody}`);
  if (!timingSafeEquals(expected, parsed.signature)) return { valid: false, reason: 'signature_mismatch' };
  return { valid: true, reason: null };
}

/**
 * Parse a `v1=<timestamp>:<signature>` or `v1=<timestamp>,<signature>` header.
 *
 * Providers disagree on the separator, and a connector that refuses a valid delivery because of a
 * separator is worse than one that accepts both. The version prefix must still match, so a
 * signature from a future scheme is not mistaken for a current one.
 */
export function parseVersionedSignature(
  header: string,
  version: string,
  separator: string,
): { readonly timestamp: number; readonly signature: string } | null {
  const trimmed = header.trim();
  const prefix = `${version}=`;
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  const index = separator === ',' ? rest.indexOf(',') : rest.indexOf(separator);
  if (index <= 0) return null;
  const timestampRaw = rest.slice(0, index).trim();
  const signature = rest.slice(index + 1).trim();
  if (!/^\d+$/.test(timestampRaw)) return null;
  if (signature === '') return null;
  return { timestamp: Number(timestampRaw), signature };
}

/**
 * Verify a Stripe-style signature header.
 *
 * The covered message is `<timestamp>.<rawBody>`, and the header carries one or more `v1=` values
 * — a provider that re-signs a delivery adds another one rather than replacing the old.
 */
export function verifyStripeStyleSignature(input: {
  readonly rawBody: string | null;
  readonly secret: string | null;
  readonly header: string | undefined;
  readonly timestampToleranceSeconds?: number | undefined;
  readonly now?: number | undefined;
}): SignatureVerification {
  if (input.rawBody === null) return { valid: false, reason: 'raw_body_required' };
  if (input.secret === null || input.secret === '') return { valid: false, reason: 'no_secret' };
  if (input.header === undefined || input.header.trim() === '') return { valid: false, reason: 'missing_signature' };

  const parts = input.header.split(',').map((part) => part.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null) return { valid: false, reason: 'malformed_signature' };
  if (signatures.length === 0) return { valid: false, reason: 'malformed_signature' };

  const tolerance = input.timestampToleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const now = input.now ?? Date.now();
  if (Math.abs(now - timestamp * 1000) > tolerance * 1000) return { valid: false, reason: 'stale_timestamp' };

  const expected = hmacSha256Hex(input.secret, `${String(timestamp)}.${input.rawBody}`);
  for (const signature of signatures) {
    if (timingSafeEquals(expected, signature)) return { valid: true, reason: null };
  }
  return { valid: false, reason: 'signature_mismatch' };
}

/**
 * Verify a base64 HMAC-SHA256 header over the raw body.
 *
 * This is the shape Shopify uses: the header carries the base64 digest of the raw body, and
 * nothing else. There is no timestamp in the scheme, so the replay window is enforced by the
 * delivery-id deduplication in the ingress instead.
 */
export function verifyBase64HmacSha256(input: {
  readonly rawBody: string | null;
  readonly secret: string | null;
  readonly header: string | undefined;
}): SignatureVerification {
  if (input.rawBody === null) return { valid: false, reason: 'raw_body_required' };
  if (input.secret === null || input.secret === '') return { valid: false, reason: 'no_secret' };
  if (input.header === undefined || input.header.trim() === '') return { valid: false, reason: 'missing_signature' };
  const expected = hmacSha256Base64(input.secret, input.rawBody);
  if (!timingSafeEquals(expected, input.header.trim())) return { valid: false, reason: 'signature_mismatch' };
  return { valid: true, reason: null };
}

/**
 * Verify a Mailchimp-style signature header.
 *
 * Mailchimp's documented scheme is an MD5 digest of the raw body concatenated with the webhook
 * secret. The primitive is the vendor's, not the platform's, and it is weak by modern standards —
 * which is exactly why the platform additionally requires a per-connection secret of a reviewed
 * length and treats a Mailchimp delivery as a *hint* that must be reconciled, never as a
 * sufficient authorization on its own. The comparison is still constant-time.
 */
export function verifyMailchimpStyleSignature(input: {
  readonly rawBody: string | null;
  readonly secret: string | null;
  readonly header: string | undefined;
}): SignatureVerification {
  if (input.rawBody === null) return { valid: false, reason: 'raw_body_required' };
  if (input.secret === null || input.secret === '') return { valid: false, reason: 'no_secret' };
  if (input.header === undefined || input.header.trim() === '') return { valid: false, reason: 'missing_signature' };
  const expected = createHash('md5').update(`${input.rawBody}${input.secret}`, 'utf8').digest('hex');
  if (!timingSafeEquals(expected, input.header.trim())) return { valid: false, reason: 'signature_mismatch' };
  return { valid: true, reason: null };
}

/**
 * Read the endpoint-validation challenge out of the query.
 *
 * Several providers validate an endpoint by calling it with a challenge parameter and expecting
 * the same value back. The answer is never stored: the transport returns it immediately.
 */
export function readChallenge(
  query: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = query[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * Compare a provider's `clientState` with the platform's own value.
 *
 * Graph change notifications carry a `clientState` the subscriber chose; echoing it back proves
 * the delivery came from the subscription the platform made.
 */
export function verifyClientState(expected: string | null, received: string | null): SignatureVerification {
  if (expected === null || expected === '') return { valid: false, reason: 'no_client_state' };
  if (received === null || received === '') return { valid: false, reason: 'missing_client_state' };
  if (!timingSafeEquals(expected, received)) return { valid: false, reason: 'client_state_mismatch' };
  return { valid: true, reason: null };
}
