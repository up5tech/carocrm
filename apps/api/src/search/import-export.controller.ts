import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ListQuery } from '../entity/entity.service.js';
import { ImportExportService } from './import-export.service.js';

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('Request body must be a JSON object.');
  return body as Record<string, unknown>;
}
@ApiTags('import-export')
@Controller('api/v1')
export class ImportExportController {
  constructor(@Inject(ImportExportService) private readonly portal: ImportExportService) {}
  @Get(':entity/action/exportColumns')
  columns(@Param('entity') entity: string) {
    return { entity, columns: this.portal.exportableFields(entity) };
  }
  @HttpCode(200)
  @Post(':entity/action/import')
  async importCsv(@Param('entity') entity: string, @Body() body: unknown, @Query('updateOnName') updateOnName: string | string[] | undefined) {
    const payload = asObject(body);
    const csv = payload['csv'];
    if (typeof csv !== 'string' || csv === '') throw new ValidationError('Request body must carry a "csv" string.');
    const flag = single(updateOnName);
    const update = payload['updateOnName'] === true || flag === 'true' || flag === '1';
    return this.portal.importCsv(entity, csv, update ? { updateOnName: true } : {});
  }
  @HttpCode(200)
  @Post(':entity/action/export')
  async exportPost(@Param('entity') entity: string, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const payload = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const q: ListQuery = {};
    if (payload['where'] !== undefined) q.where = payload['where'] as ListQuery['where'];
    if (payload['select'] !== undefined) q.select = payload['select'] as ListQuery['select'];
    if (payload['orderBy'] !== undefined) q.orderBy = payload['orderBy'] as ListQuery['orderBy'];
    const result = await this.portal.exportCsv(entity, q);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${result.filename}"`);
    return result.csv;
  }
  @Get(':entity/action/export')
  async exportGet(@Param('entity') entity: string, @Query() query: Record<string, string | string[] | undefined>, @Res({ passthrough: true }) reply: FastifyReply, @Req() req: FastifyRequest) {
    void req;
    const q: ListQuery = {};
    const where = single(query['where']);
    const orderBy = single(query['orderBy'] ?? query['order']);
    if (where !== undefined) q.where = where;
    if (orderBy !== undefined) q.orderBy = orderBy;
    const result = await this.portal.exportCsv(entity, q);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${result.filename}"`);
    return result.csv;
  }
}
