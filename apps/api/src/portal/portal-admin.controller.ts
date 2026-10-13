import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PortalAdminService } from './portal-admin.service.js';

/**
 * Phase 18 — portal administration (PLAN §37). Admin-only; portal users themselves use
 * `PortalController`. Nested resources hang off the portal id, so every write is scoped to
 * exactly one portal.
 */
@ApiTags('portal-admin')
@Controller('api/v1/Portal')
export class PortalAdminController {
  constructor(@Inject(PortalAdminService) private readonly admin: PortalAdminService) {}

  @Get()
  list() {
    return this.admin.listPortals();
  }

  @Post()
  create(@Body() body: unknown) {
    return this.admin.createPortal(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.admin.getPortal(id);
  }

  @Patch(':id')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.admin.updatePortal(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.admin.deletePortal(id);
  }

  /** Roles granted to every portal user of this portal (PLAN §18.2). */
  @Post(':id/roles')
  @Put(':id/roles')
  setRoles(@Param('id') id: string, @Body() body: unknown) {
    return this.admin.setPortalRoles(id, body);
  }

  @Get(':id/navigation')
  listNav(@Param('id') id: string) {
    return this.admin.listNav(id);
  }

  @Post(':id/navigation')
  createNavItem(@Param('id') id: string, @Body() body: unknown) {
    return this.admin.createNavItem(id, body);
  }

  @Patch(':id/navigation/:itemId')
  @Put(':id/navigation/:itemId')
  updateNavItem(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: unknown) {
    return this.admin.updateNavItem(id, itemId, body);
  }

  @Delete(':id/navigation/:itemId')
  removeNavItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.admin.deleteNavItem(id, itemId);
  }

  @Get(':id/dashboards')
  listDashboards(@Param('id') id: string) {
    return this.admin.listDashboards(id);
  }

  @Post(':id/dashboards')
  createDashboard(@Param('id') id: string, @Body() body: unknown) {
    return this.admin.createDashboard(id, body);
  }

  @Patch(':id/dashboards/:dashboardId')
  @Put(':id/dashboards/:dashboardId')
  updateDashboard(@Param('id') id: string, @Param('dashboardId') dashboardId: string, @Body() body: unknown) {
    return this.admin.updateDashboard(id, dashboardId, body);
  }

  @Delete(':id/dashboards/:dashboardId')
  removeDashboard(@Param('id') id: string, @Param('dashboardId') dashboardId: string) {
    return this.admin.deleteDashboard(id, dashboardId);
  }

  @Post(':id/dashboards/:dashboardId/dashlets')
  createDashlet(@Param('id') id: string, @Param('dashboardId') dashboardId: string, @Body() body: unknown) {
    return this.admin.createDashlet(id, dashboardId, body);
  }

  @Patch(':id/dashboards/:dashboardId/dashlets/:dashletId')
  @Put(':id/dashboards/:dashboardId/dashlets/:dashletId')
  updateDashlet(
    @Param('id') id: string,
    @Param('dashboardId') dashboardId: string,
    @Param('dashletId') dashletId: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateDashlet(id, dashboardId, dashletId, body);
  }

  @Delete(':id/dashboards/:dashboardId/dashlets/:dashletId')
  removeDashlet(@Param('id') id: string, @Param('dashboardId') dashboardId: string, @Param('dashletId') dashletId: string) {
    return this.admin.deleteDashlet(id, dashboardId, dashletId);
  }
}
