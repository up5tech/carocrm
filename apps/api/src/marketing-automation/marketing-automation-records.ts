import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { currentTx } from "../entity/tx-context.js";
import {
  CAMPAIGN_ENTITY,
  MARKETING_AUTOMATION_ENTITY_TYPES,
  type MarketingAutomationEntityType,
} from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.3 — structural reads for the Marketing Automation domain services.
 *
 * Everything a *user* sees goes through `EntityCrudService`, so record-level ACL, field masking and
 * serialisation stay in one place. This service answers the different question a domain command asks:
 * "give me the stored row exactly as it is, inside my own transaction, before I decide whether the actor may
 * act on it". A lifecycle command must read the true current `status` and `version` — not an ACL-filtered
 * projection — because the transition check and the optimistic-concurrency check are both made against the
 * stored row, and a stale read is how a duplicate transition happens (§5.1, §8.4).
 *
 * Identifiers stay on an allowlist and every value is a bind parameter, so no request value can become an
 * SQL identifier (AGENTS.md §5.2). Mirrors `ServiceDeskRecords` and `CustomerSuccessRecords` deliberately.
 */

export interface MarketingRow {
  readonly id: string;
  readonly entityType: string;
  readonly version: number;
  readonly name: string | null;
  readonly data: Record<string, unknown>;
}

@Injectable()
export class MarketingAutomationRecords {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Inside a domain command this service reads the command's own transaction. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  async byId(entity: MarketingAutomationEntityType, id: string): Promise<MarketingRow | undefined> {
    if (!isMarketingEntityType(entity)) return undefined;
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where entity_type = ${entity} and id = ${id} and deleted_at is null
      limit 1
    `.execute(this.db);
    const row = rows.rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  /**
   * Live rows of one owned entity matching a single `attrs` equality, bounded. Used for membership and
   * reference lookups; the field name is validated, never interpolated from a request.
   */
  async findByAttr(
    entity: MarketingAutomationEntityType,
    field: string,
    value: string,
    options: { readonly limit?: number } = {},
  ): Promise<MarketingRow[]> {
    if (!isMarketingEntityType(entity)) return [];
    attrKey(field);
    const limit = options.limit ?? 2_000;
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where entity_type = ${entity}
        and deleted_at is null
        and (attrs ->> ${field}::text) = ${value}
      order by created_at asc, id asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /**
   * True when the id names a live sending account. The campaign author must know a sender exists to be
   * told their campaign can send, but must not be shown its address, name or credentials — the platform's
   * own `EmailAccountsService.get/list` are administrator-only, so this reads existence and nothing else.
   */
  async emailAccountExists(id: string): Promise<boolean> {
    const rows = await sql<{ id: string }>`
      select id
      from email_accounts
      where id = ${id} and is_deleted = false
      limit 1
    `.execute(this.db);
    return rows.rows.length > 0;
  }

  /** The deployment's default sending account id, or null. Identity only — no address, no credentials. */
  async defaultEmailAccountId(): Promise<string | null> {
    const rows = await sql<{ id: string }>`
      select id
      from email_accounts
      where is_deleted = false and is_default = true
      order by created_at asc
      limit 1
    `.execute(this.db);
    return rows.rows[0]?.id ?? null;
  }

  /**
   * Equality lookup over several `attrs` text values at once — the shape the consent and suppression
   * lookups need (`emailHash` × `channel` × `purpose`). Field names are validated and values are bound, so
   * no request value can become an identifier (AGENTS.md §5.2).
   */
  async findByAttrs(
    entity: MarketingAutomationEntityType,
    filters: Readonly<Record<string, string>>,
    options: { readonly limit?: number } = {},
  ): Promise<MarketingRow[]> {
    if (!isMarketingEntityType(entity)) return [];
    const clauses = [sql<boolean>`entity_type = ${entity}`, sql<boolean>`deleted_at is null`];
    for (const [field, value] of Object.entries(filters)) {
      attrKey(field);
      clauses.push(sql<boolean>`(attrs ->> ${field}::text) = ${value}`);
    }
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where ${sql.join(clauses, sql` and `)}
      order by created_at asc, id asc
      limit ${options.limit ?? 2_000}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /**
   * One read for many values of a single attribute — the bulk form the audience resolver needs, so a
   * 10,000-recipient preview is a handful of queries rather than 10,000 (§5.2 "enforce query cost/time
   * limits"). Values are bind parameters; the field name is validated.
   */
  async findByAttrIn(
    entity: MarketingAutomationEntityType,
    field: string,
    values: readonly string[],
    options: { readonly limit?: number } = {},
  ): Promise<MarketingRow[]> {
    if (!isMarketingEntityType(entity) || values.length === 0) return [];
    attrKey(field);
    const list = sql.join(values.map((value) => sql`${value}`));
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where entity_type = ${entity}
        and deleted_at is null
        and (attrs ->> ${field}::text) in (${list})
      order by created_at asc, id asc
      limit ${options.limit ?? 5_000}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /**
   * The ids linked to a record through a relation, read structurally.
   *
   * A domain command needs the *composition* before it can decide whether the caller may see it: a
   * campaign's audience is stored as relation links, and the ACL-filtered view of them (`related()`)
   * silently omits what the caller cannot read. Comparing the two is how the module can say "your audience
   * has a list you are not allowed to use" instead of pretending the audience is empty (§9.2).
   */
  async linkedRecordIds(
    entity: MarketingAutomationEntityType,
    id: string,
    relationName: string,
  ): Promise<string[]> {
    if (!isMarketingEntityType(entity)) return [];
    if (!/^[A-Za-z][A-Za-z0-9]{0,64}$/.test(relationName)) {
      throw new Error(`Illegal Marketing relation name "${relationName}".`);
    }
    const rows = await sql<{ record_id_b: string }>`
      select record_id_b
      from entity_links
      where entity_type_a = ${entity} and record_id_a = ${id} and relation_name = ${relationName}
      order by created_at asc, record_id_b asc
      limit 200
    `.execute(this.db);
    return rows.rows.map((row) => row.record_id_b);
  }

  /** True when a campaign code is already used by a live campaign — the invariant migration 037 enforces. */
  async campaignCodeTaken(code: string, exceptId?: string): Promise<boolean> {
    const rows = await sql<{ id: string }>`
      select id
      from entity_records
      where entity_type = ${CAMPAIGN_ENTITY}
        and deleted_at is null
        and lower(trim(attrs ->> 'code')) = lower(trim(${code}))
        ${exceptId !== undefined ? sql`and id <> ${exceptId}` : sql``}
      limit 1
    `.execute(this.db);
    return rows.rows.length > 0;
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

function toRow(row: RowShape): MarketingRow {
  const data = isRecord(row.attrs) ? { ...row.attrs } : {};
  if (data["name"] === undefined) data["name"] = row.name;
  // Physical columns are merged under their API names so an ACL evaluation sees the same shape the record
  // store serialises (assigned owner, creator, team sharing).
  if (data["assignedUserId"] === undefined) data["assignedUserId"] = row.assigned_user_id;
  if (data["createdById"] === undefined) data["createdById"] = row.created_by_id;
  if (data["teams"] === undefined) data["teams"] = Array.isArray(row.team_ids) ? row.team_ids : [];
  return { id: row.id, entityType: row.entity_type, version: row.version, name: row.name, data };
}

function isMarketingEntityType(value: string): value is MarketingAutomationEntityType {
  return (MARKETING_AUTOMATION_ENTITY_TYPES as readonly string[]).includes(value);
}

function attrKey(field: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]{0,48}$/.test(field)) {
    throw new Error(`Illegal Marketing attribute name "${field}".`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
