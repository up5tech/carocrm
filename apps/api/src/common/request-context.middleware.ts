import { createRequestContext,runWithRequestContextAsync } from '@carocrm/core/context/index.js';
import type { NestMiddleware } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestScope } from './request-scope.js';
import { REQUEST_SCOPE_TOKEN } from './request-scope.js';

export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope) {}

  async use(request: FastifyRequest, reply: FastifyReply, next: () => void): Promise<void> {
    const context = createRequestContext({
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      locale: request.headers['accept-language']?.split(',')[0],
    });
    await runWithRequestContextAsync(context, async () => {
      void reply;
      this.scope.run(request.id, next);
    });
  }
}
