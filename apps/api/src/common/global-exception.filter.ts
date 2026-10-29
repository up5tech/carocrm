import { getLocale, getRequestId } from '@carocrm/core/context/index.js';
import { AppError, InternalServerError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import type { ExecutionContext } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { translateErrorMessage } from '../i18n/i18n.service.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** PostgreSQL error code 23505, unique_violation. */
function isUniqueViolation(exception: unknown): boolean {
  return typeof exception === 'object' && exception !== null && (exception as { code?: unknown }).code === '23505';
}

/**
 * The platform error code that belongs to an HTTP status.
 *
 * Shared by the Nest and the Fastify branches below so a status means the same code whichever layer
 * produced it — a throttled request must read `RATE_LIMITED` whether it came from a guard or from
 * the `@fastify/rate-limit` hook.
 */
function codeForStatus(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'AUTHENTICATION_REQUIRED';
    case 403: return 'AUTHORIZATION_DENIED';
    case 404: return 'RECORD_NOT_FOUND';
    case 409: return 'DUPLICATE_RECORD';
    case 413: return 'FILE_TOO_LARGE';
    case 422: return 'VALIDATION_FAILED';
    case 429: return 'RATE_LIMITED';
    default: return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}

/**
 * Status of an error thrown by a Fastify plugin or hook.
 *
 * The rate limiter, the body parser and the multipart guard throw plain `Error`s that carry only
 * `statusCode`; Nest hands them to this filter like any other exception. Without this branch they
 * fell through to `InternalServerError`, so a 429 reached the SPA as `INTERNAL_ERROR` / 500 and the
 * client could not tell "slow down" from "the server crashed".
 */
function hookStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const status = (exception as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : undefined;
}

/**
 * Query parameters that must never reach a log line.
 *
 * The OAuth callback carries the authorization code and the single-use state in its query string
 * (`/api/v1/integrations/advanced-integrations/oauth/callback`). An error on that route would
 * otherwise put a usable credential into the log (PLAN §7.2: "Redact authorization codes and
 * tokens from access logs, tracing, errors, analytics, and URLs").
 */
const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'code',
  'state',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'password',
]);

/** Replaces the value of every sensitive query parameter with a marker. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return url;
  const path = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);
  const hashStart = query.indexOf('#');
  const fragment = hashStart < 0 ? '' : query.slice(hashStart);
  const params = (hashStart < 0 ? query : query.slice(0, hashStart)).split('&');
  const redacted = params.map((param) => {
    const separator = param.indexOf('=');
    if (separator < 0) return param;
    const key = param.slice(0, separator);
    if (!SENSITIVE_QUERY_PARAMS.has(decodeURIComponent(key).toLowerCase())) return param;
    return `${key}=[redacted]`;
  });
  return `${path}?${redacted.join('&')}${fragment}`;
}

@Catch()
export class GlobalExceptionFilter {
  catch(exception: unknown, host: ExecutionContext): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();

    const hookErrorStatus = hookStatus(exception);
    let error: AppError;
    if (exception instanceof AppError) {
      error = exception;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      error = new AppError(codeForStatus(status), exception.message, undefined, status);
    } else if (isUniqueViolation(exception)) {
      // A database unique constraint is the last line of defence for an invariant the API could
      // not express in a single check (Phase 19: one membership per user per project, one
      // dependency edge). It answers 409, not 500, and never repeats the SQL that produced it.
      error = new AppError('DUPLICATE_RECORD', 'That record already exists.', undefined, 409);
    } else if (hookErrorStatus !== undefined) {
      const message = exception instanceof Error ? exception.message : `HTTP ${hookErrorStatus}.`;
      error = new AppError(codeForStatus(hookErrorStatus), message, undefined, hookErrorStatus);
    } else if (exception instanceof Error && 'validation' in exception) {
      error = new AppError('VALIDATION_FAILED', 'Validation failed.', { details: String(exception) }, 422);
    } else {
      error = new InternalServerError(exception instanceof Error ? exception.message : 'Internal server error.');
    }

    // A 5xx is answered from a fixed sentence, not from the error's own text. The catalog normally
    // replaces a known code with its localized face, but when no catalog is loaded the translator
    // returns the original string — and an original that came from a database driver quotes a
    // statement, and one that came from a connector names a credential field. The request is logged
    // with the real error just below, so the caller loses nothing it is entitled to know.
    const isServerFailure = error.statusCode >= 500;
    const translated = translateErrorMessage(
      getLocale() ?? 'en',
      error.code,
      isServerFailure ? 'Internal server error.' : error.message,
    );
    const details: Record<string, unknown> = { ...(error.details ?? {}) };
    // A throttled caller needs the number, not just the sentence: the rate limiter already wrote
    // `Retry-After`, so it travels in the body as well and the SPA can back off without parsing prose.
    if (error.statusCode === 429) {
      const retryAfter = Number(reply.getHeader('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) details['retryAfterSeconds'] = retryAfter;
    }
    // The catalog text is the generic face of the code ("Validation failed."), which tells an
    // operator nothing. When it replaces a more specific message, that message travels as
    // `details.reason` so a caller can still explain WHY the request was refused — a blocked
    // dependency, a stage from another board.
    //
    // A 5xx is the one case where the message is not the operator's to read. It is the text of an
    // unexpected error — a database driver quoting a statement, a connector naming a credential field —
    // and the request is already logged with it (`log.error` below), so the client gets the generic
    // face and nothing else. This is the plan's rule that a frontend error never surfaces SQL, a stack
    // trace or a provider secret (§14 task 10), enforced where the body is built rather than at each
    // call site that renders it.
    if (translated !== error.message && error.statusCode < 500) details['reason'] = error.message;
    const body: ErrorBody = {
      error: {
        code: error.code,
        // Phase 7A (PLAN §41.9): user-facing errors resolve through the catalog for the request
        // locale; the original message stays the fallback when no translation exists. Details
        // still carry the raw values — only the message string is localized.
        message: translated,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    };

    if (error.statusCode >= 500) {
      log.error({ err: exception, requestId: getRequestId(), path: redactUrl(request.url) }, 'unhandled error');
    } else {
      log.debug({ code: error.code, requestId: getRequestId(), path: redactUrl(request.url) }, 'request error');
    }

    void reply.status(error.statusCode).send(body);
  }
}
