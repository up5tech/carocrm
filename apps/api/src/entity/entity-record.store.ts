import { randomUUID } from 'node:crypto';

import type { RecordStorePort } from '@carocrm/entity-engine/entity-manager/index.js';
import type { EntityQuery, EntityRecord, ListResult } from '@carocrm/entity-engine/types/index.js';
import type { ColumnRef, OrderClause, QueryCriterion, QueryFilter, TranslatedQuery } from '@carocrm/query-engine/index.js';
import { PHYSICAL_COLUMNS, toCamelCase } from '@carocrm/query-engine/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { RawBuilder } from 'kysely';
import { sql } from 'kysely';

import type { AclPredicate } from '../acl/acl-api.service.js';
import type { Db, DbTx, EntityRecordsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { AfterSaveHook } from './hooks.js';
import { KERNEL_HOOKS_TOKEN } from './hooks.js';

export const ENTITY_STORE = Symbol('ENTITY_STORE');

/** Attrs equality clause (key and value are always bind parameters). */
export interface AttrEqualsClause {
  readonly field: string;
  readonly value: string;
}

/** JSON-array containment clause: `attrs->'field' @> '["value"]'`. */
export interface AttrContainsClause {
  readonly field: string;
  readonly value: string;
}

/**
 * Store query = engine-translated structure + the caller-injected ACL predicate.
 * The store never derives access rules itself (PLAN §15.3): the API layer must pass
 * `acl`, and a `denyAll` predicate yields an empty result set.
 */
export interface StoreFindQuery extends EntityQuery {
  translated?: TranslatedQuery | undefined;
  acl?: AclPredicate | undefined;
  attrsEquals?: readonly AttrEqualsClause[] | undefined;
  attrsContains?: readonly AttrContainsClause[] | undefined;
  ids?: readonly string[] | undefined;
  /**
   * Skip the `count(*)` round-trip (`?total=false`). When false the returned
   * `total` is `0` and must not be surfaced by the caller.
   */
  countTotal?: boolean | undefined;
}

/** Either the connection or an open transaction; both expose the same query API. */
type Queryable = Db | DbTx;

const TABLE = 'entity_records';

const PHYSICAL_KEYS: ReadonlySet<string> = new Set([
  'id',
  'entityType',
  'entity_type',
  'name',
  'attrs',
  'createdAt',
  'modifiedAt',
  'assignedUserId',
  'createdById',
  'modifiedById',
  'deletedAt',
  'deleted',
  'deleted_at',
  'teams',
  'team_ids',
  'version',
]);

const NUMERIC_FIELD_TYPES: ReadonlySet<string> = new Set(['int', 'float', 'decimal', 'currency', 'aggregationCount']);
const DATE_FIELD_TYPES: ReadonlySet<string> = new Set(['date', 'datetime']);

type AttrCast = 'numeric' | 'timestamptz';

@Injectable()
export class PostgresRecordStore implements RecordStorePort {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(KERNEL_HOOKS_TOKEN) private readonly hooks: AfterSaveHook[],
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  private get db(): Db {
    return this.database.db;
  }

  private mapRow(row: EntityRow): EntityRecord {
    return fromRow(row, this.metadata);
  }

  private dataOf(row: EntityRow): Record<string, unknown> {
    return { ...this.mapRow(row).data };
  }

  async insert(record: EntityRecord): Promise<void> {
    const values = toRow(record);
    await this.withTransaction(async (tx) => {
      await tx.insertInto(TABLE).values(values).execute();
      await this.runHooks(record, undefined, tx);
    });
  }

  async findById(entity: string, id: string): Promise<EntityRecord | undefined> {
    const row = await this.db
      .selectFrom(TABLE)
      .selectAll()
      .where('entity_type', '=', entity)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? this.mapRow(row) : undefined;
  }

  /** Includes soft-deleted records — used by the restore flow. */
  async findByIdIncludingDeleted(entity: string, id: string): Promise<EntityRecord | undefined> {
    const row = await this.db
      .selectFrom(TABLE)
      .selectAll()
      .where('entity_type', '=', entity)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.mapRow(row) : undefined;
  }

  async update(record: EntityRecord, expectedVersion: number): Promise<boolean> {
    const values = toRow(record);
    return this.withTransaction(async (tx) => {
      const previousRow = await tx
        .selectFrom(TABLE)
        .selectAll()
        .where('entity_type', '=', record.entityType)
        .where('id', '=', record.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!previousRow || previousRow.version !== expectedVersion) return false;

      const result = await tx
        .updateTable(TABLE)
        .set(values)
        .where('entity_type', '=', record.entityType)
        .where('id', '=', record.id)
        .where('version', '=', expectedVersion)
        .executeTakeFirst();
      if (!updatedOnce(result.numUpdatedRows)) return false;

      await this.runHooks(record, this.dataOf(previousRow), tx);
      return true;
    });
  }

  async markDeleted(entity: string, id: string, deletedAt: Date): Promise<boolean> {
    return this.withTransaction(async (tx) => {
      const previousRow = await tx
        .selectFrom(TABLE)
        .selectAll()
        .where('entity_type', '=', entity)
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!previousRow) return false;

      const result = await tx
        .updateTable(TABLE)
        .set({ deleted_at: deletedAt })
        .where('entity_type', '=', entity)
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!updatedOnce(result.numUpdatedRows)) return false;

      const record = this.mapRow({ ...previousRow, deleted_at: deletedAt });
      await this.runHooks(record, this.dataOf(previousRow), tx);
      return true;
    });
  }

  /** Clears `deleted_at`; returns false when the row is missing or was never deleted. */
  async restore(entity: string, id: string): Promise<boolean> {
    const result = await this.db
      .updateTable(TABLE)
      .set({ deleted_at: null, modified_at: new Date() })
      .where('entity_type', '=', entity)
      .where('id', '=', id)
      .where('deleted_at', 'is not', null)
      .executeTakeFirst();
    return updatedOnce(result.numUpdatedRows);
  }

  async findMany(entity: string, query: StoreFindQuery = {}): Promise<ListResult<EntityRecord>> {
    const base = this.db.selectFrom(TABLE).selectAll().where(sql<boolean>`${col('entity_type')} = ${entity}`);
    let filtered = base;

    if (!query.includeDeleted) filtered = filtered.where(sql<boolean>`${col('deleted_at')} is null`);

    const acl = aclSql(query.acl);
    if (acl) filtered = filtered.where(acl);
    for (const condition of buildConditions(query)) filtered = filtered.where(condition);

    const countTotal = query.countTotal !== false;
    const total = countTotal
      ? Number(
          (
            await filtered
              .clearSelect()
              .select((eb) => eb.fn.countAll<number>().as('total'))
              .executeTakeFirst()
          )?.total ?? 0,
        )
      : 0;

    let ordered = filtered;
    for (const clause of orderClauses(query.translated)) {
      ordered = ordered.orderBy(clause);
    }
    const offset = query.translated?.offset ?? clampInt(query.offset, 0);
    const limit = query.translated?.limit ?? clampInt(query.limit, 20);

    const rows = await ordered.limit(limit).offset(offset).execute();
    const list = rows.map((row) => this.mapRow(row));
    return { list, total, offset, count: list.length };
  }

  async linkRecord(options: {
    entityTypeA: string;
    recordIdA: string;
    relationName: string;
    entityTypeB: string;
    recordIdB: string;
  }): Promise<void> {
    await this.db
      .insertInto('entity_links')
      .values({
        id: randomUUID(),
        entity_type_a: options.entityTypeA,
        record_id_a: options.recordIdA,
        relation_name: options.relationName,
        entity_type_b: options.entityTypeB,
        record_id_b: options.recordIdB,
        role_a: null,
        role_b: null,
        attributes: JSON.stringify({}),
        created_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['entity_type_a', 'record_id_a', 'relation_name', 'entity_type_b', 'record_id_b']).doNothing(),
      )
      .execute();
  }

  async unlinkRecord(options: {
    entityTypeA: string;
    recordIdA: string;
    relationName: string;
    recordIdB: string;
  }): Promise<void> {
    await this.db
      .deleteFrom('entity_links')
      .where('entity_type_a', '=', options.entityTypeA)
      .where('record_id_a', '=', options.recordIdA)
      .where('relation_name', '=', options.relationName)
      .where('record_id_b', '=', options.recordIdB)
      .execute();
  }

  async replaceLinks(options: {
    entityTypeA: string;
    recordIdA: string;
    relationName: string;
    entityTypeB: string;
    recordIdsB: string[];
  }): Promise<void> {
    await this.db
      .deleteFrom('entity_links')
      .where('entity_type_a', '=', options.entityTypeA)
      .where('record_id_a', '=', options.recordIdA)
      .where('relation_name', '=', options.relationName)
      .execute();
    for (const recordIdB of options.recordIdsB) {
      await this.linkRecord({
        entityTypeA: options.entityTypeA,
        recordIdA: options.recordIdA,
        relationName: options.relationName,
        entityTypeB: options.entityTypeB,
        recordIdB,
      });
    }
  }

  /** Ids explicitly linked through `entity_links` for a parent record relation. */
  async linkedRecordIds(entity: string, id: string, relationName: string, targetEntity: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('entity_links')
      .select('record_id_b')
      .where('entity_type_a', '=', entity)
      .where('record_id_a', '=', id)
      .where('relation_name', '=', relationName)
      .where('entity_type_b', '=', targetEntity)
      .execute();
    return rows.map((row) => row.record_id_b);
  }

  private async runHooks(record: EntityRecord, previous: Record<string, unknown> | undefined, tx: Queryable): Promise<void> {
    for (const hook of this.hooks) {
      await hook({
        entityType: record.entityType,
        record,
        ...(previous !== undefined ? { previous } : {}),
        ...(record.modifiedById !== undefined ? { userId: record.modifiedById } : {}),
        tx,
      });
    }
  }

  /**
   * Kernel hooks run inside the mutation transaction (docs/module-guide.md). When no
   * hook is registered the statement executes on the pooled connection directly.
   */
  private async withTransaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    if (this.hooks.length === 0) return work(this.db);
    return this.db.transaction().execute(work);
  }
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

