import { BadRequestError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/auth.guard.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { runAsAdvancedIntegrationsSystem } from './advanced-integrations-authority.js';
import { OAuthCallbackSchema } from './dto/advanced-integrations-shapes.js';
import { OAUTH_CALLBACK_PATH, OAuthFlowService } from './oauth-flow.service.js';

/**
 * Phase 19-INT.5 — the OAuth callback
 * (`PLAN_Phase_19_Advanced_Integrations.md` §7.2, §13.5; `19-INT.5`).
 *
 * The provider redirects the administrator's browser here, so the route carries **no session**: it
 * is `@Public()`. The platform's own defences take over:
 *
 *  - the single-use `state` is validated and consumed atomically, so a forged or replayed callback
 *    finds nothing;
 *  - the connection is derived **from the state**, never from the request, so a callback cannot be
 *    aimed at somebody else's connection;
 *  - the redirect URI the platform sent is an allowlisted constant, and the one that comes back is
 *    compared against the state row — a callback for a different redirect is refused.
 *
 * Because there is no session, the callback runs under the documented service authority
 * (`advanced-integrations-authority.ts`). That authority is what makes the work attributable; it
 * is not permission to read or mutate an arbitrary CRM record.
 *
 * The authorization code is never persisted, never logged and never echoed back to the browser.
 */
@ApiTags('advanced-integrations')
@Controller('api/v1/integrations/advanced-integrations')
export class AdvancedIntegrationsOAuthCallbackController {
  constructor(
    @Inject(OAuthFlowService) private readonly oauth: OAuthFlowService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Public()
  @Get('oauth/callback')
  async callback(@Query() query: unknown, @Res() reply: FastifyReply): Promise<void> {
    const parsed = OAuthCallbackSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestError('The authorization response is not valid.');
    }
    const result = await runAsAdvancedIntegrationsSystem(this.scope, 'oauth-callback', () =>
      this.oauth.complete({
        state: parsed.data.state,
        code: parsed.data.code ?? '',
        error: parsed.data.error ?? null,
      }),
    );
    // The browser goes back to the administration surface. The module's own page arrives with
    // 19-INT.14; `/admin/settings` exists today, so the redirect is never a dead link.
    const target = `/admin/settings?integrationConnection=${encodeURIComponent(result.connectionId)}&integrationStatus=${encodeURIComponent(result.status)}`;
    await reply.redirect(target, 302);
  }
}

export { OAUTH_CALLBACK_PATH };
