import { randomUUID } from 'node:crypto';

import type { RecordStorePort } from '@carocrm/entity-engine/entity-manager/index.js';
import type { EntityQuery, EntityRecord, ListResult } from '@carocrm/entity-engine/types/index.js';
import type { ColumnRef, OrderClause, QueryCriterion, QueryFilter, TranslatedQuery } from '@carocrm/query-engine/index.js';
import { columnRef, PHYSICAL_COLUMNS, toCamelCase } from '@carocrm/query-engine/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { OperationNodeSource, RawBuilder } from 'kysely';
import { sql } from 'kysely';

import type { AclPredicate } from '../acl/predicate.js';
import type { Db, DbTx, EntityRecordsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { AfterSaveHook, KernelMutation } from './hooks.js';
import { KERNEL_HOOKS_TOKEN } from './hooks.js';
import { currentTx, withTxContext } from './tx-context.js';

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

export interface StoreReportRelation {
  readonly sourceField: string;
  readonly sourceFieldType: string;
  readonly targetEntity: string;
  readonly targetField: string;
  readonly targetFieldType: string;
  readonly acl: AclPredicate;
}

export interface StoreReportDimension {
  readonly field: string;
  readonly fieldType: string;
  readonly grain?: 'day' | 'month' | 'year' | undefined;
  readonly relation?: StoreReportRelation | undefined;
}

export interface StoreReportMetric {
  readonly name: string;
  readonly operation: 'count' | 'sum' | 'avg' | 'min' | 'max';
  readonly field?: string | undefined;
  readonly fieldType?: string | undefined;
  readonly relation?: StoreReportRelation | undefined;
}

export interface StoreReportAggregateQuery {
  readonly translated: TranslatedQuery;
  readonly acl: AclPredicate;
  readonly dimensions: readonly StoreReportDimension[];
  readonly metrics: readonly StoreReportMetric[];
  readonly maxGroups: number;
}

export interface StoreReportAggregateResult {
  readonly total: number;
  readonly groups: readonly {
    readonly keys: readonly string[];
    readonly count: number;
    readonly metrics: Readonly<Record<string, number | null>>;
  }[];
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

  /**
   * The ambient transaction of a domain command when there is one, otherwise the pooled connection.
   * Every read and write in this store goes through it, so a multi-record command sees its own
   * uncommitted writes instead of a stale snapshot from a second connection.
   */
  private get db(): Queryable {
    return currentTx() ?? this.database.db;
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
      await this.runHooks(record, undefined, tx, 'create');
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

      await this.runHooks(record, this.dataOf(previousRow), tx, 'update');
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
      await this.runHooks(record, this.dataOf(previousRow), tx, 'delete');
      return true;
    });
  }

  /**
   * Clears `deleted_at` and runs the kernel hooks, so a restore is observable through the same
   * transactional path as any other mutation. Returns false when the row is missing or live.
   */
  async restore(entity: string, id: string): Promise<boolean> {
    return this.withTransaction(async (tx) => {
      const previousRow = await tx
        .selectFrom(TABLE)
        .selectAll()
        .where('entity_type', '=', entity)
        .where('id', '=', id)
        .where('deleted_at', 'is not', null)
        .executeTakeFirst();
      if (!previousRow) return false;

      const result = await tx
        .updateTable(TABLE)
        .set({ deleted_at: null, modified_at: new Date() })
        .where('entity_type', '=', entity)
        .where('id', '=', id)
        .where('deleted_at', 'is not', null)
        .executeTakeFirst();
      if (!updatedOnce(result.numUpdatedRows)) return false;

      await this.runHooks(this.mapRow({ ...previousRow, deleted_at: null }), this.dataOf(previousRow), tx, 'restore');
      return true;
    });
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

  /** Exact entity-level aggregation with the same ACL and filter predicates as `findMany`. */
  async aggregateReport(entity: string, query: StoreReportAggregateQuery): Promise<StoreReportAggregateResult> {
    const run = async (tx: Queryable): Promise<StoreReportAggregateResult> => {
      // Bound expensive plans. The value is fixed by the application, not report input.
      await sql`select set_config('statement_timeout', ${'5000ms'}, true)`.execute(tx);
      const acl = aclSql(query.acl);
      const conditions: RawBuilder<boolean>[] = [sql<boolean>`${col('entity_type')} = ${entity}`, sql<boolean>`${col('deleted_at')} is null`];
      if (acl) conditions.push(acl);
      conditions.push(...buildConditions({ translated: query.translated }));
      const fromRelations = reportRelations(query.dimensions, query.metrics).map((relation, index) => ({ relation, alias: `report_relation_${String(index)}` }));
      const relationAlias = (relation: StoreReportRelation | undefined): string | undefined => {
        if (relation === undefined) return undefined;
        const key = reportRelationKey(relation);
        return fromRelations.find((entry) => reportRelationKey(entry.relation) === key)?.alias;
      };
      const joins = fromRelations.map(({ relation, alias }) => {
        const sourceId = leftExprForAlias(TABLE, columnRef(relation.sourceField), relation.sourceFieldType);
        const targetAcl = aclSqlForAlias(relation.acl, alias);
        return sql`left join ${sql.id(TABLE)} as ${sql.id(alias)} on ${sql.id(alias, 'id')} = ${sourceId} and ${sql.id(alias, 'entity_type')} = ${relation.targetEntity} and ${sql.id(alias, 'deleted_at')} is null ${targetAcl ? sql`and ${targetAcl}` : sql``}`;
      });
      const fromAndWhere = sql`from ${sql.id(TABLE)} ${sql.join(joins, sql` `)} where ${sql.join(conditions, sql` and `)}`;
      const countQuery = sql<{ total: string }>`select count(*) as total ${fromAndWhere}`;
      const totalResult = await countQuery.execute(tx);
      const total = Number(totalResult.rows[0]?.total ?? 0);
      const groupExpressions = query.dimensions.map((dimension, index) => reportDimensionSql(dimension, index, relationAlias(dimension.relation)));
      const selections: OperationNodeSource[] = groupExpressions.map((expression, index) => expression.as(`__group_${String(index)}`));
      selections.push(sql`count(*)`.as('__row_count'));
      query.metrics.forEach((metric, index) => {
        selections.push(reportMetricSql(metric, index + query.dimensions.length, relationAlias(metric.relation)).as(`__metric_${String(index)}`));
      });
      // Use SELECT ordinals rather than repeat the expressions: each JSON key is a bind parameter,
      // and Postgres does not recognize `$1` and `$9` as the same GROUP BY expression.
      const groupOrdinals = groupExpressions.map((_, index) => sql.raw(String(index + 1)));
      const groupClause = groupOrdinals.length === 0 ? sql`` : sql`group by ${sql.join(groupOrdinals, sql`, `)} order by ${sql.join(groupOrdinals, sql`, `)}`;
      const querySql = sql<Record<string, unknown>>`select ${sql.join(selections, sql`, `)} ${fromAndWhere} ${groupClause} limit ${query.maxGroups + 1}`;
      const aggregateResult = await querySql.execute(tx);
      const groups = aggregateResult.rows.map((row) => ({
        keys: groupExpressions.map((_, index) => String(row[`__group_${String(index)}`] ?? '(empty)')),
        count: Number(row['__row_count'] ?? 0),
        metrics: Object.fromEntries(query.metrics.map((metric, index) => [metric.name, metric.operation === 'count'
          ? Number(row[`__metric_${String(index)}`] ?? 0)
          : finiteNumberOrNull(row[`__metric_${String(index)}`])])),
      }));
      return { total, groups };
    };
    // Inside a domain command the ambient transaction already provides the snapshot; starting a
    // second one would take a different pool connection and miss the command's own writes.
    const ambient = currentTx();
    if (ambient !== undefined) return run(ambient);
    return this.database.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((tx) => withTxContext(tx, () => run(tx)));
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

  /**
   * Phase 18 portal visibility: whether a record is linked, in either direction, to any of
   * `otherIds` (the portal user's contact/account) through the generic link store.
   */
  async hasLinkBetween(entity: string, id: string, otherIds: readonly string[]): Promise<boolean> {
    if (otherIds.length === 0) return false;
    const row = await this.db
      .selectFrom('entity_links')
      .select('id')
      .where((eb) =>
        eb.or([
          eb.and([
            eb('entity_type_b', '=', entity),
            eb('record_id_b', '=', id),
            eb('record_id_a', 'in', otherIds as string[]),
          ]),
          eb.and([
            eb('entity_type_a', '=', entity),
            eb('record_id_a', '=', id),
            eb('record_id_b', 'in', otherIds as string[]),
          ]),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async runHooks(
    record: EntityRecord,
    previous: Record<string, unknown> | undefined,
    tx: Queryable,
    operation: KernelMutation,
  ): Promise<void> {
    for (const hook of this.hooks) {
      await hook({
        entityType: record.entityType,
        record,
        operation,
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
    const ambient = currentTx();
    if (ambient !== undefined) return work(ambient);
    if (this.hooks.length === 0) return work(this.db);
    return this.database.db.transaction().execute((tx) => withTxContext(tx, () => work(tx)));
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
  if (acl.kind === 'portal') return portalVisibilitySql(acl, (column) => col(column));
  if (acl.kind === 'projectScoped') return projectScopeSql(acl, TABLE);
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
  return sql`(${sql.id(TABLE, 'attrs')} ->> ${field}::text)`;
}

function attrCast(fieldType?: string): AttrCast | undefined {
  if (!fieldType) return undefined;
  if (NUMERIC_FIELD_TYPES.has(fieldType)) return 'numeric';
  if (DATE_FIELD_TYPES.has(fieldType)) return 'timestamptz';
  return undefined;
}

function reportDimensionSql(dimension: StoreReportDimension, _index: number, alias?: string): RawBuilder<unknown> {
  const ref = columnRef(dimension.relation?.targetField ?? dimension.field);
  const value = dimension.relation === undefined
    ? leftExpr(ref, dimension.fieldType)
    : (alias === undefined ? leftExpr(ref, dimension.fieldType) : leftExprForAlias(alias, ref, dimension.fieldType));
  if (dimension.grain !== undefined) {
    const pattern = dimension.grain === 'year' ? 'YYYY' : dimension.grain === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    if (dimension.fieldType === 'date') return sql`to_char((${value})::date, ${pattern})`;
    return sql`to_char((${value})::timestamptz at time zone 'UTC', ${pattern})`;
  }
  if (dimension.fieldType === 'multiEnum' && ref.kind === 'attr' && dimension.relation === undefined) {
    const first = sql`(${col('attrs')} -> ${ref.field}::text ->> 0)`;
    return sql`left(coalesce(nullif(${first}, ''), '(empty)'), 120)`;
  }
  return sql`left(coalesce(nullif((${value})::text, ''), '(empty)'), 120)`;
}

function reportMetricSql(metric: StoreReportMetric, _index: number, alias?: string): RawBuilder<unknown> {
  if (metric.operation === 'count') return sql`count(*)`;
  if (metric.field === undefined || metric.fieldType === undefined) throw new Error(`Metric "${metric.name}" has no validated field.`);
  const rawValue = metric.relation === undefined
    ? leftExpr(columnRef(metric.field), metric.fieldType)
    : (alias === undefined ? leftExpr(columnRef(metric.field), metric.fieldType) : leftExprForAlias(alias, columnRef(metric.relation.targetField), metric.fieldType));
  const value = sql`(${rawValue})::numeric`;
  switch (metric.operation) {
    case 'sum': return sql`coalesce(sum(${value}), 0)`;
    case 'avg': return sql`avg(${value})`;
    case 'min': return sql`min(${value})`;
    case 'max': return sql`max(${value})`;
  }
}

function leftExprForAlias(alias: string, ref: ColumnRef, fieldType?: string): RawBuilder<unknown> {
  if (ref.kind === 'physical') return sql.id(alias, ref.column);
  const extracted = sql`(${sql.id(alias, 'attrs')} ->> ${ref.field}::text)`;
  const cast = attrCast(fieldType);
  return cast === undefined ? extracted : sql`(${extracted})::${sql.raw(cast)}`;
}

function aclSqlForAlias(acl: AclPredicate, alias: string): RawBuilder<boolean> | undefined {
  if (acl.kind === 'allowAll') return undefined;
  if (acl.kind === 'denyAll') return sql<boolean>`false`;
  if (acl.kind === 'portal') return portalVisibilitySql(acl, (column) => sql.id(alias, column));
  if (acl.kind === 'projectScoped') return projectScopeSql(acl, alias);
  const assigned = sql`${sql.id(alias, 'assigned_user_id')} = ${acl.userId}`;
  const creator = sql`${sql.id(alias, 'created_by_id')} = ${acl.userId}`;
  if (acl.kind === 'own') return sql<boolean>`(${assigned} or ${creator})`;
  if (acl.teamIds.length === 0) return sql<boolean>`(${assigned} or ${creator})`;
  return sql<boolean>`(${sql.id(alias, 'team_ids')} ?| cast(${[...acl.teamIds]} as text[]) or ${assigned} or ${creator})`;
}

/**
 * Phase 19 project-scoped access as SQL — the exact mirror of `ProjectPolicyService.allowsScoped`,
 * so a list, a calendar window and a by-id read decide identically. The global own/team scope is
 * kept, and the project's own `ProjectMember` + `ProjectRole` rows are consulted for the same
 * record. Role field names and their allowed values come from the application's allowlist
 * (`projectScopeFor`), never from the request.
 */
function projectScopeSql(acl: Extract<AclPredicate, { kind: 'projectScoped' }>, table: string): RawBuilder<boolean> {
  const attrs = sql.id(table, 'attrs');
  const projectIdOfRecord = acl.projectAttr === 'id' ? sql.id(table, 'id') : sql`(${attrs} ->> ${acl.projectAttr}::text)`;
  const ownerOrAssignee = sql`( (${attrs} ->> 'assigneeUserId'::text) = ${acl.userId} or (${attrs} ->> 'ownerUserId'::text) = ${acl.userId} )`;
  const isCollaborator = sql`exists (
    select 1 from entity_records c
    where c.entity_type = 'ProjectTaskCollaborator' and c.deleted_at is null
      and (c.attrs ->> 'userId') = ${acl.userId} and (c.attrs ->> 'taskId') = ${sql.id(table, 'id')}
  )`;

  const roleClauses: RawBuilder<boolean>[] = [];
  if (acl.roleField === null) {
    // Membership alone is the grant (the member list, the group list, the project itself).
    roleClauses.push(sql<boolean>`true`);
  } else {
    const field = sql`(pr.attrs ->> ${acl.roleField}::text)`;
    if (acl.allValues.length > 0) roleClauses.push(sql<boolean>`${field} = any(cast(${[...acl.allValues]} as text[]))`);
    if (acl.assignedValues.length > 0) {
      roleClauses.push(sql<boolean>`(${field} = any(cast(${[...acl.assignedValues]} as text[])) and ${ownerOrAssignee})`);
    }
    if (acl.ownValues.length > 0) {
      roleClauses.push(sql<boolean>`(${field} = any(cast(${[...acl.ownValues]} as text[])) and (${ownerOrAssignee} or ${isCollaborator}))`);
    }
  }
  const roleCondition = roleClauses.length === 0 ? sql<boolean>`false` : sql<boolean>`( ${sql.join(roleClauses, sql` or `)} )`;

  const memberOf = (extra: RawBuilder<boolean>): RawBuilder<boolean> => sql`exists (
    select 1 from entity_records pm
    left join entity_records pr on pr.id = (pm.attrs ->> 'projectRoleId') and pr.entity_type = 'ProjectRole' and pr.deleted_at is null
    where pm.entity_type = 'ProjectMember' and pm.deleted_at is null
      and (pm.attrs ->> 'userId') = ${acl.userId}
      and (pm.attrs ->> ${acl.projectAttr}::text) = ${projectIdOfRecord}
      and ${extra}
  )`;

  const assigned = sql`${sql.id(table, 'assigned_user_id')} = ${acl.base.userId}`;
  const created = sql`${sql.id(table, 'created_by_id')} = ${acl.base.userId}`;
  const teams =
    acl.base.kind === 'own' || acl.base.teamIds.length === 0
      ? sql``
      : sql`${sql.id(table, 'team_ids')} ?| cast(${[...acl.base.teamIds]} as text[]) or `;
  const base = sql<boolean>`( ${teams}${assigned} or ${created} )`;

  // A member is judged by their project role — which NARROWS what the global scope would allow, and
  // is what lets a member reach a colleague's task. A non-member keeps the global scope untouched.
  // Mirror of `ProjectPolicyService.allowsScoped`.
  return sql<boolean>`( ( not ${memberOf(sql<boolean>`true`)} and ${base} ) or ${memberOf(roleCondition)} )`;
}

/**
 * Phase 18 portal record visibility as SQL — the exact mirror of
 * `PortalPolicyService.recordVisible`, so a list and a by-id read decide identically:
 * the record IS the contact/account, carries a Contact/Account link attribute to it, or is
 * linked through `entity_links` in either direction. Without a contact or account the
 * predicate is `false`, never "allow".
 */
function portalVisibilitySql(
  acl: Extract<AclPredicate, { kind: 'portal' }>,
  column: (name: string) => RawBuilder<unknown>,
): RawBuilder<boolean> {
  const ids = [acl.contactId, acl.accountId].filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return sql<boolean>`false`;
  const clauses: RawBuilder<boolean>[] = ids.map((id) => sql<boolean>`${column('id')} = ${id}`);
  for (const link of acl.linkFields) {
    const attrs = column('attrs');
    for (const id of ids) {
      if (link.multiple) {
        clauses.push(sql<boolean>`(${attrs} -> ${link.field}::text) @> ${JSON.stringify([id])}::jsonb`);
      } else {
        clauses.push(sql<boolean>`(${attrs} ->> ${link.field}::text) = ${id}`);
      }
    }
  }
  clauses.push(sql<boolean>`exists (
    select 1 from entity_links l
    where l.record_id_b = ${column('id')} and l.entity_type_b = ${acl.entity} and l.record_id_a in (${sql.join(ids)})
  )`);
  clauses.push(sql<boolean>`exists (
    select 1 from entity_links l
    where l.record_id_a = ${column('id')} and l.entity_type_a = ${acl.entity} and l.record_id_b in (${sql.join(ids)})
  )`);
  return sql<boolean>`( ${sql.join(clauses, sql` or `)} )`;
}

function reportRelationKey(relation: StoreReportRelation): string {
  return `${relation.sourceField}:${relation.targetEntity}`;
}

function reportRelations(dimensions: readonly StoreReportDimension[], metrics: readonly StoreReportMetric[]): StoreReportRelation[] {
  const byKey = new Map<string, StoreReportRelation>();
  for (const relation of [...dimensions.map((dimension) => dimension.relation), ...metrics.map((metric) => metric.relation)]) {
    if (relation === undefined) continue;
    const key = reportRelationKey(relation);
    if (!byKey.has(key)) byKey.set(key, relation);
  }
  return [...byKey.values()];
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
