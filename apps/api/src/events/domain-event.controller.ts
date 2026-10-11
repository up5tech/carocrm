import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';

interface DomainEventRow {
  id: string;
  event_type: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  available_at: Date;
  created_at: Date;
  processed_at: Date | null;
}

interface NormalizedListQuery {
  status: string | undefined;
  eventType: string | undefined;
  offset: number;
  limit: number;
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'processed', 'failed']);

/**
 * Read side of the event bus (PLAN §9.4): lets an admin see what the outbox holds and why a
 * consumer failed, without reaching into the database. Static prefix, so it must be registered
 * before the generic record controller.
 */
@ApiTags('platform')
@Controller('api/v1/DomainEvent')
export class DomainEventController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get()
  async list(@Query() raw: Record<string, string | string[] | undefined>): Promise<{
    list: Record<string, unknown>[];
    total: number;
    offset: number;
    count: number;
  }> {
    if (!this.scope.isAdmin) throw new AuthorizationDeniedError('Administrator access is required to read domain events.');
    const query = normalize(raw);
    let builder = this.database.db.selectFrom('outbox_events').selectAll();
    if (query.status !== undefined) builder = builder.where('status', '=', query.status);
    if (query.eventType !== undefined) builder = builder.where('event_type', '=', query.eventType);

    const total = Number(
      (
        await this.database.db
          .selectFrom('outbox_events')
          .select((eb) => eb.fn.countAll<number>().as('total'))
          .$call((q) => (query.status !== undefined ? q.where('status', '=', query.status) : q))
          .$call((q) => (query.eventType !== undefined ? q.where('event_type', '=', query.eventType) : q))
          .executeTakeFirst()
      )?.total ?? 0,
    );

    const rows = await builder
      .orderBy('created_at', 'desc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();

    return {
      list: rows.map((row) => toView(row)),
      total,
      offset: query.offset,
      count: rows.length,
    };
  }
}

function normalize(raw: Record<string, string | string[] | undefined>): NormalizedListQuery {
  const status = typeof raw['status'] === 'string' ? raw['status'] : undefined;
  if (status !== undefined && !STATUSES.has(status)) throw new ValidationError(`Unknown outbox status "${status}".`, { status });
  const limit = clamp(first(raw['limit']), 25, 1, 100);
  const offset = clamp(first(raw['offset']), 0, 0, 100_000);
  const eventType = typeof raw['eventType'] === 'string' && raw['eventType'] !== '' ? raw['eventType'] : undefined;
  return { status, eventType, offset, limit };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clamp(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toView(row: DomainEventRow): Record<string, unknown> {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: typeof row.payload === 'string' ? safeParse(row.payload) : (row.payload ?? {}),
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    availableAt: row.available_at.toISOString(),
    processedAt: row.processed_at?.toISOString() ?? null,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
