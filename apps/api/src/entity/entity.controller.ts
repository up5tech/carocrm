import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { ListQuery } from './entity.service.js';
import { EntityCrudService } from './entity.service.js';

/**
 * Generic record API (PLAN §16.1).
 *
 * IMPORTANT: this controller only uses a parametrised `:entity` prefix, so it must be
 * registered AFTER every controller that owns static `/api/v1/<Name>` routes
 * (AppUser, Metadata, User, Role, Team, Attachment, AuditLog, Authentication, …).
 * Fastify's router prefers static segments over parameters, but keeping the wildcard
 * controller last in `providers`/`controllers` keeps route matching obvious and the
 * OpenAPI order stable. See `entity.module.ts` for the integration note.
 */
@ApiTags('records')
@Controller('api/v1')
export class EntityController {
  constructor(@Inject(EntityCrudService) private readonly service: EntityCrudService) {}

  @HttpCode(200)
  @Post(':entity/action/massUpdate')
  massUpdate(@Param('entity') entity: string, @Body() body: unknown) {
    const { ids, data } = massPayload(body);
    return this.service.massUpdate(entity, ids, data);
  }

  @HttpCode(200)
  @Post(':entity/action/massDelete')
  massDelete(@Param('entity') entity: string, @Body() body: unknown) {
    const { ids } = massPayload(body);
    return this.service.massDelete(entity, ids);
  }

  @HttpCode(200)
  @Post(':entity/:id/restore')
  restore(@Param('entity') entity: string, @Param('id') id: string) {
    return this.service.restore(entity, id);
  }

  @Get(':entity/:id/:relation')
  related(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Param('relation') relation: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    return this.service.related(entity, id, relation, toListQuery(query));
  }

  @Put(':entity/:id/:relation/:relatedId')
  link(@Param('entity') entity: string, @Param('id') id: string, @Param('relation') relation: string, @Param('relatedId') relatedId: string) {
    return this.service.link(entity, id, relation, relatedId);
  }

  @Delete(':entity/:id/:relation/:relatedId')
  unlink(@Param('entity') entity: string, @Param('id') id: string, @Param('relation') relation: string, @Param('relatedId') relatedId: string) {
    return this.service.unlink(entity, id, relation, relatedId);
  }

  @Get(':entity')
  list(@Param('entity') entity: string, @Query() query: Record<string, string | string[] | undefined>) {
    return this.service.list(entity, toListQuery(query));
  }

  @Post(':entity')
  create(@Param('entity') entity: string, @Body() body: unknown) {
    return this.service.create(entity, asObject(body));
  }

  @Get(':entity/:id')
  get(@Param('entity') entity: string, @Param('id') id: string, @Query('select') select?: string) {
    return this.service.get(entity, id, select);
  }

  @Put(':entity/:id')
  put(@Param('entity') entity: string, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(entity, id, asObject(body));
  }

  @Patch(':entity/:id')
  patch(@Param('entity') entity: string, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(entity, id, asObject(body));
  }

  @Delete(':entity/:id')
  remove(@Param('entity') entity: string, @Param('id') id: string) {
    return this.service.remove(entity, id);
  }
}

function toListQuery(query: Record<string, string | string[] | undefined>): ListQuery {
  const out: ListQuery = {};
  const where = query['where'];
  const select = query['select'];
  const orderBy = query['orderBy'] ?? query['order'];
  const offset = query['offset'];
  const maxSize = query['maxSize'] ?? query['limit'];

  if (where !== undefined) out.where = where;
  if (select !== undefined) out.select = select;
  if (orderBy !== undefined) out.orderBy = orderBy;
  if (offset !== undefined) out.offset = offset;
  if (maxSize !== undefined) out.maxSize = maxSize;
  return out;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function massPayload(body: unknown): { ids: string[]; data: Record<string, unknown> } {
  const payload = asObject(body);
  const rawIds = payload['ids'] ?? payload['selection'];
  if (!Array.isArray(rawIds)) {
    throw new ValidationError('Parameter "ids" must be an array of record ids.');
  }
  const ids = rawIds.filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) throw new ValidationError('Parameter "ids" must not be empty.');
  const data = payload['data'];
  return { ids, data: typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {} };
}
