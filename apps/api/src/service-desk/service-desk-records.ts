import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { currentTx } from "../entity/tx-context.js";
import { CASE_ACTIVE_STATUSES } from "./service-desk-domain.js";

/**
 * Phase 19-SD.4/SD.5 — structural reads for the Service Desk domain services
 * (PLAN_Phase_19_ServiceDesk.md §5.3, §6.1).
 *
 * Everything a *user* sees goes through `EntityCrudService`, so record-level ACL, field masking and
 * serialisation stay in one place. This service answers the different, metadata-level questions a
 * domain command asks — "which agents are eligible for this queue?", "how busy is each of them?",
 * "which rules apply, in what order?" — and keeps identifiers on an allowlist and values as bind
 * parameters, so no request value can become an identifier (AGENTS.md §5.2). It mirrors
 * `CustomerSuccessRecords` and `ProjectRecords` deliberately.
 */

export const SERVICE_DESK_READABLE_ENTITIES = [
  "Case",
  "CaseQueue",
  "QueueMember",
  "RoutingRule",
  "CaseTransition",
  "CaseAssignment",
  "Account",
  "Contact",
  "Lead",
] as const;

export type ServiceDeskReadableEntity = (typeof SERVICE_DESK_READABLE_ENTITIES)[number];

export interface ServiceDeskRow {
  readonly id: string;
  readonly entityType: string;
  readonly version: number;
  readonly name: string | null;
  readonly data: Record<string, unknown>;
}

@Injectable()
export class ServiceDeskRecords {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Inside a domain command this service reads the command's own transaction. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  async byId(entity: ServiceDeskReadableEntity, id: string): Promise<ServiceDeskRow | undefined> {
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where entity_type = ${entity} and id = ${id} and deleted_at is null
      limit 1
    `.execute(this.db);
    const row = rows.rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  /** Equality lookup over `attrs` text values, with a bounded row limit. */
  async find(
    entity: ServiceDeskReadableEntity,
    filters: Readonly<Record<string, string>>,
    options: { readonly limit?: number } = {},
  ): Promise<ServiceDeskRow[]> {
    const clauses = [sql<boolean>`entity_type = ${entity}`, sql<boolean>`deleted_at is null`];
    for (const [field, value] of Object.entries(filters)) {
      attrKey(field);
      clauses.push(sql<boolean>`(attrs ->> ${field}::text) = ${value}`);
    }
    // Ordered by insertion (`created_at`) so a history list reads oldest-first even when two rows
    // share a millisecond and record ids are random. `created_at` defaults to `now()` (transaction
    // start), which differs between the transactions each command runs in.
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where ${sql.join(clauses, sql` and `)}
      order by created_at asc, id asc
      limit ${options.limit ?? 2_000}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** One configured entity ordered by a numeric attribute (queue `sortOrder`, rule priority). */
  async findOrdered(
    entity: ServiceDeskReadableEntity,
    filters: Readonly<Record<string, string>>,
    orderField: string,
    options: { readonly limit?: number } = {},
  ): Promise<ServiceDeskRow[]> {
    attrKey(orderField);
    const rows = await this.find(entity, filters, options);
    return [...rows].sort((left, right) => {
      const a = numeric(left.data[orderField]);
      const b = numeric(right.data[orderField]);
      if (a !== b) return a - b;
      return left.id.localeCompare(right.id);
    });
  }

  /**
   * Live, active internal users from the identity table. A `User` is an identity row, not a metadata
   * entity, so eligibility is read from its own table.
   */
  async activeUserIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.database.db
      .selectFrom("users")
      .select("id")
      .where("id", "in", [...ids])
      .where("is_active", "=", true)
      .where("is_deleted", "=", false)
      .where("type", "in", ["regular", "admin"])
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  /** Member user ids of a Team, from the authoritative `users_teams` membership table. */
  async teamMemberIds(teamId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectFrom("users_teams")
      .select("user_id")
      .where("team_id", "=", teamId)
      .execute();
    return rows.map((row) => row.user_id);
  }

  /** The teams a user belongs to, used to authorise assignment within an allowed scope (§10.2). */
  async userTeamIds(userId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectFrom("users_teams")
      .select("team_id")
      .where("user_id", "=", userId)
      .execute();
    return rows.map((row) => row.team_id);
  }

  /**
   * The users following a record, from the kernel subscription table (§5.4 conversation recipients).
   * `entityType` is a bind parameter, never an identifier, so the value cannot become SQL.
   */
  async followerIds(entityType: string, entityId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectFrom("stream_followers")
      .select("user_id")
      .where("entity_type", "=", entityType)
      .where("entity_id", "=", entityId)
      .execute();
    return rows.map((row) => row.user_id);
  }

  /**
   * How many active cases each of `userIds` currently owns. Status is an `attrs` value, the assignee
   * is the physical column; the status list is fixed literals, so only ids are bound parameters.
   */
  async activeCaseCounts(userIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (userIds.length === 0) return counts;
    const statuses = sql.join(CASE_ACTIVE_STATUSES.map((status) => sql`${status}`));
    const rows = await sql<{ assignee: string; total: string }>`
      select assigned_user_id as assignee, count(*)::text as total
      from entity_records
      where entity_type = 'Case' and deleted_at is null
        and assigned_user_id in (${sql.join(userIds.map((id) => sql`${id}`))})
        and (attrs ->> 'status') in (${statuses})
      group by assigned_user_id
    `.execute(this.db);
    for (const row of rows.rows) counts.set(row.assignee, Number(row.total));
    return counts;
  }

  /** How many still-active cases sit in a queue without an owner — the backlog the routing must not drop. */
  async countUnassignedInQueue(queueId: string): Promise<number> {
    const statuses = sql.join(CASE_ACTIVE_STATUSES.map((status) => sql`${status}`));
    const rows = await sql<{ total: string }>`
      select count(*)::text as total
      from entity_records
      where entity_type = 'Case' and deleted_at is null
        and assigned_user_id is null
        and (attrs ->> 'queueId') = ${queueId}
        and (attrs ->> 'status') in (${statuses})
    `.execute(this.db);
    return Number(rows.rows[0]?.total ?? "0");
  }
}

interface RowShape {
  id: string;
  entity_type: string;
  version: number;
  name: string | null;
  attrs: unknown;
  assigned_user_id: string | null;
  created_by_id: string | null;
  team_ids: unknown;
}

function toRow(row: RowShape): ServiceDeskRow {
  const data = isRecord(row.attrs) ? { ...row.attrs } : {};
  if (data["name"] === undefined) data["name"] = row.name;
  // Physical columns are merged under their API names so an ACL evaluation sees the same shape the
  // record store serialises (assigned owner, creator, team sharing).
  if (data["assignedUserId"] === undefined) data["assignedUserId"] = row.assigned_user_id;
  if (data["createdById"] === undefined) data["createdById"] = row.created_by_id;
  if (data["teams"] === undefined) data["teams"] = Array.isArray(row.team_ids) ? row.team_ids : [];
  return { id: row.id, entityType: row.entity_type, version: row.version, name: row.name, data };
}

function attrKey(field: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]{0,48}$/.test(field)) {
    throw new Error(`Illegal Service Desk attribute name "${field}".`);
  }
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
