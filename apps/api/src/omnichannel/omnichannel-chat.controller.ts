import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { Public } from '../auth/auth.guard.js';
import {
  OmnichannelWebChatService,
  WEBCHAT_COOKIE_NAME,
  WEBCHAT_COOKIE_PATH,
  type WebChatRequestMeta,
} from './omnichannel-webchat.service.js';

/**
 * Phase 19-OM.9 — the public website-chat endpoints (contract §7).
 *
 * Unauthenticated by design: the visitor holds a session cookie, not a CRM login. Every route is
 * therefore deliberately narrow — create/resume a session, post one message, read the visitor's own
 * customer-visible messages. No route accepts a conversation or message id from the client beyond the
 * visitor's own message cursor, so a visitor cannot enumerate another visitor's history; the visitor
 * address, the consent evidence and the rate window live on the server-side session row.
 *
 * The cookie is `httpOnly`, `SameSite=Lax`, scoped to this path, and carries a 128-bit random key
 * whose hash is all the database keeps. `secure` follows production so the key never travels in the
 * clear outside local development.
 */

const SessionBody = z.object({ consent: z.boolean().optional() }).strict().default({});
const SendBody = z
  .object({
    clientMessageId: z.string().trim().min(8).max(200),
    body: z.string().min(1).max(20_000),
    consent: z.boolean().optional(),
    /** Honeypot: must stay empty (a filled value is silently discarded). */
    website: z.string().max(200).optional(),
  })
  .strict();

interface CookieCapableReply {
  setCookie(name: string, value: string, options: Record<string, unknown>): unknown;
}

function metaOf(origin: string | undefined, request: { readonly ip?: string | undefined; readonly headers?: Record<string, unknown> }): WebChatRequestMeta {
  const userAgent = request.headers?.['user-agent'];
  return {
    ...(origin === undefined || origin.trim() === '' ? {} : { origin: origin.trim() }),
    ...(request.ip === undefined ? {} : { ip: request.ip }),
    ...(typeof userAgent === 'string' && userAgent !== '' ? { userAgent: userAgent.slice(0, 500) } : {}),
  };
}

function visitorKeyOf(request: { readonly cookies?: Record<string, string | undefined> }): string | undefined {
  const value = request.cookies?.[WEBCHAT_COOKIE_NAME];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

@ApiTags('omnichannel')
@Controller('api/v1/Omnichannel/chat')
export class OmnichannelChatController {
  constructor(@Inject(OmnichannelWebChatService) private readonly chat: OmnichannelWebChatService) {}

  @Public()
  @HttpCode(200)
  @Post('session')
  async session(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() request: { readonly ip?: string | undefined; readonly headers?: Record<string, unknown>; readonly cookies?: Record<string, string | undefined> },
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ) {
    const parsed = SessionBody.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid chat session input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    const started = await this.chat.startOrResume(visitorKeyOf(request), metaOf(origin, request));
    reply.setCookie(WEBCHAT_COOKIE_NAME, started.key, {
      httpOnly: true,
      sameSite: 'lax',
      path: WEBCHAT_COOKIE_PATH,
      secure: process.env.NODE_ENV === 'production',
      maxAge: Math.max(60, Math.round((Date.parse(started.view.expiresAt) - Date.now()) / 1000)),
    });
    return started.view;
  }

  @Public()
  @HttpCode(200)
  @Post('messages')
  async send(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() request: { readonly ip?: string | undefined; readonly headers?: Record<string, unknown>; readonly cookies?: Record<string, string | undefined> },
  ) {
    const parsed = SendBody.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid chat message.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    const result = await this.chat.send(visitorKeyOf(request), parsed.data, metaOf(origin, request));
    return { accepted: true, messageId: result.messageId, duplicate: result.duplicate };
  }

  @Public()
  @Get('messages')
  async messages(
    @Query('after') after: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Req() request: { readonly ip?: string | undefined; readonly headers?: Record<string, unknown>; readonly cookies?: Record<string, string | undefined> },
  ) {
    return this.chat.list(visitorKeyOf(request), typeof after === 'string' && after !== '' ? after : undefined, metaOf(origin, request));
  }
}
