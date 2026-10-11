/**
 * Email account API (PLAN Phase 11 "Email accounts").
 *
 * Registered under its own static prefix (`api/v1/EmailAccount`) so it never collides with the
 * generic `:entity` routes or with `Email`. Every route is admin-only (enforced in the service):
 * mailboxes are system configuration, not CRM records, and their settings include credentials.
 */
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { EmailAccountsService, type EmailAccountView } from './email-accounts.service.js';

@ApiTags('email-accounts')
@Controller('api/v1/EmailAccount')
export class EmailAccountController {
  constructor(@Inject(EmailAccountsService) private readonly accounts: EmailAccountsService) {}

  @Get()
  list(): Promise<EmailAccountView[]> {
    return this.accounts.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<EmailAccountView> {
    return this.accounts.get(id);
  }

  @Post()
  create(@Body() body: unknown): Promise<EmailAccountView> {
    return this.accounts.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown): Promise<EmailAccountView> {
    return this.accounts.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string): Promise<{ id: string; deleted: boolean }> {
    return this.accounts.remove(id);
  }

  /** "Test settings": opens the SMTP connection without sending mail. */
  @HttpCode(200)
  @Post(':id/action/verify')
  verify(@Param('id') id: string): Promise<{ verified: boolean; error: string | null }> {
    return this.accounts.verify(id);
  }
}