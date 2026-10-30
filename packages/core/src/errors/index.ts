export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class AuthenticationRequiredError extends AppError {
  constructor(message = 'Authentication required.') {
    super('AUTHENTICATION_REQUIRED', message, undefined, 401);
  }
}

export class AuthenticationFailedError extends AppError {
  constructor(message = 'Authentication failed.') {
    super('AUTHENTICATION_FAILED', message, undefined, 401);
  }
}

export class AuthorizationDeniedError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', details?: Record<string, unknown>) {
    super('AUTHORIZATION_DENIED', message, details, 403);
  }
}

export class RecordNotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('RECORD_NOT_FOUND', `Record "${id}" not found in "${entity}".`, { entity, id }, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, details, 422);
  }
}

export class DuplicateRecordError extends AppError {
  constructor(message = 'Duplicate record.', details?: Record<string, unknown>) {
    super('DUPLICATE_RECORD', message, details, 409);
  }
}

export class ConcurrencyConflictError extends AppError {
  constructor(entity: string, id: string) {
    super('CONCURRENCY_CONFLICT', `Record "${id}" in "${entity}" has been modified. Please refresh and try again.`, { entity, id }, 409);
  }
}

export class InvalidQueryError extends AppError {
  constructor(message = 'Invalid query.', details?: Record<string, unknown>) {
    super('INVALID_QUERY', message, details, 400);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded.') {
    super('RATE_LIMITED', message, undefined, 429);
  }
}

/**
 * The work behind a request outlived its deadline (G74). The deadline is enforced twice: PostgreSQL
 * cancels the statement (`statement_timeout`/`lock_timeout`) and the HTTP interceptor stops waiting
 * for the handler. Either way the caller gets one stable code instead of a hung socket or a bare 500.
 * It is a 503 because nothing the caller sent is wrong — the request may simply be retried.
 */
export class RequestTimeoutError extends AppError {
  constructor(message = 'The request took too long to complete.', details?: Record<string, unknown>) {
    super('REQUEST_TIMEOUT', message, details, 503);
  }
}

export class FileTooLargeError extends AppError {
  constructor(maxSize: number) {
    super('FILE_TOO_LARGE', `File exceeds maximum size of ${maxSize} bytes.`, { maxSize }, 413);
  }
}

export class FeatureDisabledError extends AppError {
  constructor(feature: string) {
    super('FEATURE_DISABLED', `Feature "${feature}" is disabled.`, { feature }, 403);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Internal server error.', details?: Record<string, unknown>) {
    super('INTERNAL_ERROR', message, details, 500);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden.') {
    super('FORBIDDEN', message, undefined, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super('NOT_FOUND', message, undefined, 404);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request.', details?: Record<string, unknown>) {
    super('BAD_REQUEST', message, details, 400);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}