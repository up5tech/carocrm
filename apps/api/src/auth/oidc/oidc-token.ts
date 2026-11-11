/**
 * Phase 23.3 (PLAN §17.3) — verifying an OpenID Connect id_token.
 *
 * The id_token is the provider's signed statement about who signed in. Everything the platform
 * believes about the person comes from it, so it is verified before anything else happens:
 *
 *  - **signature**, against the provider's published JWKS. The algorithm is restricted to the
 *    asymmetric ones; `none` and the HMAC family are refused, so a token cannot be signed with the
 *    client secret or with nothing at all;
 *  - **issuer**, exactly the string the profile declares;
 *  - **audience**, the profile's client id must be among the token's audiences. When a token names
 *    more than one audience, `azp` must be the client id (OpenID Connect Core §3.1.3.7);
 *  - **expiry**, with a small clock tolerance so a slightly skewed clock does not refuse a valid
 *    sign-in;
 *  - **nonce**, which is the platform's own answer to "was this id_token minted for *this* sign-in?".
 *
 * The verification uses `jose`, which the platform already signs its own tokens with — no second
 * crypto library and no hand-rolled primitive.
 */

import { ValidationError } from '@carocrm/core/errors/index.js';
import { createLocalJWKSet, errors as joseErrors, type JWK,type JWTPayload, jwtVerify } from 'jose';

import type { OidcProfile } from './oidc-profile.js';

/** The signature algorithms an id_token may use. `none` and HMAC are deliberately absent. */
export const ALLOWED_ID_TOKEN_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;

/** How much clock skew is tolerated on the expiry check, in seconds. */
export const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

export interface VerifiedIdToken {
  /** The provider's stable identifier for the person. */
  readonly subject: string;
  readonly email: string | null;
  /** Whether the provider says the email address is verified. */
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly claims: JWTPayload;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Verify an id_token against the profile and the expected nonce.
 *
 * The failures are deliberately indistinguishable from one another in the message: a caller must not
 * learn whether the issuer, the audience, the signature or the nonce was the wrong one.
 */
export async function verifyIdToken(
  idToken: string,
  profile: OidcProfile,
  jwks: { readonly keys: readonly JWK[] },
  expectedNonce: string,
): Promise<VerifiedIdToken> {
  if (typeof idToken !== 'string' || idToken === '') {
    throw new ValidationError('The identity provider did not return an identity token.');
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new ValidationError('The identity provider published no signing keys.');
  }

  let payload: JWTPayload;
  try {
    const keySet = createLocalJWKSet(jwks as { keys: JWK[] });
    const verified = await jwtVerify(idToken, keySet, {
      issuer: profile.issuer,
      audience: profile.clientId,
      algorithms: [...ALLOWED_ID_TOKEN_ALGORITHMS],
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload;
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      throw new ValidationError('The identity token could not be verified.');
    }
    throw error;
  }

  const subject = payload.sub;
  if (typeof subject !== 'string' || subject === '') {
    throw new ValidationError('The identity token could not be verified.');
  }

  // OpenID Connect Core §3.1.3.7: with more than one audience, the authorized party must be named.
  const audiences = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === 'string' ? [payload.aud] : [];
  if (audiences.length > 1 && payload.azp !== profile.clientId) {
    throw new ValidationError('The identity token could not be verified.');
  }

  const nonce = payload.nonce;
  if (typeof nonce !== 'string' || !constantTimeEquals(nonce, expectedNonce)) {
    throw new ValidationError('The identity token could not be verified.');
  }

  const email = typeof payload.email === 'string' ? payload.email : null;
  const emailVerified = payload.email_verified === true;
  const name = typeof payload.name === 'string' ? payload.name : null;

  return { subject, email, emailVerified, name, claims: payload };
}
