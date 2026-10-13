import { createRequestContext,runWithRequestContextAsync } from '@carocrm/core/context/index.js';
import type { NestMiddleware } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestScope } from './request-scope.js';
import { REQUEST_SCOPE_TOKEN } from './request-scope.js';

export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope) {}

  async use(request: FastifyRequest, reply: FastifyReply, next: () => void): Promise<void> {
    const acceptLanguage = request.headers['accept-language'];
    const context = createRequestContext({
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      locale: typeof acceptLanguage === 'string' ? acceptLanguage.split(',')[0] : undefined,
    });
    // Phase 7A (PLAN §41.6): the pre-auth fallback chain starts at Accept-Language; the guard
    // overrides it with the user's own locale/timezone once the principal is resolved.
    this.scope.acceptLanguage = typeof acceptLanguage === 'string' ? acceptLanguage.split(',')[0] : undefined;
    await runWithRequestContextAsync(context, async () => {
      void reply;
      this.scope.run(request.id, next);
    });
  }
}
