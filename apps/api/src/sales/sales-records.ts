import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { currentTx } from "../entity/tx-context.js";

/**
 * Structural reads for the Sales domain services.
 *
 * The same split the Projects module uses (`project-records.ts`): everything a *user* sees goes
 * through `EntityCrudService`, so record ACL, field masking, audit and serialization stay in one
 * place. The domain services ask a different question — "which price entries apply to this product
 * on this date?", "which tax rule outranks this one?" — which is metadata-level validation and must
 * not silently return nothing just because the caller cannot read a referenced record. Those reads
 * go here, over the module's **own** entity types, with every value bound as a parameter.
 *
 * Entity names and attribute names are checked against an allowlist before they reach SQL, so no
 * request value can become an identifier (AGENTS.md §5.2).
 */

export interface SalesRow {
  readonly id: string;
  readonly version: number;
  readonly name: string | null;
  readonly data: Record<string, unknown>;
}

/** Entity types this module owns; nothing else may be read through here. */
export const SALES_ENTITY_TYPES = [
  // 19-S.3 – 19-S.5: catalog, pricing and tax master data.
  "Product",
  "ProductCategory",
  "PriceBook",
  "PriceBookEntry",
  "PriceRule",
  "Supplier",
  "SupplierProductPrice",
  "TaxClass",
  "TaxCode",
  "TaxRate",
  "TaxRule",
  // 19-S.6 – 19-S.12: commercial documents and their child line items.
  "Quote",
  "QuoteItem",
  "SalesOrder",
  "SalesOrderItem",
  "Invoice",
  "InvoiceItem",
  "CreditNote",
  "CreditNoteItem",
  "DeliveryOrder",
  "DeliveryOrderItem",
  "ReturnOrder",
  "ReturnOrderItem",
  // 19-S.13: the purchasing half, and the correction record a bill credit allocates to a bill.
  "PurchaseOrder",
  "PurchaseOrderItem",
  "ReceiptOrder",
  "ReceiptOrderItem",
  "Bill",
  "BillItem",
  "BillCredit",
  "BillCreditItem",
  "BillCreditAllocation",
  // 19-S.6: the payment-term policy a document can reference.
  "PaymentTermProfile",
  // 19-S.10 – 19-S.11: money received/sent, and the records that adjust a balance.
  "PaymentMethod",
  "PaymentChannel",
  "Payment",
  "PaymentAllocation",
  "PaymentTransferAllocation",
  "PaymentRequest",
  "PaymentProviderEventLog",
  "CreditNoteAllocation",
  "WriteOff",
] as const;

export type SalesEntityType = (typeof SALES_ENTITY_TYPES)[number];

const ENTITY_SET: ReadonlySet<string> = new Set(SALES_ENTITY_TYPES);
const ATTRIBUTE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,48}$/;

/** Hard ceiling for an unbounded-looking structural read; callers paginate beyond it. */
export const SALES_STRUCTURAL_SCAN_LIMIT = 2_000;

export function isSalesEntityType(value: string): value is SalesEntityType {
  return ENTITY_SET.has(value);
}

@Injectable()
export class SalesRecords {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** A domain command reads its own transaction; without one, the pooled connection. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  async byId(
    entity: SalesEntityType,
    id: string,
  ): Promise<SalesRow | undefined> {
    const rows = await sql<SalesRowShape>`
      select id, version, name, attrs from entity_records
      where entity_type = ${entity} and id = ${id} and deleted_at is null
      limit 1
    `.execute(this.db);
    const row = rows.rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  async byIds(
    entity: SalesEntityType,
    ids: readonly string[],
  ): Promise<SalesRow[]> {
    if (ids.length === 0) return [];
    const rows = await sql<SalesRowShape>`
      select id, version, name, attrs from entity_records
      where entity_type = ${entity} and deleted_at is null and id in (${sql.join(ids)})
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Equality over `attrs` text values; keys are validated, values are bound. */
  async find(
    entity: SalesEntityType,
    filters: Readonly<Record<string, string>>,
    limit = SALES_STRUCTURAL_SCAN_LIMIT,
  ): Promise<SalesRow[]> {
    const clauses = [
      sql<boolean>`entity_type = ${entity}`,
      sql<boolean>`deleted_at is null`,
    ];
    for (const [field, value] of Object.entries(filters)) {
      attributeKey(field);
      clauses.push(sql<boolean>`(attrs ->> ${field}::text) = ${value}`);
    }
    const rows = await sql<SalesRowShape>`
      select id, version, name, attrs from entity_records
      where ${sql.join(clauses, sql` and `)}
      order by id asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /**
   * Every live row of `entity` whose `field` holds one of `values` — a single query for a list page,
   * so loading the items of many documents never becomes one query per document (§16.1).
   */
  async findByIdsIn(
    entity: SalesEntityType,
    field: string,
    values: readonly string[],
    limit = SALES_STRUCTURAL_SCAN_LIMIT,
  ): Promise<SalesRow[]> {
    if (values.length === 0) return [];
    attributeKey(field);
    const rows = await sql<SalesRowShape>`
      select id, version, name, attrs from entity_records
      where entity_type = ${entity} and deleted_at is null and (attrs ->> ${field}::text) in (${sql.join(values)})
      order by id asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Case-insensitive equality — the shape a SKU/code lookup needs. */
  async findByCode(
    entity: SalesEntityType,
    field: string,
    value: string,
    limit = 10,
  ): Promise<SalesRow[]> {
    attributeKey(field);
    const rows = await sql<SalesRowShape>`
      select id, version, name, attrs from entity_records
      where entity_type = ${entity} and deleted_at is null and lower(attrs ->> ${field}::text) = ${value.trim().toLowerCase()}
      order by id asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Every live row of a module-owned entity, bounded. Used by price/tax resolution. */
  async allLive(
    entity: SalesEntityType,
    limit = SALES_STRUCTURAL_SCAN_LIMIT,
  ): Promise<SalesRow[]> {
    const rows = await sql<SalesRowShape>`
      select id, version, name, attrs from entity_records
      where entity_type = ${entity} and deleted_at is null
      order by id asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /** Ids of every live row matching one attribute equality — cheap existence checks. */
  async idsMatching(
    entity: SalesEntityType,
    field: string,
    value: string,
  ): Promise<string[]> {
    attributeKey(field);
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = ${entity} and deleted_at is null and (attrs ->> ${field}::text) = ${value}
      order by id asc
    `.execute(this.db);
    return rows.rows.map((row) => row.id);
  }
}

interface SalesRowShape {
  id: string;
  version: number;
  name: string | null;
  attrs: unknown;
}

const PHYSICAL_NAME = "name";

function toRow(row: SalesRowShape): SalesRow {
  const data = isRecord(row.attrs) ? { ...row.attrs } : {};
  if (data[PHYSICAL_NAME] === undefined) data[PHYSICAL_NAME] = row.name;
  return { id: row.id, version: row.version, name: row.name, data };
}

/** Shown to every caller: the entity name is the guard, not the string interpolation. */
export function requireSalesEntity(entity: string): SalesEntityType {
  if (!isSalesEntityType(entity)) {
    throw new ValidationError(`"${entity}" is not a Sales-owned entity type.`, {
      entity,
    });
  }
  return entity;
}

function attributeKey(field: string): void {
  if (!ATTRIBUTE_PATTERN.test(field))
    throw new ValidationError(`Illegal attribute name "${field}".`, { field });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
