import { timingSafeEqual } from 'node:crypto';

import { getRequestContext } from '@carocrm/core/context/index.js';
import { AuthenticationRequiredError, AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { type CanActivate, type CustomDecorator, type ExecutionContext,Inject, SetMetadata } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { resolveRequestId } from '../common/request-id.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { AuthService } from './auth.service.js';

export const PUBLIC_KEY = 'crm:public';

export function Public(): CustomDecorator {
  return SetMetadata(PUBLIC_KEY, true);
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const isPublic = Reflect.getMetadata(PUBLIC_KEY, handler) === true || Reflect.getMetadata(PUBLIC_KEY, controller) === true;
    if (isPublic) {
      // Phase 23.1 (C5): `POST /api/v1/Refresh` is `@Public()` and cookie-driven, so it must
      // not be reachable cross-site. Enforce the double-submit CSRF contract for that route.
      const path = request.url.split('?')[0] ?? '';
      if (request.method === 'POST' && path.endsWith('/Refresh') && typeof request.headers.cookie === 'string') {
        const cookies = parseCookies(request.headers.cookie);
        if (cookies['CRM-REFRESH']) {
          const csrfCookie = cookies['CRM-CSRF'];
          const csrfHeader = request.headers['x-csrf-token'];
          if (!csrfCookie || typeof csrfHeader !== 'string' || !timingSafeEqualStrings(csrfCookie, csrfHeader)) {
            throw new AuthorizationDeniedError('CSRF token mismatch.');
          }
          enforceSameOrigin(request);
        }
      }
      return true;
    }

    // Keep the middleware's correlation id; only fall back to Fastify's id when none was supplied.
    this.scope.requestId = resolveRequestId(request.headers['x-correlation-id'], request.id);

    const authHeader = request.headers.authorization;
    const cookieHeader = request.headers.cookie;

    if (typeof authHeader === 'string' && authHeader.trim() !== '') {
      const [scheme, ...rest] = authHeader.trim().split(/\s+/);
      const value = rest.join(' ');
      if (scheme?.toLowerCase() === 'bearer') {
        const claims = await this.auth.verifyAccessToken(value);
        const principal = await this.auth.principalFromUser(claims.sub as string, typeof claims.sid === 'string' ? claims.sid : undefined);
        enforceMfaPending(principal, request);
        this.scope.principal = principal;
        applyPrincipalPreferences(this.scope, principal);
        return true;
      }
      if (scheme?.toLowerCase() === 'apikey') {
        const separator = value.indexOf(':');
        if (separator < 0) throw new AuthenticationRequiredError('Invalid API key format.');
        const keyId = value.slice(0, separator);
        const secret = value.slice(separator + 1);
        const principal = await this.auth.authenticateApiKey(keyId, secret, request.ip);
        if (!principal) throw new AuthenticationRequiredError('Invalid API key.');
        enforceApiKeyScopes(principal, request);
        this.scope.principal = principal;
        applyPrincipalPreferences(this.scope, principal);
        return true;
      }
      throw new AuthenticationRequiredError('Unsupported authorization scheme.');
    }

    if (cookieHeader) {
      const cookies = parseCookies(cookieHeader);
      const sessionToken = cookies['CRM-SESSION'];
      if (sessionToken) {
        if (UNSAFE_METHODS.has(request.method)) {
          const csrfCookie = cookies['CRM-CSRF'];
          const csrfHeader = request.headers['x-csrf-token'];
          if (!csrfCookie || typeof csrfHeader !== 'string' || !timingSafeEqualStrings(csrfCookie, csrfHeader)) {
            throw new AuthorizationDeniedError('CSRF token mismatch.');
          }
          enforceSameOrigin(request);
        }
        const claims = await this.auth.verifyAccessToken(sessionToken);
        const principal = await this.auth.principalFromUser(claims.sub as string, typeof claims.sid === 'string' ? claims.sid : undefined);
        enforceMfaPending(principal, request);
        this.scope.principal = principal;
        applyPrincipalPreferences(this.scope, principal);
        return true;
      }
    }

    void reply;
    throw new AuthenticationRequiredError();
  }
}

/**
 * Phase 7A (PLAN §41.6): once the user is resolved, their locale/timezone outrank the
 * Accept-Language fallback. The same values are mirrored into the request context so the
 * logger, metadata serialization and the error filter all read one consistent locale.
 */
function applyPrincipalPreferences(scope: RequestScope, principal: { locale?: string | undefined; timezone?: string | undefined }): void {
  if (principal.locale) scope.locale = principal.locale;
  if (principal.timezone) scope.timezone = principal.timezone;
  const context = getRequestContext();
  if (!context) return;
  if (context.locale === undefined || principal.locale) context.locale = principal.locale ?? context.locale;
  if (context.timezone === undefined || principal.timezone) context.timezone = principal.timezone ?? context.timezone;
}

/**
 * Phase 23.2 (PLAN §8 task 3): a session opened while the instance MFA policy is unsatisfied
 * (`mfa_pending`) may only reach the enrollment surface — TOTP setup/enable, the profile read the
 * SPA needs to render it, and logout. Everything else is refused until the factor is confirmed;
 * without this check the flag would be advisory only and the policy bypassable.
 */
const MFA_PENDING_ROUTES = new Set([
  'GET /api/v1/AppUser/me',
  'POST /api/v1/AppUser/me/totp/setup',
  'POST /api/v1/AppUser/me/totp/enable',
  'POST /api/v1/Logout',
]);

function enforceMfaPending(principal: { mfaPending?: boolean | undefined }, request: FastifyRequest): void {
  if (principal.mfaPending !== true) return;
  const path = request.url.split('?')[0] ?? '';
  if (!MFA_PENDING_ROUTES.has(`${request.method} ${path}`)) {
    throw new AuthorizationDeniedError('Two-factor enrollment is required to continue.');
  }
}

/**
 * Phase 23.2 (PLAN §8 task 5 / PLAN §17.2): an API key's scope restriction is enforced at the door.
 * `write` implies `read`; a key whose scopes are unset (NULL) is unrestricted, which is the
 * pre-23.2 behaviour every existing key keeps.
 */
function enforceApiKeyScopes(principal: { keyScopes?: readonly string[] | undefined }, request: FastifyRequest): void {
  const scopes = principal.keyScopes;
  if (scopes === undefined) return;
  const has = (scope: string) => scopes.includes(scope);
  const allowed = UNSAFE_METHODS.has(request.method) ? has('write') : has('read') || has('write');
  if (!allowed) {
    throw new AuthorizationDeniedError('This API key does not allow the requested operation.', { scopes: [...scopes] });
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Phase 23.1 (C5): best-effort same-origin check for cookie-authenticated state-changing
 * requests. A cross-site Sec-Fetch-Site is always rejected; an explicit Origin that does not
 * match the request's host is rejected. Missing headers are allowed (non-browser clients).
 */
function enforceSameOrigin(request: FastifyRequest): void {
  const secFetchSite = request.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') {
    throw new AuthorizationDeniedError('Cross-site request rejected.');
  }
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    try {
      const originUrl = new URL(origin);
      const host = request.headers.host;
      if (typeof host === 'string' && host !== '' && originUrl.host !== host) {
        throw new AuthorizationDeniedError('Cross-origin request rejected.');
      }
    } catch {
      throw new AuthorizationDeniedError('Invalid Origin header.');
    }
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name !== '') out[name] = decodeURIComponent(value);
  }
  return out;
}
