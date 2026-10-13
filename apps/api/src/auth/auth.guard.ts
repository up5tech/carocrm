import { getRequestContext } from '@carocrm/core/context/index.js';
import { AuthenticationRequiredError, AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { type CanActivate, type CustomDecorator, type ExecutionContext,Inject, SetMetadata } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
    if (Reflect.getMetadata(PUBLIC_KEY, handler) === true || Reflect.getMetadata(PUBLIC_KEY, controller) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    this.scope.requestId = request.id;

    const authHeader = request.headers.authorization;
    const cookieHeader = request.headers.cookie;

    if (typeof authHeader === 'string' && authHeader.trim() !== '') {
      const [scheme, ...rest] = authHeader.trim().split(/\s+/);
      const value = rest.join(' ');
      if (scheme?.toLowerCase() === 'bearer') {
        const claims = await this.auth.verifyAccessToken(value);
        const principal = await this.auth.principalFromUser(claims.sub as string, typeof claims.sid === 'string' ? claims.sid : undefined);
        this.scope.principal = principal;
        applyPrincipalPreferences(this.scope, principal);
        return true;
      }
      if (scheme?.toLowerCase() === 'apikey') {
        const separator = value.indexOf(':');
        if (separator < 0) throw new AuthenticationRequiredError('Invalid API key format.');
        const keyId = value.slice(0, separator);
        const secret = value.slice(separator + 1);
        const principal = await this.auth.authenticateApiKey(keyId, secret);
        if (!principal) throw new AuthenticationRequiredError('Invalid API key.');
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
          if (!csrfCookie || csrfHeader !== csrfCookie) {
            throw new AuthorizationDeniedError('CSRF token mismatch.');
          }
        }
        const claims = await this.auth.verifyAccessToken(sessionToken);
        const principal = await this.auth.principalFromUser(claims.sub as string, typeof claims.sid === 'string' ? claims.sid : undefined);
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
