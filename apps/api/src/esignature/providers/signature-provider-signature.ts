import { createHash } from 'node:crypto';

/**
 * Phase 19-ES.3 — the provider-side HMAC kit
 * (`PLAN_Phase_19_ESignature.md` §10.2; audit §1 "timing-safe HMAC verifiers").
 *
 * DocuSign Connect signs the **exact bytes it sent**, so the only honest verification is over the raw
 * body, and the exact header layout, encoding and (where present) timestamp form are captured from a
 * demo account in ES.11 rather than guessed from documentation. What is decided now, in ES.3, is the
 * mechanism every adapter shares: base64 HMAC-SHA-256 over the raw bytes, compared in constant time.
 *
 * The platform already ships these primitives — `timingSafeEquals`, `hmacSha256Base64` and the
 * body-limit helper in `advanced-integrations/connectors/kit/webhook-signatures.ts` — and they are
 * **reused, not rewritten**: a second copy of a signature comparison is a second chance to get the
 * constant-time part wrong. What this file adds is only the shape the signature domain needs:
 * a body-size ceiling from the settings policy, and a result that distinguishes
 * "no secret configured" from "the signature did not match", because the first is an administrator
 * action and the second is an attack attempt.
 */
import { hmacSha256Base64, timingSafeEquals } from '../../advanced-integrations/connectors/kit/webhook-signatures.js';
import { canonicalJson } from '../esignature-snapshot.js';

export { timingSafeEquals };

export const CONNECT_SIGNATURE_HEADER_CANDIDATES = ['x-docusign-signature-256', 'x-fake-signature'] as const;

/**
 * The outcome of a verification attempt.
 *
 * `reason` is `null` in exactly two cases: a valid delivery, and a signature that simply did not
 * match. The second is the caller's problem; the first three are this installation's, and the
 * distinction is what an operator acts on.
 */
export interface SignatureCheck {
  readonly valid: boolean;
  readonly reason: 'no_secret' | 'missing_signature' | 'too_large' | null;
}

/**
 * The HMAC a DocuSign Connect configuration of this shape produces: HMAC-SHA-256 over the base64 of
 * the raw body, in base64. That is the documented Connect scheme; ES.11 confirms it against a real
 * demo-account fixture before any installation is called secure, and this file is where a correction
 * lands once, for every caller.
 */
export function connectSignature(secret: string, rawBody: Uint8Array): string {
  return hmacSha256Base64(secret, Buffer.from(rawBody).toString('base64'));
}

/** The first header value among the candidates, case-insensitively. Headers arrive lower-cased. */
export function readSignatureHeader(headers: Readonly<Record<string, string>>): string | null {
  for (const name of CONNECT_SIGNATURE_HEADER_CANDIDATES) {
    const direct = headers[name];
    if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  }
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if ((CONNECT_SIGNATURE_HEADER_CANDIDATES as readonly string[]).includes(lowered) && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Verify a delivery's signature.
 *
 * Fails closed at every step: no configured secret, no header, a body over the ceiling, or a
 * mismatch all refuse. A refusal never says *why* to the sender — the reason is for the local inbox
 * row and the operator, because telling a caller which of the four failed helps a forger (plan §8.3).
 */
export function verifyConnectSignature(input: {
  secret: string | null;
  rawBody: Uint8Array;
  signature: string | null;
  maxPayloadBytes: number;
}): SignatureCheck {
  if (input.rawBody.byteLength > input.maxPayloadBytes) return { valid: false, reason: 'too_large' };
  if (input.secret === null || input.secret.trim() === '') return { valid: false, reason: 'no_secret' };
  if (input.signature === null || input.signature === '') return { valid: false, reason: 'missing_signature' };
  const expected = connectSignature(input.secret, input.rawBody);
  return { valid: timingSafeEquals(expected, input.signature), reason: null };
}

/** The SHA-256 of the raw bytes, for the inbox row's evidence that "these exact bytes" arrived. */
export function rawBodyHash(rawBody: Uint8Array): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** The canonical digest of a parsed value, shared with the event model so both agree on identity. */
export function valueHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
