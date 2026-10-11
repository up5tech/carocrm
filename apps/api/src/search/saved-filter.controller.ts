import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { ListQuery } from '../entity/entity.service.js';
import { SavedFilterService } from './saved-filter.service.js';

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
@ApiTags('saved-filters')
@Controller('api/v1/SavedFilter')
export class SavedFilterController {
  constructor(@Inject(SavedFilterService) private readonly filters: SavedFilterService) {}
  @Get()
  list(@Query('entityType') entityType: string | string[] | undefined) {
    return this.filters.list(single(entityType));
  }
  @Get(':id')
  get(@Param('id') id: string) {
    return this.filters.get(id);
  }
  @Post()
  create(@Body() body: unknown) {
    return this.filters.create(body);
  }
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.filters.update(id, body);
  }
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.filters.remove(id);
  }
  @HttpCode(200)
  @Post(':id/action/run')
  run(@Param('id') id: string, @Body() body: unknown, @Query() query: Record<string, string | string[] | undefined>) {
    const payload = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const q: ListQuery = {};
    const where = single(query['where']);
    const maxSize = single(query['maxSize'] ?? query['limit']);
    const offset = single(query['offset']);
    if (where !== undefined) q.where = where;
    if (maxSize !== undefined) q.maxSize = maxSize;
    if (offset !== undefined) q.offset = offset;
    if (payload['where'] !== undefined) q.where = payload['where'] as ListQuery['where'];
    if (payload['maxSize'] !== undefined) q.maxSize = payload['maxSize'] as ListQuery['maxSize'];
    if (payload['offset'] !== undefined) q.offset = payload['offset'] as ListQuery['offset'];
    return this.filters.run(id, q);
  }
}