type EntityRow = EntityRecordsTable;

function toRow(record: EntityRecord): EntityRecordsTable {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.data)) {
    if (PHYSICAL_KEYS.has(key)) continue;
    if (value === undefined) continue;
    attrs[toCamelCase(key)] = value;
  }

  const teams = toStringArray(record.data['teams']);
  const assigned = record.assignedUserId ?? stringOrUndefined(record.data['assignedUserId']);

  const row: EntityRecordsTable = {
    id: record.id,
    entity_type: record.entityType,
    name: stringOrUndefined(record.data['name']) ?? null,
    attrs: JSON.stringify(attrs),
    assigned_user_id: assigned ?? null,
    created_by_id: record.createdById ?? null,
    modified_by_id: record.modifiedById ?? null,
    team_ids: JSON.stringify(teams),
    created_at: record.createdAt,
    modified_at: record.modifiedAt,
    deleted_at: record.deletedAt ?? null,
    version: record.version,
  };
  return row;
}

function fromRow(row: EntityRow, metadata?: MetadataStoreService): EntityRecord {
  const attrs = asPlainObject(row.attrs);
  const data: Record<string, unknown> = {
    ...attrs,
    id: row.id,
    name: row.name ?? attrs['name'] ?? null,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    teams: toStringArray(row.team_ids),
    version: row.version,
  };
  if (row.assigned_user_id !== null) data['assignedUserId'] = row.assigned_user_id;
  if (row.created_by_id !== null) data['createdById'] = row.created_by_id;
  if (row.modified_by_id !== null) data['modifiedById'] = row.modified_by_id;
  if (row.deleted_at !== null) data['deletedAt'] = row.deleted_at;

  hydrateDates(row.entity_type, data, metadata);

  const record: EntityRecord = {
    id: row.id,
    entityType: row.entity_type,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    version: row.version,
    data,
  };
  if (row.assigned_user_id !== null) record.assignedUserId = row.assigned_user_id;
  if (row.created_by_id !== null) record.createdById = row.created_by_id;
  if (row.modified_by_id !== null) record.modifiedById = row.modified_by_id;
  if (row.deleted_at !== null) record.deletedAt = row.deleted_at;
  return record;
}

