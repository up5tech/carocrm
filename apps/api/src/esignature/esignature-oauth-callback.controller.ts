import { BadRequestError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/auth.guard.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { OAuthCallbackQuerySchema } from './dto/esignature-shapes.js';
import { runAsESignatureSystem } from './esignature-authority.js';
import { ESignatureConnectionService } from './esignature-connection.service.js';

/**
 * Phase 19-ES.4 — the DocuSign OAuth callback
 * (`PLAN_Phase_19_ESignature.md` §8.1, §9.2, §14; `19-ES.4`).
 *
 * This is the module's **only** unauthenticated route, and it exists on its own rather than inside
 * `ESignatureController` because that controller's invariant is "every route checks a capability
 * server-side". A handler the provider redirects a browser to carries no session, so it cannot keep
 * that invariant — and putting it beside the routes that do would make the exception invisible.
 *
 * What protects it instead is all in the service it calls: the state is single-use, hashed at rest and
 * consumed atomically; the connection is derived **from** the state, never from the request; and the
 * state names the environment, so a flow started against demo cannot complete against production.
 *
 * Nothing from the query is echoed. An authorization code appears exactly once in this process — as a
 * parameter of the token exchange — and a failure here answers with a stable message, never with the
 * provider's words, which can quote a token (plan §8.1 "callback responses must not leak").
 */
@ApiTags('esignature')
@Controller('api/v1/ESignature')
export class ESignatureOAuthCallbackController {
  constructor(
    @Inject(ESignatureConnectionService) private readonly connections: ESignatureConnectionService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Public()
  @Get('oauth/callback')
  async callback(@Query() query: unknown, @Res() reply: FastifyReply): Promise<void> {
    const parsed = OAuthCallbackQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestError('The authorization response is not valid.');
    const outcome = await runAsESignatureSystem(this.scope, 'oauth-callback', () =>
      this.connections.complete({
        state: parsed.data.state,
        code: parsed.data.code ?? '',
        error: parsed.data.error ?? null,
      }),
    );
    // Back to the module's own page, carrying only the connection id and the outcome. The token
    // exchange already happened server-side, so no credential is in this URL (plan §8.1).
    const target = `/esignature?connection=${encodeURIComponent(outcome.connection.id)}&authorization=${encodeURIComponent(outcome.status)}`;
    await reply.redirect(target, 302);
  }
}
