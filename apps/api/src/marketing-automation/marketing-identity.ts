import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { normalizeEmailAddress } from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.5 — recipient identity and public-token primitives (§5.3, §5.3.1, §6.3, §9.3).
 *
 * Two privacy rules drive this file:
 *
 *  1. **Marketing addresses people by a keyed digest, not by copying the address into new tables.**
 *     §6.1 and §9.3 both ask for minimized recipient data: the consent, suppression and snapshot records
 *     hold `emailHash`, and the plaintext address stays on the canonical CRM record where the platform's
 *     own field ACL already governs it. Matching across records still works, because the digest is
 *     deterministic for a normalized address.
 *  2. **A public unsubscribe link must be usable without revealing anything.** The raw token is generated
 *     with 256 bits of entropy, is never stored, and is looked up by its digest — so a leaked database does
 *     not yield working links, and a failed lookup cannot be distinguished from an unknown address
 *     (`verifyTokenHash` is a constant-time comparison against a hash lookup, and callers answer the same
 *     way for every failure).
 *
 * The digest is an HMAC keyed with the deployment's `ENCRYPTION_KEY` when one is configured. Without a key
 * it degrades to an unsalted SHA-256, which is still one-way but *is* reversible for common addresses by
 * dictionary attack — so `identityStrength` reports that state and the module health endpoint surfaces it
 * rather than letting an operator believe addresses are protected when they are not.
 */

const TOKEN_BYTES = 32;
const HASH_LENGTH = 64;

export interface EmailIdentity {
  readonly hash: string;
  readonly normalized: string;
}

export type IdentityStrength = "keyed" | "unkeyed";

/** Normalise then digest. An empty or malformed value has no identity, which callers must handle. */
export function emailIdentity(address: unknown, secret: string): EmailIdentity | null {
  const normalized = normalizeEmailAddress(address);
  if (normalized === "") return null;
  return { hash: digestIdentity(normalized, secret), normalized };
}

function digestIdentity(normalized: string, secret: string): string {
  return secret.trim() === ""
    ? createHash("sha256").update(`carocrm:marketing:email:${normalized}`).digest("hex")
    : createHmac("sha256", secret).update(normalized).digest("hex");
}

/** Which of the two modes this deployment is in; never a secret itself. */
export function identityStrength(secret: string): IdentityStrength {
  return secret.trim() === "" ? "unkeyed" : "keyed";
}

/** A new opaque token: the value goes to the recipient, only its digest is stored. Expiry is the caller's policy. */
export function issueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(`carocrm:marketing:token:${token.trim()}`).digest("hex");
}

/**
 * Constant-time comparison of a supplied token against the stored digest. The lookup itself is by hash, so
 * this is defence in depth against a partial match being treated as a hit; a malformed stored value is a
 * mismatch rather than an error, because an error would tell an attacker the row exists.
 */
export function tokenMatches(storedHash: string, suppliedToken: string): boolean {
  const computed = hashToken(suppliedToken);
  if (computed.length !== HASH_LENGTH || storedHash.length !== HASH_LENGTH) return false;
  return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(storedHash, "hex"));
}

/** The one answer every failed public request gets (§5.3.1: no existence disclosure). */
export const PUBLIC_TOKEN_INVALID_MESSAGE =
  "This link is not valid. It may have expired or already been used; request a new one from the email.";
