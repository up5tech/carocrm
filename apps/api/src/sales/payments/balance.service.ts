import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import type { Db, DbTx } from "../../database/database.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { resolveDay, storedDay } from "../clock.js";
import { runAsSalesInternal } from "../sales-internal.js";
import type { SalesRow } from "../sales-records.js";
import {
  creditNoteOutstanding,
  documentOutstanding,
  invoicePaymentStatus,
  type PaymentBalance,
  paymentBalance,
} from "./allocation-math.js";

/**
 * Phase 19-S.10 / 19-S.11 — one place that computes and persists every derived money balance.
 *
 * A payment's `allocatedAmount`/`unallocatedAmount`, an invoice's `amountDue` and `paymentStatus`,
 * and a credit note's `unallocatedAmount` are all *derived*: they are recomputed from the live
 * allocation rows while the relevant rows are locked, and written back as records. The command
 * services (allocation, credit note, write-off) orchestrate; this service owns the arithmetic, so
 * three callers cannot drift into three definitions of "outstanding".
 *
 * The filters that matter for 19-S.11 live here and nowhere else:
 *
 *  - a credit-note allocation with `reversedAt` set no longer settles anything — the row is kept as
 *    history (§4.9 "reversible only through a supported compensating action"), but it is excluded
 *    from every balance;
 *  - a write-off only reduces a receivable once it is **approved** — a pending request is not money.
 *
 * Concurrency follows the allocation service's rule (§6.3): every command locks the rows it will
 * recompute *before* calling in here, and every sync runs inside that same transaction.
 */

/** Which rows of an entity count toward a balance. Values are internal constants, still bound. */
interface AmountFilter {
  /** Only rows whose `status` attribute equals this. */
  readonly status?: string;
  /** Only rows whose `reversedAt` attribute is unset (a live, unreversed row). */
  readonly notReversed?: boolean;
}

/** A read/write executor: a pooled connection, or the transaction a command is running in. */
export type BalanceExecutor = Db | DbTx;

