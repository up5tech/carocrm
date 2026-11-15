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
import { InboundConnectionsService, type InboundConnectionView } from './inbound-connections.service.js';

@ApiTags('email-accounts')
@Controller('api/v1/EmailAccount')
export class EmailAccountController {
  constructor(
    @Inject(EmailAccountsService) private readonly accounts: EmailAccountsService,
    @Inject(InboundConnectionsService) private readonly inboundConnections: InboundConnectionsService,
  ) {}

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

  // ── Inbound mail connections (Phase 24.6) ──────────────────────────────────
  // Under the same static prefix so they never collide with the generic `:entity` routes.

  @Get('action/inbound-connections')
  listInboundConnections(): Promise<InboundConnectionView[]> {
    return this.inboundConnections.list();
  }

  @Get('action/inbound-connections/:id')
  getInboundConnection(@Param('id') id: string): Promise<InboundConnectionView> {
    return this.inboundConnections.get(id);
  }

  @Post('action/inbound-connections')
  createInboundConnection(@Body() body: unknown): Promise<InboundConnectionView> {
    return this.inboundConnections.create(body);
  }

  @Patch('action/inbound-connections/:id')
  updateInboundConnection(@Param('id') id: string, @Body() body: unknown): Promise<InboundConnectionView> {
    return this.inboundConnections.update(id, body);
  }

  @Delete('action/inbound-connections/:id')
  removeInboundConnection(@Param('id') id: string): Promise<{ id: string; deleted: boolean }> {
    return this.inboundConnections.remove(id);
  }
}