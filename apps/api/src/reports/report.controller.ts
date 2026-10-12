import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/auth.guard.js';
import { ReportService } from './report.service.js';

@ApiTags('reports')
@Controller('api/v1/Report')
export class ReportController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}

  @Get()
  list() {
    return this.reports.list();
  }

  /** Worker-only route; possession of the shared capability is checked again in the service. */
  @Public()
  @HttpCode(200)
  @Post('action/deliver-scheduled')
  deliverScheduled(@Body() body: unknown, @Headers('x-report-worker-secret') secret?: string) {
    const payload = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const scheduleId = payload['scheduleId'];
    if (typeof scheduleId !== 'string' || scheduleId === '') throw new ValidationError('A report schedule id is required.');
    return this.reports.scheduledDelivery(scheduleId, secret);
  }

  @HttpCode(200)
  @Post('action/preview')
  preview(@Body() body: unknown) {
    return this.reports.preview(body);
  }

  @Get(':id/schedule')
  getSchedule(@Param('id') id: string) {
    return this.reports.getSchedule(id);
  }

  @HttpCode(200)
  @Post(':id/schedule')
  upsertSchedule(@Param('id') id: string, @Body() body: unknown) {
    return this.reports.upsertSchedule(id, body);
  }

  @HttpCode(200)
  @Post(':id/schedule/enable')
  enableSchedule(@Param('id') id: string) {
    return this.reports.setScheduleEnabled(id, true);
  }

  @HttpCode(200)
  @Post(':id/schedule/disable')
  disableSchedule(@Param('id') id: string) {
    return this.reports.setScheduleEnabled(id, false);
  }

  @Delete(':id/schedule')
  deleteSchedule(@Param('id') id: string) {
    return this.reports.deleteSchedule(id);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.reports.create(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.reports.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.reports.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.reports.remove(id);
  }

  @HttpCode(200)
  @Post(':id/action/run')
  run(@Param('id') id: string) {
    return this.reports.run(id);
  }

  @Get(':id/action/export')
  export(@Param('id') id: string) {
    return this.reports.exportCsv(id);
  }
}
