import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DashboardService } from './dashboard.service.js';

@ApiTags('dashboards')
@Controller('api/v1/Dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboards: DashboardService) {}
  @Get()
  list() { return this.dashboards.list(); }
  @Get(':id')
  get(@Param('id') id: string) { return this.dashboards.get(id); }
  @Post()
  create(@Body() body: unknown) { return this.dashboards.create(body); }
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) { return this.dashboards.update(id, body); }
  @Delete(':id')
  remove(@Param('id') id: string) { return this.dashboards.remove(id); }
  @Post(':id/dashlets')
  addDashlet(@Param('id') id: string, @Body() body: unknown) { return this.dashboards.createDashlet(id, body); }
  @Patch(':id/dashlets/:dashletId')
  updateDashlet(@Param('id') id: string, @Param('dashletId') dashletId: string, @Body() body: unknown) {
    return this.dashboards.updateDashlet(id, dashletId, body);
  }
  @Delete(':id/dashlets/:dashletId')
  deleteDashlet(@Param('id') id: string, @Param('dashletId') dashletId: string) {
    return this.dashboards.deleteDashlet(id, dashletId);
  }
  @HttpCode(200)
  @Post(':id/dashlets/:dashletId/action/run')
  runDashlet(@Param('id') id: string, @Param('dashletId') dashletId: string) {
    return this.dashboards.runDashlet(id, dashletId);
  }
  @Get(':id/dashlets/:dashletId/action/run')
  runDashletGet(@Param('id') id: string, @Param('dashletId') dashletId: string) {
    return this.dashboards.runDashlet(id, dashletId);
  }
}
