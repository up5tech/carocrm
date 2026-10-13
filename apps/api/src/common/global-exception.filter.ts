import { getLocale } from '@carocrm/core/context/index.js';
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

@Catch()
export class GlobalExceptionFilter {
  catch(exception: unknown, host: ExecutionContext): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();

    let error: AppError;
    if (exception instanceof AppError) {
      error = exception;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const mapped =
        status === 401 ? 'AUTHENTICATION_REQUIRED' :
        status === 403 ? 'AUTHORIZATION_DENIED' :
        status === 404 ? 'RECORD_NOT_FOUND' :
        status === 409 ? 'DUPLICATE_RECORD' :
        status === 422 ? 'VALIDATION_FAILED' : 'BAD_REQUEST';
      error = new AppError(mapped, exception.message, undefined, status);
    } else if (isUniqueViolation(exception)) {
      // A database unique constraint is the last line of defence for an invariant the API could
      // not express in a single check (Phase 19: one membership per user per project, one
      // dependency edge). It answers 409, not 500, and never repeats the SQL that produced it.
      error = new AppError('DUPLICATE_RECORD', 'That record already exists.', undefined, 409);
    } else if (exception instanceof Error && 'validation' in exception) {
      error = new AppError('VALIDATION_FAILED', 'Validation failed.', { details: String(exception) }, 422);
    } else {
      error = new InternalServerError(exception instanceof Error ? exception.message : 'Internal server error.');
    }

    const translated = translateErrorMessage(getLocale() ?? 'en', error.code, error.message);
    const details: Record<string, unknown> = { ...(error.details ?? {}) };
    // The catalog text is the generic face of the code ("Validation failed."), which tells an
    // operator nothing. When it replaces a more specific message, that message travels as
    // `details.reason` so a caller can still explain WHY the request was refused — a blocked
    // dependency, a stage from another board.
    if (translated !== error.message) details['reason'] = error.message;
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
      log.error({ err: exception, requestId: request.id, path: request.url }, 'unhandled error');
    } else {
      log.debug({ code: error.code, requestId: request.id, path: request.url }, 'request error');
    }

    void reply.status(error.statusCode).send(body);
  }
}