/**
 * JSONB keeps temporal values as strings; the engine validator (and any arithmetic)
 * expects `Date` instances for `date`/`datetime` metadata fields.
 */
function hydrateDates(entity: string, data: Record<string, unknown>, metadata?: MetadataStoreService): void {
  if (!metadata) return;
  const fields = metadata.registry.getFields(entity);
  for (const [name, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    const def = fields[name];
    if (!def) continue;
    if (def.type !== 'date' && def.type !== 'datetime') continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) data[name] = parsed;
  }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return isRecord(parsed) ? parsed : {};
}

function toStringArray(value: unknown): string[] {
  const source = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(source)) return [];
  return source.filter((item): item is string => typeof item === 'string');
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function updatedOnce(numUpdatedRows: bigint | undefined): boolean {
  return Number(numUpdatedRows ?? 0) === 1;
}

function clampInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

// ---------------------------------------------------------------------------
// SQL building — parameters only; identifiers come from closed allowlists
// ---------------------------------------------------------------------------

/** Qualified column reference built from the physical column allowlist. */
function col(column: string): RawBuilder<unknown> {
  if (!(PHYSICAL_COLUMNS as readonly string[]).includes(column)) {
    throw new Error(`Illegal physical column "${column}".`);
  }
  return sql.id(TABLE, column);
}

