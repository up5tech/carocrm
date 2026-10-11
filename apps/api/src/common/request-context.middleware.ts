import { createRequestContext,runWithRequestContextAsync } from '@carocrm/core/context/index.js';
import type { NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

export class RequestContextMiddleware implements NestMiddleware {
  async use(request: FastifyRequest, reply: FastifyReply, next: () => void): Promise<void> {
    const context = createRequestContext({
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      locale: request.headers['accept-language']?.split(',')[0],
    });
    await runWithRequestContextAsync(context, async () => {
      void reply;
      next();
    });
  }
}
