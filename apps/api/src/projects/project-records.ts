import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';

/** One loaded record: its id, its optimistic-lock version and its unserialised attributes. */
export interface ProjectRow {
  readonly id: string;
  readonly version: number;
  readonly data: Record<string, unknown>;
}

/**
 * Structural reads for the Projects domain services.
 *
 * Everything a *user* sees goes through `EntityCrudService` so record-level ACL, field masking and
 * serialisation stay in one place. This service answers the different question a domain command
 * asks — "does this stage belong to this board?", "is this group in this project?" — which is
 * metadata-level validation, not data disclosure, and must not silently return nothing just
 * because the caller cannot read the referenced record.
 *
 * Every value is a bind parameter and every identifier is validated before it is interpolated, so
 * no untrusted name reaches the SQL (§5.2 of AGENTS.MD).
 */
@Injectable()
export class ProjectRecords {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Inside a domain command this service reads the command's own transaction, or a validation
   * would be decided from a snapshot that does not contain the rows the command just wrote. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  async byId(entity: string, id: string): Promise<ProjectRow | undefined> {
    const rows = await sql<ProjectRowShape>`
      select id, version, name, attrs from entity_records
      where entity_type = ${entity} and id = ${id} and deleted_at is null
      limit 1
    `.execute(this.db);
    const row = rows.rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  async byIds(entity: string, ids: readonly string[]): Promise<ProjectRow[]> {
    if (ids.length === 0) return [];
    const rows = await sql<ProjectRowShape>`
      select id, version, name, attrs from entity_records
      where entity_type = ${entity} and deleted_at is null and id in (${sql.join(ids)})
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /**
   * Equality lookup over `attrs` text values. `filters` keys are attribute names produced by this
   * module (never a request field name), values are bind parameters.
   */
  async find(entity: string, filters: Readonly<Record<string, string | readonly string[]>>): Promise<ProjectRow[]> {
    return this.query(entity, filters, false);
  }

  /** Same lookup, ordered by the integer `sortOrder` attribute with a stable id tie-breaker. */
  async findOrdered(entity: string, filters: Readonly<Record<string, string | readonly string[]>>): Promise<ProjectRow[]> {
    return this.query(entity, filters, true);
  }

  private async query(entity: string, filters: Readonly<Record<string, string | readonly string[]>>, ordered: boolean): Promise<ProjectRow[]> {
    const clauses = [sql<boolean>`entity_type = ${entity}`, sql<boolean>`deleted_at is null`];
    for (const [field, value] of Object.entries(filters)) {
      attrKey(field);
      if (Array.isArray(value)) {
        if (value.length === 0) return [];
        clauses.push(sql<boolean>`(attrs ->> ${field}::text) in (${sql.join(value.map((item) => sql`${item}`))})`);
      } else {
        clauses.push(sql<boolean>`(attrs ->> ${field}::text) = ${value}`);
      }
    }
    const order = ordered ? sql`order by ((attrs ->> 'sortOrder')::int) asc nulls last, id asc` : sql`order by id asc`;
    const rows = await sql<ProjectRowShape>`
      select id, version, name, attrs from entity_records where ${sql.join(clauses, sql` and `)} ${order}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Ids of every live row of an entity matching one attribute equality — cheap existence checks. */
  async idsMatching(entity: string, field: string, value: string): Promise<string[]> {
    attrKey(field);
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = ${entity} and deleted_at is null and (attrs ->> ${field}::text) = ${value}
    `.execute(this.db);
    return rows.rows.map((row) => row.id);
  }
}

interface ProjectRowShape {
  id: string;
  version: number;
  name: string | null;
  attrs: unknown;
}

/**
 * Attribute names this module may filter on. The name is validated here and then bound as a JSON
 * key, so it can never become an identifier; anything malformed is a programming error, not data.
 */
function attrKey(field: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]{0,48}$/.test(field)) throw new Error(`Illegal attribute name "${field}".`);
}

function toRow(row: ProjectRowShape): ProjectRow {
  const data = toData(row.attrs);
  // `name` is a physical column, exactly like the Entity Engine's own record mapping, so a service
  // reading a row sees the same shape the API returns.
  if (data['name'] === undefined) data['name'] = row.name ?? null;
  return { id: row.id, version: row.version, data };
}

function toData(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
