import { Controller, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../auth/auth.guard.js';
import { WebhookIngressService } from './webhook-ingress.service.js';

/**
 * Phase 19-INT.12 — the shared webhook endpoint
 * (`PLAN_Phase_19_Advanced_Integrations.md` §10, §13.5; `19-INT.12`).
 *
 * One endpoint serves every connector:
 *
 * ```
 * POST /api/v1/integrations/advanced-integrations/{providerKey}/{webhookKey}/{kind}
 * ```
 *
 * The route is `@Public()` because the provider holds no CRM session. The path segment is an
 * **opaque webhook key**, so an endpoint cannot be enumerated; the secret is the provider's
 * signature, which the connector verifies before anything is recorded.
 *
 * The endpoint answers `202` as soon as the delivery is verified and recorded. Processing happens
 * in a job, so a slow provider never holds the connection open. A delivery that failed verification
 * is answered `401`: it will fail the same way forever, so the provider should stop retrying it.
 */
@ApiTags('advanced-integrations')
@Controller('api/v1/integrations/advanced-integrations')
export class AdvancedIntegrationsWebhookController {
  constructor(@Inject(WebhookIngressService) private readonly ingress: WebhookIngressService) {}

  @Public()
  @HttpCode(202)
  @Post(':providerKey/:webhookKey/:kind')
  async receive(
    @Param('providerKey') providerKey: string,
    @Param('webhookKey') webhookKey: string,
    @Param('kind') kind: string,
    @Headers() headers: Record<string, string | undefined>,
    @Query() query: Record<string, string | undefined>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const rawBody = (request as { rawBody?: string | null }).rawBody ?? null;
    const result = await this.ingress.ingest({
      providerKey,
      webhookKey,
      kind,
      headers,
      query,
      rawBody,
      body: request.body,
    });
    if (result.status === 'rejected') {
      // A rejected delivery is answered with 401: the provider must retry a transient failure, but
      // a bad signature will fail the same way forever, so the provider should stop.
      reply.status(401);
      void reply.send({ status: result.status, eventCount: 0 });
      return;
    }
    reply.status(202);
    void reply.send({ status: result.status, eventCount: result.eventCount });
  }
}
