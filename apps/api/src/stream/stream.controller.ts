import { InvalidQueryError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import type { StreamItemDto, StreamListOptions } from './stream.service.js';
import { StreamService } from './stream.service.js';

const ListQuerySchema = z.object({
  maxSize: z.coerce.number().int().min(1).max(200).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(['asc', 'desc']).default('desc'),
  type: z.union([z.string(), z.array(z.string())]).optional(),
});

const GlobalQuerySchema = ListQuerySchema.extend({
  view: z.enum(['all', 'followed', 'own']).default('followed'),
  entityType: z.string().min(1).optional(),
});

const NotificationQuerySchema = z.object({
  maxSize: z.coerce.number().int().min(1).max(200).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  unreadOnly: z.union([z.literal('true'), z.literal('1'), z.boolean()]).optional(),
});

/** EspoCRM's Note payload: {type, parentId, parentType, post, attachmentsIds, idList}. */
const NoteBodySchema = z.object({
  type: z.enum(['Post', 'Note']).default('Post'),
  parentId: z.string().min(1),
  parentType: z.string().min(1),
  post: z.string().optional(),
  notes: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  attachmentsIds: z.array(z.string().min(1)).optional(),
  idList: z.array(z.string().min(1)).optional(),
});

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, query: unknown, message: string): z.output<S> {
  const parsed = schema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError(message, { issues: parsed.error.issues.map((issue) => issue.message) });
  }
  return parsed.data as z.output<S>;
}

function typesOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item).trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function listOptions(parsed: { maxSize: number; offset: number; order: 'asc' | 'desc'; type?: unknown }): StreamListOptions {
  const types = typesOf(parsed.type);
  return {
    maxSize: parsed.maxSize,
    offset: parsed.offset,
    order: parsed.order,
    ...(types !== undefined ? { types } : {}),
  };
}

@ApiTags('stream')
@Controller('api/v1/Note')
export class NoteController {
  constructor(@Inject(StreamService) private readonly stream: StreamService) {}

  @Post()
  async create(@Body() body: unknown): Promise<StreamItemDto> {
    const parsed = parseOrThrow(NoteBodySchema, body, 'Invalid note payload.');
    return this.stream.create(parsed.parentType, parsed.parentId, {
      type: parsed.type,
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      ...(parsed.post !== undefined ? { post: parsed.post } : {}),
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(parsed.idList !== undefined ? { mentionIds: parsed.idList } : {}),
      ...(parsed.attachmentsIds !== undefined ? { attachmentIds: parsed.attachmentsIds } : {}),
    });
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ status: boolean; id: string }> {
    if (id.trim() === '') throw new ValidationError('A stream item id is required.');
    await this.stream.remove(id);
    return { status: true, id };
  }
}

@ApiTags('stream')
@Controller('api/v1')
export class StreamController {
  constructor(@Inject(StreamService) private readonly stream: StreamService) {}

  /** The caller's own activity stream (EspoCRM `GET /Stream`). */
  @Get('Stream')
  async mine(@Query() query: unknown): Promise<{ list: StreamItemDto[]; offset: number; count: number }> {
    const parsed = parseOrThrow(GlobalQuerySchema, query, 'Invalid stream query.');
    return this.stream.listGlobal({
      ...listOptions(parsed),
      view: parsed.view,
      ...(parsed.entityType !== undefined ? { entityType: parsed.entityType } : {}),
    });
  }

  @Get(':entityType/:entityId/stream')
  async recordStream(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query() query: unknown,
  ): Promise<{ list: StreamItemDto[]; total: number; offset: number; count: number }> {
    const parsed = parseOrThrow(ListQuerySchema, query, 'Invalid stream query.');
    return this.stream.listForRecord(entityType, entityId, listOptions(parsed));
  }

  @Put(':entityType/:entityId/subscription')
  async follow(@Param('entityType') entityType: string, @Param('entityId') entityId: string): Promise<{ status: boolean }> {
    await this.stream.follow(entityType, entityId);
    return { status: true };
  }

  @Delete(':entityType/:entityId/subscription')
  async unfollow(@Param('entityType') entityType: string, @Param('entityId') entityId: string): Promise<{ status: boolean }> {
    await this.stream.unfollow(entityType, entityId);
    return { status: true };
  }

  /** Not part of the documented EspoCRM surface; the SPA needs it to label the button. */
  @Get(':entityType/:entityId/subscription')
  async isFollowed(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ): Promise<{ followed: boolean }> {
    return { followed: await this.stream.isFollowed(entityType, entityId) };
  }
}

@ApiTags('stream')
@Controller('api/v1/Notification')
export class NotificationController {
  constructor(@Inject(StreamService) private readonly stream: StreamService) {}

  @Get()
  async list(@Query() query: unknown): Promise<{
    list: Array<{ id: string; type: string; data: Record<string, unknown>; isRead: boolean; createdAt: string }>;
    total: number;
    offset: number;
    count: number;
  }> {
    const parsed = parseOrThrow(NotificationQuerySchema, query, 'Invalid notification query.');
    const options = {
      maxSize: parsed.maxSize,
      offset: parsed.offset,
      unreadOnly: parsed.unreadOnly === true || parsed.unreadOnly === 'true' || parsed.unreadOnly === '1',
    };
    const result = await this.stream.listNotifications(options);
    return { ...result, offset: options.offset, count: result.list.length };
  }

  @Post('Read-all')
  async readAll(): Promise<{ status: boolean; updated: number }> {
    return { status: true, updated: await this.stream.markAllNotificationsRead() };
  }

  @Post(':id/Read')
  async read(@Param('id') id: string): Promise<{ status: boolean; id: string }> {
    await this.stream.markNotificationRead(id);
    return { status: true, id };
  }
}
