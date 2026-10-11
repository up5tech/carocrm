import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import type { MailTransportInfo } from '@carocrm/mail';
import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { EmailDeliveryView, QueuedEmail } from './email.service.js';
import { EmailService } from './email.service.js';

/**
 * Email API (PLAN §28). The record itself is CRUDed through the generic entity endpoints
 * (`POST /api/v1/Email` to store a draft); this controller owns the parts that are not record
 * content: transport status, queueing a send, and the per-recipient ledger.
 *
 * Static `/api/v1/Email/action/*` routes are declared before `:id` ones, and the whole controller is
 * registered before the generic `/api/v1/:entity` controller so `action` is never read as a record id.
 */
@ApiTags('email')
@Controller('api/v1/Email')
export class EmailController {
  constructor(
    @Inject(EmailService) private readonly emails: EmailService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get('action/transport')
  transport(): MailTransportInfo {
    return this.emails.info();
  }

  /** Admin-only: opening the SMTP connection proves the settings without sending anything. */
  @HttpCode(200)
  @Post('action/verify')
  async verify(): Promise<{ transport: string; verified: boolean; error: string | null }> {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Only an administrator can verify the mail transport.');
    }
    return this.emails.verifyTransport();
  }

  @HttpCode(200)
  @Post(':id/action/send')
  async send(@Param('id') id: string): Promise<QueuedEmail> {
    return this.emails.queueSend(id);
  }

  @Get(':id/deliveries')
  deliveries(@Param('id') id: string): Promise<EmailDeliveryView[]> {
    return this.emails.deliveries(id);
  }
}
