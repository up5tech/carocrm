import { createRequestContext,runWithRequestContextAsync } from '@carocrm/core/context/index.js';
import type { NestMiddleware } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { resolveRequestId } from './request-id.js';
import type { RequestScope } from './request-scope.js';
import { REQUEST_SCOPE_TOKEN } from './request-scope.js';

export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope) {}

  async use(request: FastifyRequest, reply: FastifyReply, next: () => void): Promise<void> {
    const acceptLanguage = request.headers['accept-language'];
    const headerLocale = typeof acceptLanguage === 'string' ? acceptLanguage.split(',')[0] : undefined;
    // A proxy or caller may already carry a correlation id. Honour a bounded, printable one so a
    // request can be traced across the edge; otherwise use Fastify's own request id. The bootstrap
    // `onRequest` hook echoes the same value in `x-request-id` (a Nest middleware receives the raw
    // Node response under Fastify/middie, so it cannot set the header portably).
    const requestId = resolveRequestId(request.headers['x-correlation-id'], request.id);
    const context = createRequestContext({
      requestId,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      locale: headerLocale,
    });
    // Phase 7A (PLAN §41.6): the pre-auth fallback chain starts at Accept-Language; the guard
    // overrides it with the user's own locale/timezone once the principal is resolved. Both are
    // written inside `scope.run` so they land on the per-request AsyncLocalStorage store — a write
    // before `run` would hit the shared fallback and be invisible to the controller.
    await runWithRequestContextAsync(context, async () => {
      void reply;
      this.scope.run(requestId, () => {
        this.scope.acceptLanguage = headerLocale;
        next();
      });
    });
  }
}
