/**
 * Phase 23.3 — the session cookies, in one place.
 *
 * The password sign-in and the external (OIDC) sign-in must issue **the same** cookies: a browser
 * that signs in with an external identity gets the same session, the same refresh rotation and the
 * same CSRF double-submit as one that typed a password. Copying the cookie strings into a second
 * controller is how the two paths drift apart, so the strings live here.
 */

import type { FastifyReply } from 'fastify';

import type { AuthTokens } from './auth.service.js';

/** The refresh cookie's lifetime — 14 days, matching the refresh token's own TTL. */
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 1209600;

/**
 * The three cookies a browser session consists of.
 *
 * `CRM-SESSION` and `CRM-REFRESH` are `HttpOnly` — script cannot read them. `CRM-CSRF` is
 * deliberately **not** `HttpOnly`: the double-submit pattern needs the SPA to read it and send it
 * back as `x-csrf-token`.
 */
export function sessionCookies(tokens: AuthTokens, secure: boolean, csrf: string): readonly string[] {
  const flags = `Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  return [
    `CRM-SESSION=${tokens.accessToken}; ${flags}; HttpOnly; Max-Age=${tokens.expiresIn}`,
    `CRM-REFRESH=${tokens.refreshToken}; ${flags}; HttpOnly; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}`,
    `CRM-CSRF=${csrf}; ${flags}`,
  ];
}

/** Write the session cookies on a reply. */
export function applySessionCookies(reply: FastifyReply, tokens: AuthTokens, secure: boolean, csrf: string): void {
  reply.header('set-cookie', [...sessionCookies(tokens, secure, csrf)]);
}
