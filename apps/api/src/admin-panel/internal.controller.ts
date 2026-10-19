import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { InternalInfoService, type InternalInfoView } from './internal.service.js';

/**
 * The internal tab's routes (PLAN_Phase_20_Settings_UX.md §4.3 row 8). Static prefixes so they never
 * collide with the generic `:entity` wildcard; the service enforces the system-administrator level on
 * every route, so the controller stays a thin adapter.
 */
@ApiTags('admin-internal')
@Controller('api/v1/AdminInternal')
export class InternalInfoController {
  constructor(@Inject(InternalInfoService) private readonly internal: InternalInfoService) {}

  @Get()
  info(): Promise<InternalInfoView> {
    return this.internal.info();
  }

  /** Guarded: the body must carry the exact typed confirmation, and the action is audited. */
  @HttpCode(200)
  @Post('action/metadata-reset')
  resetMetadata(@Body() body: { confirm?: unknown }): Promise<{ cleared: number }> {
    return this.internal.resetMetadataOverrides(body?.confirm);
  }

  @HttpCode(200)
  @Post('action/queue-purge')
  purgeQueue(@Body() body: { confirm?: unknown }): Promise<{ drained: number | null }> {
    return this.internal.purgeJobQueue(body?.confirm);
  }
}
