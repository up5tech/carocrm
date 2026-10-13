import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PortalFrontService } from './portal-front.service.js';

/**
 * Phase 18 — the portal user's own endpoints (PLAN §37). Static routes only, so they can never
 * be captured by the admin controller's `:id` parameter routes (Fastify prioritises static
 * segments over parametric ones).
 */
@ApiTags('portal')
@Controller('api/v1/Portal')
export class PortalController {
  constructor(@Inject(PortalFrontService) private readonly portal: PortalFrontService) {}

  /** Portal context for the signed-in portal user: portal, contact, roles, nav, dashboard. */
  @Get('me')
  me() {
    return this.portal.context();
  }

  /** Portal navigation for the signed-in portal user. */
  @Get('nav')
  nav() {
    return this.portal.nav();
  }

  /** The dashboard the signed-in portal user sees. */
  @Get('dashboard')
  dashboard() {
    return this.portal.dashboard();
  }

  /** Runs a dashlet of the user's dashboard through the portal ACL. */
  @HttpCode(200)
  @Post('dashboard/dashlets/:dashletId/action/run')
  runDashlet(@Param('dashletId') dashletId: string) {
    return this.portal.runDashlet(dashletId);
  }
}
