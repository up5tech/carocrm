import { InvalidQueryError, RecordNotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

export interface AuditListQuery {
  entityId?: string | undefined;
  entityType?: string | undefined;
  action?: string | undefined;
  /** Exact username match filter. */
  usernameFrom?: string | undefined;
  /** ISO timestamp lower bound (inclusive) on created_at. */
  createdFrom?: string | undefined;
  /** ISO timestamp upper bound (inclusive) on created_at. */
  createdTo?: string | undefined;
  offset: number;
  limit: number;
}

export interface AuditLogEntryDto {
  id: string;
  entityType: string;
  entityId: string;
  username: string | null;
  userId: string | null;
  action: string;
  order: number;
  data: unknown;
  archived: boolean;
  createdAt: string;
}

export interface AuditListResult {
  list: AuditLogEntryDto[];
  total: number;
  offset: number;
  count: number;
}

export const AUDIT_MAX_LIMIT = 200;

function parseDate(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidQueryError(`"${name}" must be an ISO 8601 timestamp.`, { [name]: value });
  }
  return date;
}

@Injectable()
export class AuditReadService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(q: AuditListQuery): Promise<AuditListResult> {
    const build = () => {
      let query = this.database.db.selectFrom('audit_log');
      if (q.entityId !== undefined) query = query.where('record_id', '=', q.entityId);
      if (q.entityType !== undefined) query = query.where('entity_type', '=', q.entityType);
      if (q.action !== undefined) query = query.where('action', '=', q.action);
      if (q.usernameFrom !== undefined) query = query.where('username', '=', q.usernameFrom);
      if (q.createdFrom !== undefined) query = query.where('created_at', '>=', parseDate(q.createdFrom, 'createdFrom'));
      if (q.createdTo !== undefined) query = query.where('created_at', '<=', parseDate(q.createdTo, 'createdTo'));
      return query;
    };

    const totalRow = await build()
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .executeTakeFirstOrThrow();
    const total = Number(totalRow.total);

    const rows = await build()
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit)
      .offset(q.offset)
      .execute();

    return {
      list: rows.map(toDto),
      total,
      offset: q.offset,
      count: rows.length,
    };
  }

  async getById(id: string): Promise<AuditLogEntryDto> {
    const row = await this.database.db
      .selectFrom('audit_log')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) {
      throw new RecordNotFoundError('AuditLog', id);
    }
    return toDto(row);
  }
}

function toDto(row: {
  id: string;
  entity_type: string;
  record_id: string;
  username: string | null;
  user_id: string | null;
  action: string;
  order: number;
  data: unknown;
  archived: boolean;
  created_at: Date;
}): AuditLogEntryDto {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.record_id,
    username: row.username,
    userId: row.user_id,
    action: row.action,
    order: Number(row.order),
    data: row.data,
    archived: row.archived,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
