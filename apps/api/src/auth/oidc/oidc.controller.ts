/**
 * Phase 23.3 (PLAN §17.3) — the OpenID Connect routes.
 *
 * Three public routes, because a browser arrives from the provider without a session:
 *
 *  - `GET /api/v1/Oidc/providers` — the configured providers, so the sign-in screen can offer them;
 *  - `GET /api/v1/Oidc/start` — begin a sign-in; the browser is redirected to the provider;
 *  - `GET /api/v1/Oidc/callback` — the provider redirects back here.
 *
 * The callback ends in the **same session cookies** the password sign-in issues, so the SPA restores
 * the session the same way it does for a returning user. The browser is then sent to the SPA; a
 * failure sends it to the sign-in screen with a hint and no detail — the provider's own error text
 * never reaches the browser (Phase 23.1 / G52).
 */

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AppConfig,CONFIG_TOKEN } from '../../config.js';
import { randomCsrf } from '../auth.controller.js';
import { Public } from '../auth.guard.js';
import { applySessionCookies } from '../session-cookies.js';
import { OidcIdentityService } from './oidc-identity.service.js';

const OidcCallbackSchema = z
  .object({
    state: z.string().min(1).max(512),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(512).optional(),
    error_description: z.string().max(1024).optional(),
    /** The redirect URI the provider echoes back. It is compared, never trusted. */
    redirect_uri: z.string().max(2048).optional(),
  })
  .strict();

@ApiTags('oidc')
@Controller('api/v1/Oidc')
export class OidcController {
  constructor(
    @Inject(OidcIdentityService) private readonly oidc: OidcIdentityService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** The providers this installation offers. A key and a display name — never a secret. */
  @Public()
  @Get('providers')
  providers(): { readonly list: readonly { readonly key: string; readonly displayName: string }[] } {
    return this.oidc.list();
  }

  /** Begin a sign-in: the browser is redirected to the provider's authorization endpoint. */
  @Public()
  @Get('start')
  async start(@Query('profile') profile: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    if (typeof profile !== 'string' || profile.trim() === '') {
      throw new ValidationError('An identity provider is required.');
    }
    const started = await this.oidc.start(profile.trim());
    await reply.redirect(started.authorizationUrl, 302);
  }

  /** The provider redirects back here. */
  @Public()
  @Get('callback')
  async callback(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = OidcCallbackSchema.safeParse(query ?? {});
    if (!parsed.success) {
      await this.fail(reply, 'malformed');
      return;
    }
    try {
      const outcome = await this.oidc.complete({
        state: parsed.data.state,
        code: parsed.data.code ?? '',
        redirectUri: parsed.data.redirect_uri ?? null,
        error: parsed.data.error ?? null,
        ip: request.ip,
      });
      if (outcome.kind === 'challenge') {
        // The account has its own second factor. The challenge id is single-use, attempt-bounded and
        // expires in five minutes; the SPA finishes the sign-in with it.
        await reply.redirect(`${this.loginPath()}?oidc_challenge=${encodeURIComponent(outcome.challengeId)}`, 302);
        return;
      }
      const csrf = randomCsrf();
      // `request.protocol` honours the configured trustProxy setting, exactly as the password
      // sign-in does.
      applySessionCookies(reply, outcome.tokens, request.protocol === 'https', csrf);
      await reply.redirect(this.successPath(), 302);
    } catch {
      await this.fail(reply, 'refused');
    }
  }

  /** Where the browser goes after a successful sign-in. A relative path — never an open redirect. */
  private successPath(): string {
    return this.config.oidcPostLoginRedirect;
  }

  /** Where the browser goes after a refused sign-in. */
  private loginPath(): string {
    return this.config.oidcLoginPath;
  }

  private async fail(reply: FastifyReply, reason: string): Promise<void> {
    await reply.redirect(`${this.loginPath()}?oidc_error=${encodeURIComponent(reason)}`, 302);
  }
}
