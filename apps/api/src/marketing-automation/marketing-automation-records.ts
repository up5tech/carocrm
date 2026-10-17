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
