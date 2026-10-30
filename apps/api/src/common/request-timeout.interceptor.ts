import { RequestTimeoutError } from '@carocrm/core/errors/index.js';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { catchError, throwError, timeout, TimeoutError } from 'rxjs';

/** A request whose declared `Content-Type` streams its body instead of sending it in one piece. */
function streamsRequestBody(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('multipart/form-data');
}

/**
 * A deadline for one request (G74).
 *
 * The rate limiter bounds how *often* a client calls; nothing bounded how long one call could take,
 * so a handler waiting on a slow dependency held its client, a socket and a pool connection for as
 * long as it liked. The pool's `statement_timeout` covers the database half; this covers everything
 * else (a provider call, a hook, a loop over many records) and answers with the platform's own
 * `REQUEST_TIMEOUT` / 503 rather than a connection the caller eventually abandons.
 *
 * Two deliberate exemptions:
 * - a multipart upload streams for as long as the upload lasts — the transfer is the user's network,
 *   and its queries are still bounded by the pool deadline;
 * - `budgetMs <= 0` disables the deadline entirely for a deployment that runs measured, long
 *   synchronous exports.
 */
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly budgetMs: number) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.budgetMs <= 0) return next.handle();
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const contentType = request.headers?.['content-type'];
    if (typeof contentType === 'string' && streamsRequestBody(contentType)) return next.handle();

    return next.handle().pipe(
      timeout({ first: this.budgetMs }),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? new RequestTimeoutError('The request took too long to complete.', { timeoutMs: this.budgetMs })
            : error,
        ),
      ),
    );
  }
}
