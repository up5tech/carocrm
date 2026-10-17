import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { currentTx } from "../entity/tx-context.js";
import { CUSTOMER_SUCCESS_ENTITY_TYPES } from "./customer-success-internal.js";

/**
 * Entities this service may read structurally: the Customer Success entities it owns plus the small
 * set of core/optional records the signal providers summarise (never a general-purpose bypass).
 */
export const CUSTOMER_SUCCESS_READABLE_ENTITIES = [
  ...CUSTOMER_SUCCESS_ENTITY_TYPES,
  "Account",
  "Contact",
  "Subscription",
  "Opportunity",
  "Project",
  "ProjectTask",
  "Task",
  "Call",
  "Meeting",
  "Email",
  "Case",
] as const;

export type ReadableEntity = (typeof CUSTOMER_SUCCESS_READABLE_ENTITIES)[number];

/** One loaded record: its id, its entity type, its version and its unserialised attributes. */
export interface CustomerSuccessRow {
  readonly id: string;
  readonly entityType: string;
  readonly version: number;
  readonly name: string | null;
  readonly data: Record<string, unknown>;
}

/**
 * Structural reads for the Customer Success domain services.
 *
 * Everything a *user* sees goes through `EntityCrudService` so record-level ACL, field masking and
 * serialisation stay in one place. This service answers the different question a domain command or a
 * system calculation asks — "which open risks does this profile carry?", "which activities link to
 * this account?", "does this profile already exist for this account?" — which is metadata-level
 * validation and summary collection, not per-record disclosure.
 *
 * Identifiers are checked against an allowlist, attribute names against a pattern, and every value is
 * a bind parameter, so no request value can become an identifier (AGENTS.md §5.2).
 */
@Injectable()
export class CustomerSuccessRecords {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Inside a domain command this service reads the command's own transaction. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  async byId(entity: ReadableEntity, id: string): Promise<CustomerSuccessRow | undefined> {
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${entity} and id = ${id} and deleted_at is null
      limit 1
    `.execute(this.db);
    const row = rows.rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  async byIds(entity: ReadableEntity, ids: readonly string[]): Promise<CustomerSuccessRow[]> {
    if (ids.length === 0) return [];
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${entity} and deleted_at is null and id in (${sql.join(ids)})
      order by id asc
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Equality lookup over `attrs` text values, with an optional bounded row limit. */
  async find(
    entity: ReadableEntity,
    filters: Readonly<Record<string, string | readonly string[]>>,
    options: { readonly limit?: number; readonly orderBy?: string } = {},
  ): Promise<CustomerSuccessRow[]> {
    const clauses = [sql<boolean>`entity_type = ${entity}`, sql<boolean>`deleted_at is null`];
    for (const [field, value] of Object.entries(filters)) {
      attrKey(field);
      if (Array.isArray(value)) {
        if (value.length === 0) return [];
        clauses.push(
          sql<boolean>`(attrs ->> ${field}::text) in (${sql.join(value.map((item) => sql`${item}`))})`,
        );
      } else {
        clauses.push(sql<boolean>`(attrs ->> ${field}::text) = ${value}`);
      }
    }
    const order = orderClause(options.orderBy);
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where ${sql.join(clauses, sql` and `)}
      ${order}
      limit ${options.limit ?? 2_000}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Ids of every live row of an entity matching one attribute equality — cheap existence checks. */
  async idsMatching(entity: ReadableEntity, field: string, value: string): Promise<string[]> {
    attrKey(field);
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = ${entity} and deleted_at is null and (attrs ->> ${field}::text) = ${value}
      order by id asc
    `.execute(this.db);
    return rows.rows.map((row) => row.id);
  }

  /** Ids of live rows of an entity whose attribute is in one of `values`. */
  async idsMatchingAny(
    entity: ReadableEntity,
    field: string,
    values: readonly string[],
  ): Promise<string[]> {
    if (values.length === 0) return [];
    attrKey(field);
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = ${entity} and deleted_at is null
        and (attrs ->> ${field}::text) in (${sql.join(values.map((value) => sql`${value}`))})
      order by id asc
    `.execute(this.db);
    return rows.rows.map((row) => row.id);
  }

  /**
   * Account ids of the live Contacts that belong to `accountId`. Used to widen customer-linked
   * activity lookups to the account's contacts (§5.10).
   */
  async contactIdsForAccount(accountId: string): Promise<string[]> {
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = 'Contact' and deleted_at is null and (attrs ->> 'accountId') = ${accountId}
      order by id asc
      limit 500
    `.execute(this.db);
    return rows.rows.map((row) => row.id);
  }

  /**
   * Live activities linked to an account directly or through one of its contacts (§5.10). Only the
   * four activity entities are considered, and the relation names are fixed literals — the account
   * id is the only bound value.
   */
  async linkedActivitiesForAccount(
    accountId: string,
    contactIds: readonly string[],
  ): Promise<CustomerSuccessRow[]> {
    const targets = sql.join(
      [sql`(entity_type_b = 'Account' and record_id_b = ${accountId})`].concat(
        contactIds.length === 0
          ? []
          : [
              sql`(entity_type_b = 'Contact' and record_id_b in (${sql.join(
                contactIds.map((id) => sql`${id}`),
              )}))`,
            ],
      ),
      sql` or `,
    );
    const rows = await sql<RowShape>`
      select er.id, er.entity_type, er.version, er.name, er.attrs
      from entity_links el
      join entity_records er
        on er.id = el.record_id_a and er.entity_type = el.entity_type_a
      where el.relation_name in ('accounts', 'contacts')
        and (${targets})
        and er.entity_type in ('Task', 'Call', 'Meeting', 'Email')
        and er.deleted_at is null
      order by er.id asc
      limit 500
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Live records of an arbitrary allow-listed entity type, ordered by id. Used by the optional adapters. */
  async allLive(entity: ReadableEntity, limit = 2_000): Promise<CustomerSuccessRow[]> {
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${entity} and deleted_at is null
      order by id asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }
}

interface RowShape {
  id: string;
  entity_type: string;
  version: number;
  name: string | null;
  attrs: unknown;
}

const PHYSICAL_NAME = "name";

function toRow(row: RowShape): CustomerSuccessRow {
  const data = isRecord(row.attrs) ? { ...row.attrs } : {};
  if (data[PHYSICAL_NAME] === undefined) data[PHYSICAL_NAME] = row.name;
  return {
    id: row.id,
    entityType: row.entity_type,
    version: row.version,
    name: row.name,
    data,
  };
}

const ENTITY_SET: ReadonlySet<string> = new Set(CUSTOMER_SUCCESS_READABLE_ENTITIES);

export function isReadableEntity(value: string): value is ReadableEntity {
  return ENTITY_SET.has(value);
}

export function requireReadableEntity(value: string): ReadableEntity {
  if (!isReadableEntity(value)) {
    throw new Error(`"${value}" is not a Customer Success-readable entity.`);
  }
  return value;
}

function attrKey(field: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]{0,48}$/.test(field)) {
    throw new Error(`Illegal Customer Success attribute name "${field}".`);
  }
}

function orderClause(orderBy: string | undefined) {
  if (orderBy === undefined) return sql`order by id asc`;
  attrKey(orderBy);
  return sql`order by ((attrs ->> ${orderBy}::text)) asc nulls last, id asc`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