@Injectable()
export class SalesBalanceService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  /**
   * Lock one row of the generic record store. `FOR UPDATE` on the record itself — not on a shadow
   * table — so the lock is taken by the same transaction that writes the allocation.
   */
  async lockRow(tx: BalanceExecutor, entity: string, id: string): Promise<SalesRow> {
    const locked = await tx
      .selectFrom("entity_records")
      .select(["id", "version", "name", "attrs"])
      .where("entity_type", "=", entity)
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (locked === undefined)
      throw new NotFoundError(`${entity} "${id}" does not exist.`);
    const data =
      typeof locked.attrs === "object" && locked.attrs !== null
        ? { ...(locked.attrs as Record<string, unknown>) }
        : {};
    if (data["name"] === undefined) data["name"] = locked.name;
    return { id: locked.id, version: locked.version, name: locked.name, data };
  }

  /** A payment's live balance, recomputed from its allocation rows. */
  async paymentBalanceOf(
    tx: BalanceExecutor,
    payment: SalesRow,
  ): Promise<PaymentBalance> {
    const rows = await this.amountsMatching(
      tx,
      "PaymentAllocation",
      "paymentId",
      payment.id,
    );
    return paymentBalance(text(payment.data["amount"]) ?? "0", rows);
  }

  /**
   * Write the payment's derived balances. Always called inside the lock. Transfers are tracked as
   * their own records and do not consume the allocatable balance, exactly as 19-S.10 defined it.
   */
  async syncPayment(
    tx: BalanceExecutor,
    payment: SalesRow,
  ): Promise<{ allocated: string; unallocated: string; status: string }> {
    const balance = await this.paymentBalanceOf(tx, payment);
    await runAsSalesInternal(() =>
      this.entities.update("Payment", payment.id, {
        allocatedAmount: balance.allocated,
        unallocatedAmount: balance.unallocated,
        allocationStatus: balance.status,
      }),
    );
    return {
      allocated: balance.allocated,
      unallocated: balance.unallocated,
      status: balance.status,
    };
  }

  /**
   * What a document still owes: its payable total minus live payment allocations, live credit
   * allocations, **approved** write-offs and live bill-credit allocations.
   *
   * Every one of those is looked up by the document's own id, and ids are unique across entities, so
   * a bill never picks up a customer credit note's rows and an invoice never picks up a bill credit's.
   */
  async outstandingOf(tx: BalanceExecutor, document: SalesRow): Promise<string> {
    const [allocations, credits, writeOffs, billCredits] = await Promise.all([
      this.amountsMatching(
        tx,
        "PaymentAllocation",
        "documentId",
        document.id,
      ),
      this.amountsMatching(tx, "CreditNoteAllocation", "invoiceId", document.id, {
        notReversed: true,
      }),
      this.amountsMatching(tx, "WriteOff", "invoiceId", document.id, {
        status: "approved",
      }),
      this.amountsMatching(tx, "BillCreditAllocation", "billId", document.id, {
        notReversed: true,
      }),
    ]);
    return documentOutstanding(
      text(document.data["grossTotal"]) ?? "0",
      allocations,
      credits,
      [...writeOffs, ...billCredits],
    );
  }

  /**
   * Write the document's outstanding balance and its *payment* status. The document's own `status` is
   * not touched: an invoice that is fully paid is still an issued invoice (§4.7).
   */
  async syncDocument(
    tx: BalanceExecutor,
    entity: string,
    document: SalesRow,
  ): Promise<{ amountDue: string; paymentStatus: string }> {
    const amountDue = await this.outstandingOf(tx, document);
    const paymentStatus = invoicePaymentStatus({
      grossTotal: text(document.data["grossTotal"]) ?? "0",
      amountDue,
      dueDate: storedDay(document.data["dueDate"]) ?? null,
      today: resolveDay(undefined),
    });
    await runAsSalesInternal(() =>
      this.entities.update(entity, document.id, { amountDue, paymentStatus }),
    );
    return { amountDue, paymentStatus };
  }

  /**
   * How much of an issued credit is still available to allocate — its live, unreversed remainder.
   *
   * The same rule for both sides of the ledger: a customer credit note (`CreditNoteAllocation`) and a
   * supplier bill credit (`BillCreditAllocation`) each count only their own rows (§4.9, §4.12).
   */
  async creditUnallocated(
    tx: BalanceExecutor,
    credit: SalesRow,
    entity: "CreditNote" | "BillCredit",
  ): Promise<string> {
    const rows = await this.amountsMatching(
      tx,
      entity === "CreditNote" ? "CreditNoteAllocation" : "BillCreditAllocation",
      entity === "CreditNote" ? "creditNoteId" : "billCreditId",
      credit.id,
      { notReversed: true },
    );
    return creditNoteOutstanding(
      text(credit.data["grossTotal"]) ?? "0",
      rows,
    );
  }

  /** Write the credit's derived remainder. Always called inside the lock. */
  async syncCredit(
    tx: BalanceExecutor,
    credit: SalesRow,
    entity: "CreditNote" | "BillCredit",
  ): Promise<{ unallocated: string }> {
    const unallocated = await this.creditUnallocated(tx, credit, entity);
    await runAsSalesInternal(() =>
      this.entities.update(entity, credit.id, {
        unallocatedAmount: unallocated,
      }),
    );
    return { unallocated };
  }

  /**
   * The allocation amounts on rows of `entity` whose `field` holds `id`, narrowed by `filter`.
   *
   * The attribute name is validated against an allowlist before it reaches SQL, the filter values are
   * internal constants, and every value is bound as a parameter, so no request value can become an
   * identifier or a fragment of SQL (AGENTS.md §5.2).
   */
  private async amountsMatching(
    tx: BalanceExecutor,
    entity: string,
    field: string,
    id: string,
    filter: AmountFilter = {},
  ): Promise<string[]> {
    assertAttribute(field);
    const clauses = [
      sql<boolean>`entity_type = ${entity}`,
      sql<boolean>`deleted_at is null`,
      sql<boolean>`(attrs ->> ${field}::text) = ${id}`,
    ];
    if (filter.status !== undefined) {
      clauses.push(sql<boolean>`(attrs ->> 'status') = ${filter.status}`);
    }
    if (filter.notReversed === true) {
      clauses.push(sql<boolean>`(attrs ->> 'reversedAt') is null`);
    }
    const rows = await sql<{ amount: string | null }>`
      select attrs ->> 'amount' as amount
      from entity_records
      where ${sql.join(clauses, sql` and `)}
    `.execute(tx);
    return rows.rows.map((row) => row.amount ?? "0");
  }
}

const ATTRIBUTE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,48}$/;

function assertAttribute(field: string): void {
  if (!ATTRIBUTE_PATTERN.test(field))
    throw new ValidationError(`Illegal attribute name "${field}".`, { field });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
