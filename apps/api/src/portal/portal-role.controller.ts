import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PortalAdminService } from './portal-admin.service.js';

/**
 * Phase 18 — portal role administration. Portal roles are their own role space (PLAN §37):
 * the internal `/api/v1/Role` endpoints can neither read nor write them, and an internal role
 * can never be assigned to a portal user.
 */
@ApiTags('portal-admin')
@Controller('api/v1/PortalRole')
export class PortalRoleController {
  constructor(@Inject(PortalAdminService) private readonly admin: PortalAdminService) {}

  @Get()
  list() {
    return this.admin.listPortalRoles();
  }

  @Post()
  create(@Body() body: unknown) {
    return this.admin.createPortalRole(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.admin.getPortalRole(id);
  }

  @Patch(':id')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.admin.updatePortalRole(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.admin.deletePortalRole(id);
  }
}
