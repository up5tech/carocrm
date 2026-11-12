import { AuthorizationDeniedError, InvalidQueryError, RecordNotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';

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
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    // `@Optional` exists for the audit module's isolated test harness, which does not boot the
    // entity module. The API always provides it; when it is absent a non-admin read is refused
    // rather than allowed, so the fallback is fail-closed.
    @Optional() @Inject(EntityCrudService) private readonly entities: EntityCrudService | undefined,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Phase 23.4 (IDoA): a record's history is readable only when the record is.
   *
   * The controller already refuses a non-admin listing without `entityId`, but that only bounds the
   * query — it did not check that the caller may read the record the id names, so any signed-in user
   * could read another record's field-level history by guessing its id. The read goes through
   * `EntityCrudService.get`, which applies the same entity/record/field ACL as the record itself and
   * answers 404 for a record the caller cannot see, so the refusal does not disclose existence.
   *
   * `entityType` is optional on the query. Without it the audit rows themselves name the type; more
   * than one type for one id is ambiguous and is refused rather than guessed.
   */
  async assertHistoryVisible(entityId: string, entityType?: string): Promise<void> {
    if (this.scope.isAdmin) return;
    const types = entityType === undefined
      ? (await this.database.db
          .selectFrom('audit_log')
          .select('entity_type')
          .distinct()
          .where('record_id', '=', entityId)
          .limit(2)
          .execute()).map((row) => row.entity_type)
      : [entityType];
    if (types.length === 0) throw new RecordNotFoundError('AuditLog', entityId);
    if (types.length > 1) {
      throw new AuthorizationDeniedError('This record id is ambiguous; name the entity type to read its history.', { id: entityId });
    }
    const type = types[0] as string;
    if (this.entities === undefined) {
      throw new AuthorizationDeniedError('Record history requires the entity access layer.');
    }
    // `get` enforces the record ACL and throws 404 when the record is out of scope.
    await this.entities.get(type, entityId);
  }

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
