import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Controller, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../auth/auth.guard.js';
import { ESIGNATURE_WEBHOOK_PREFIX } from './esignature-module.js';
import { ESignatureWebhookService } from './esignature-webhook.service.js';

/**
 * Phase 19-ES.11 — the DocuSign Connect endpoint
 * (`PLAN_Phase_19_ESignature.md` §8.3, §10.1, §18 `19-ES.11`).
 *
 * `POST /api/v1/integrations/esignature/{connectionPublicId}` — the random, non-secret routing id the
 * connection was created with. The route is `@Public()` because DocuSign holds no CRM session; the
 * account HMAC is the authentication, and the service verifies it before reading a field.
 *
 * The body is the **raw bytes** preserved by `bootstrap.ts` for this prefix. A parsed body cannot be
 * verified against a signature over the bytes the provider sent, so the controller never falls back to
 * `request.body`.
 *
 * Status codes tell the provider what to do next:
 *
 *  - `202` — durably accepted (or a duplicate of one already accepted);
 *  - `401` — the delivery failed verification and will fail the same way forever;
 *  - `413` — the body exceeds this installation's configured ceiling;
 *  - `404` — the module is off or the routing id is unknown; nothing was recorded.
 *
 * The response body never says which check failed: the inbox and the operator queue carry the reason,
 * because telling a forger which of four checks refused them is help they did not earn.
 */
@ApiTags('esignature')
@Controller(ESIGNATURE_WEBHOOK_PREFIX)
export class ESignatureWebhookController {
  constructor(@Inject(ESignatureWebhookService) private readonly webhooks: ESignatureWebhookService) {}

  @Public()
  @HttpCode(202)
  @Post(':publicId')
  async receive(
    @Param('publicId') publicId: string,
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = publicId.trim();
    if (id === '' || id.length > 64) throw new InvalidQueryError('Unknown signature webhook endpoint.');
    const rawBody = (request as { rawBody?: string | null }).rawBody;
    if (rawBody === undefined || rawBody === null) {
      // The raw body hook runs before parsing for this prefix; a missing value means the transport
      // was misconfigured, and guessing from a parsed body would make the signature meaningless.
      throw new InvalidQueryError('The delivery body could not be read.');
    }
    const headerValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') headerValues[key.toLowerCase()] = value;
    }
    const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : null;
    const result = await this.webhooks.ingest({
      publicId: id,
      headers: headerValues,
      contentType,
      rawBody: new TextEncoder().encode(rawBody),
    });
    reply.status(result.httpStatus);
    if (result.responseBody !== undefined && result.responseBody !== null) {
      // A provider that requires an exact wording gets exactly that wording: an acknowledgement it
      // does not recognise is a failed delivery, whatever the status code says.
      void reply.type('text/plain; charset=utf-8').send(result.responseBody);
      return;
    }
    void reply.send({ status: result.status });
  }
}