function buildConditions(query: StoreFindQuery): RawBuilder<boolean>[] {
  const out: RawBuilder<boolean>[] = [];
  const translated = query.translated;
  if (translated) {
    for (const filter of translated.filter) out.push(filterSql(filter));
  }
  for (const clause of query.attrsEquals ?? []) {
    out.push(sql<boolean>`${attrText(clause.field)} = ${clause.value}`);
  }
  for (const clause of query.attrsContains ?? []) {
    out.push(sql<boolean>`(attrs -> ${clause.field}::text) @> ${JSON.stringify([clause.value])}::jsonb`);
  }
  const ids = query.ids;
  if (ids !== undefined) {
    out.push(ids.length === 0 ? sql<boolean>`false` : sql<boolean>`${col('id')} in (${sql.join(ids)})`);
  }
  return out;
}

function orderClauses(translated?: TranslatedQuery): RawBuilder<unknown>[] {
  if (!translated || translated.orderBy.length === 0) {
    return [sql`${col('created_at')}`];
  }
  return translated.orderBy.map((clause: OrderClause) => {
    const direction = clause.direction === 'desc' ? sql`desc` : sql`asc`;
    return sql`${leftExpr(clause.ref, clause.fieldType)} ${direction}`;
  });
}

function aclSql(acl?: AclPredicate): RawBuilder<boolean> | undefined {
  if (!acl || acl.kind === 'allowAll') return undefined;
  if (acl.kind === 'denyAll') return sql<boolean>`false`;
  const assigned = sql`${col('assigned_user_id')} = ${acl.userId}`;
  if (acl.kind === 'own') {
    return sql<boolean>`( ${assigned} or ${col('created_by_id')} = ${acl.userId} )`;
  }
  if (acl.teamIds.length === 0) return sql<boolean>`( ${assigned} )`;
  return sql<boolean>`( team_ids ?| cast(${[...acl.teamIds]} as text[]) or ${assigned} or ${col('created_by_id')} = ${acl.userId} )`;
}

function filterSql(filter: QueryFilter): RawBuilder<boolean> {
  if (filter.type === 'criterion') return criterionSql(filter.criterion);
  const separator = filter.op === 'or' ? sql` or ` : sql` and `;
  return sql<boolean>`( ${sql.join(filter.children.map(filterSql), separator)} )`;
}

function criterionSql(criterion: QueryCriterion): RawBuilder<boolean> {
  const left = leftExpr(criterion.ref, criterion.fieldType);
  const value = literalFor(criterion);

  switch (criterion.operator) {
    case 'isNull':
      return sql<boolean>`${left} is null`;
    case 'isNotNull':
      return sql<boolean>`${left} is not null`;
    case 'notEquals':
      return sql<boolean>`${left} is distinct from ${value}`;
    case 'greaterThan':
      return sql<boolean>`${left} > ${value}`;
    case 'greaterThanOrEqual':
      return sql<boolean>`${left} >= ${value}`;
    case 'lessThan':
      return sql<boolean>`${left} < ${value}`;
    case 'lessThanOrEqual':
      return sql<boolean>`${left} <= ${value}`;
    case 'like':
      return sql<boolean>`${left}::text ilike ${`%${String(value ?? '')}%`}`;
    case 'in':
      return sql<boolean>`${left} in (${sql.join(asArray(value))})`;
    case 'notIn':
      return sql<boolean>`${left} not in (${sql.join(asArray(value))})`;
    case 'between': {
      const [first, second] = asArray(value);
      return sql<boolean>`${left} between ${first ?? null} and ${second ?? null}`;
    }
    case 'equals':
    case 'equalsExact':
    default:
      return sql<boolean>`${left} = ${value}`;
  }
}

/**
 * `attrs` values are read as JSON text; metadata-driven casts keep numeric and
 * temporal comparisons/ordering correct. Cast names are produced by this module
 * (`attrCast`), never taken from the request.
 */
function leftExpr(ref: ColumnRef, fieldType?: string): RawBuilder<unknown> {
  if (ref.kind === 'physical') return col(ref.column);
  const extracted = attrText(ref.field);
  const cast = attrCast(fieldType);
  return cast === undefined ? extracted : sql`(${extracted})::${sql.raw(cast)}`;
}

function attrText(field: string): RawBuilder<unknown> {
  return sql`(attrs ->> ${field}::text)`;
}

function attrCast(fieldType?: string): AttrCast | undefined {
  if (!fieldType) return undefined;
  if (NUMERIC_FIELD_TYPES.has(fieldType)) return 'numeric';
  if (DATE_FIELD_TYPES.has(fieldType)) return 'timestamptz';
  return undefined;
}

function literalFor(criterion: QueryCriterion): unknown {
  const value = criterion.value;
  if (criterion.fieldType === 'bool' && typeof value === 'boolean' && criterion.ref.kind === 'attr') {
    return String(value);
  }
  return value;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}
