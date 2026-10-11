import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { ListQuery } from '../entity/entity.service.js';
import { PortalSearchService } from './portal-search.service.js';

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function listQuery(query: Record<string, string | string[] | undefined>): ListQuery {
  const out: ListQuery = {};
  const where = single(query['where']);
  const select = single(query['select']);
  const orderBy = single(query['orderBy'] ?? query['order']);
  const offset = single(query['offset']);
  const maxSize = single(query['maxSize'] ?? query['limit']);
  const total = single(query['total']);
  if (where !== undefined) out.where = where;
  if (select !== undefined) out.select = select;
  if (orderBy !== undefined) out.orderBy = orderBy;
  if (offset !== undefined) out.offset = offset;
  if (maxSize !== undefined) out.maxSize = maxSize;
  if (total !== undefined) out.total = total;
  return out;
}
@ApiTags('search')
@Controller('api/v1/Search')
export class SearchController {
  constructor(@Inject(PortalSearchService) private readonly search: PortalSearchService) {}
  @Get()
  global(@Query() query: Record<string, string | string[] | undefined>) {
    const input: { q?: string | undefined; entities?: string | undefined; limit?: string | undefined; offset?: string | undefined } = {};
    const q = single(query['q']);
    const entities = single(query['entities']);
    const limit = single(query['limit'] ?? query['maxSize']);
    const offset = single(query['offset']);
    if (q !== undefined) input.q = q;
    if (entities !== undefined) input.entities = entities;
    if (limit !== undefined) input.limit = limit;
    if (offset !== undefined) input.offset = offset;
    return this.search.globalSearch(input);
  }
  @Get(':entity')
  entity(@Param('entity') entity: string, @Query() query: Record<string, string | string[] | undefined>) {
    const q = single(query['q']);
    const parsed = listQuery(query);
    const input: { q?: string | undefined; where?: unknown; orderBy?: string | undefined; maxSize?: unknown; offset?: unknown } = {};
    if (q !== undefined) input.q = q;
    if (parsed.where !== undefined) input.where = parsed.where;
    if (parsed.orderBy !== undefined) input.orderBy = parsed.orderBy as string;
    if (parsed.maxSize !== undefined) input.maxSize = parsed.maxSize;
    if (parsed.offset !== undefined) input.offset = parsed.offset;
    return this.search.entitySearch(entity, input);
  }
  @HttpCode(200)
  @Post(':entity')
  entityPost(@Param('entity') entity: string, @Body() body: unknown) {
    const payload = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const input: { q?: string | undefined; where?: unknown; orderBy?: string | undefined; maxSize?: unknown; offset?: unknown } = {};
    if (typeof payload['q'] === 'string') input.q = payload['q'];
    if (payload['where'] !== undefined) input.where = payload['where'];
    if (typeof payload['orderBy'] === 'string') input.orderBy = payload['orderBy'];
    if (payload['maxSize'] !== undefined) input.maxSize = payload['maxSize'];
    if (payload['offset'] !== undefined) input.offset = payload['offset'];
    return this.search.entitySearch(entity, input);
  }
}
