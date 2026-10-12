import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ReportService } from './report.service.js';

@ApiTags('reports')
@Controller('api/v1/Report')
export class ReportController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}

  @Get()
  list() {
    return this.reports.list();
  }

  @HttpCode(200)
  @Post('action/preview')
  preview(@Body() body: unknown) {
    return this.reports.preview(body);
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
