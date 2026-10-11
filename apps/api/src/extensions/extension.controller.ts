import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { ExtensionView, InstallResult } from './extension.service.js';
import { ExtensionService } from './extension.service.js';
import type { ExtensionHost, FrontendNavContribution } from './extension-host.js';
import { EXTENSION_HOST } from './extension-host.js';

/**
 * Extension API (PLAN §38.3, §16.1).
 *
 * `/api/v1/Extension` is a static prefix and must be registered **before** the generic record
 * controller, otherwise `Extension` would be read as an entity name.
 *
 * Everything except `GET /Extension/frontend` is administrator-only: installing a package changes
 * what the process executes and what metadata it serves.
 */
@ApiTags('extensions')
@Controller('api/v1/Extension')
export class ExtensionController {
  constructor(
    @Inject(ExtensionService) private readonly extensions: ExtensionService,
    @Inject(EXTENSION_HOST) private readonly host: ExtensionHost,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get()
  async list(): Promise<{ list: ExtensionView[]; total: number }> {
    this.requireAdmin();
    return this.extensions.list();
  }

  @Get('frontend')
  frontend(): { nav: FrontendNavContribution[] } {
    // Any authenticated user may read this: the SPA uses it to render the extension navigation,
    // and `adminOnly` entries are filtered out server-side rather than merely hidden in the client.
    return { nav: this.host.frontendNav().filter((item) => !item.adminOnly || this.scope.isAdmin) };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ExtensionView> {
    this.requireAdmin();
    return this.extensions.get(id);
  }

  @HttpCode(200)
  @Post('action/install')
  async install(@Body() body: unknown): Promise<InstallResult> {
    this.requireAdmin();
    const id = asObject(body)['id'];
    if (typeof id !== 'string') throw new ValidationError('Request body must carry an extension "id".');
    return this.extensions.install(id);
  }

  @HttpCode(200)
  @Post(':id/action/uninstall')
  async uninstall(@Param('id') id: string): Promise<{ id: string; uninstalled: true; restartRequired: true }> {
    this.requireAdmin();
    return this.extensions.uninstall(id);
  }

  @HttpCode(200)
  @Post(':id/action/enable')
  async enable(@Param('id') id: string): Promise<ExtensionView> {
    this.requireAdmin();
    return this.extensions.setEnabled(id, true);
  }

  @HttpCode(200)
  @Post(':id/action/disable')
  async disable(@Param('id') id: string): Promise<ExtensionView> {
    this.requireAdmin();
    return this.extensions.setEnabled(id, false);
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) throw new AuthorizationDeniedError('Administrator access is required to manage extensions.');
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}