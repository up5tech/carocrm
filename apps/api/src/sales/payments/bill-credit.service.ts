import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import { OutboxService } from "../../common/outbox.service.js";
import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../../common/request-scope.js";
import { DatabaseService } from "../../database/database.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import type { SalesAuditContext } from "../document/types.js";
import { baseFieldsFor } from "../money/currency.js";
import { compare, parseDecimal, zero } from "../money/decimal.js";
import { runAsSalesInternal } from "../sales-internal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import {
  assertCreditAllocatable,
  assertSameCurrency,
} from "./allocation-math.js";
import { SalesBalanceService } from "./balance.service.js";

/**
 * Phase 19-S.13 — bill credits: reducing a payable (§4.12).
 *
 * The supplier-side twin of `CreditNoteService`, and deliberately its own records: a row that settles
 * what a *customer* owes and a row that reduces what the *organisation* owes are not interchangeable
 * lines in one table, and the plan is explicit that the two keep separate semantics.
 *
 * Everything else is the same rule, because it was already correct:
 *
 *  - a bill credit reduces a payable through an explicit allocation against an **issued** bill, never
 *    by editing the bill;
 *  - a correction is a **reversal** — the allocation row stays, gains `reversedAt`/`reversedBy`/
 *    `reversalReason`, and stops counting toward every balance;
 *  - one transaction, the credit locked then the bill, both balances recomputed inside the lock (§6.3).
 */

export interface BillCreditAllocationView {
  readonly id: string;
  readonly billCreditId: string;
  readonly billId: string;
  readonly amount: string;
  readonly currency: string;
  /** 19-S.18 — the credit applied at the bill credit's frozen rate (§4.13). */
  readonly baseCurrency: string | null;
  readonly baseAmount: string | null;
  readonly allocatedAt: string | null;
  readonly allocatedBy: string | null;
  readonly reversedAt: string | null;
  readonly reversedBy: string | null;
  readonly reversalReason: string | null;
  readonly status: "active" | "reversed";
}

export interface BillCreditAllocationResult {
  readonly allocation: BillCreditAllocationView;
  readonly billCredit: { readonly id: string; readonly unallocated: string };
  readonly bill: {
    readonly id: string;
    readonly amountDue: string;
    readonly paymentStatus: string;
  };
}

export interface AllocateBillCreditInput {
  readonly billCreditId: string;
  readonly billId: string;
  readonly amount: string;
  readonly audit?: SalesAuditContext | undefined;
}

@Injectable()
export class BillCreditService {
  constructor(
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SalesBalanceService) private readonly balances: SalesBalanceService,
    @Inject(SalesRecords) private readonly records: SalesRecords,
  ) {}

  /**
   * Apply part of an issued bill credit to an issued bill. Refused, with both remainders attached,
   * when either document is not issued, when the amount exceeds either side, or when the currencies
   * differ without a conversion snapshot (§4.12, §4.13).
   */
  async allocate(
    input: AllocateBillCreditInput,
  ): Promise<BillCreditAllocationResult> {
    await this.acl.assertAccess("BillCredit", "edit");
    await this.acl.assertAccess("Bill", "edit");
    return await runInTransaction(this.database.db, async (tx) => {
      // Lock order matches the credit note's: credit first, payable document second, so two
      // concurrent commands queue instead of deadlocking.
      const billCredit = await this.balances.lockRow(
        tx,
        "BillCredit",
        input.billCreditId,
      );
      const bill = await this.balances.lockRow(tx, "Bill", input.billId);

      const creditStatus = text(billCredit.data["status"]) ?? "draft";
      if (creditStatus !== "issued") {
        throw new ValidationError(
          `Only an issued bill credit can be allocated; this one is "${creditStatus}".`,
          { billCreditId: billCredit.id, status: creditStatus },
        );
      }
      const billStatus = text(bill.data["status"]) ?? "draft";
      if (billStatus !== "issued") {
        throw new ValidationError(
          `Only an issued bill can receive a bill credit; this one is "${billStatus}".`,
          { billId: bill.id, status: billStatus },
        );
      }

      const creditCurrency = text(billCredit.data["currency"]) ?? "USD";
      const billCurrency = text(bill.data["currency"]) ?? creditCurrency;
      assertSameCurrency({
        paymentCurrency: creditCurrency,
        documentCurrency: billCurrency,
        allocationCurrency: creditCurrency,
        hasConversion: hasSnapshot(bill),
      });

      const unallocated = await this.balances.creditUnallocated(
        tx,
        billCredit,
        "BillCredit",
      );
      const outstanding = await this.balances.outstandingOf(tx, bill);
      assertCreditAllocatable({
        amount: input.amount,
        creditRemaining: unallocated,
        documentRemaining: outstanding,
        creditId: billCredit.id,
        documentId: bill.id,
        creditNoun: "bill credit",
        documentNoun: "bill",
      });

      const created = await runAsSalesInternal(() =>
        this.entities.create("BillCreditAllocation", {
          name: `Bill Credit Allocation ${input.amount} ${creditCurrency}`,
          billCreditId: billCredit.id,
          billId: bill.id,
          amount: input.amount,
          currency: creditCurrency,
          // 19-S.18 — the bill credit's own frozen conversion, carried onto the bill it settles (§4.13).
          ...baseFieldsFor(
            input.amount,
            creditCurrency,
            billCredit.data["exchangeRateSnapshot"],
          ),
          allocatedAt: new Date(),
          allocatedBy: this.actor(),
          correlationId: input.audit?.correlationId ?? null,
        }),
      );
      const allocationId = text(created["id"]);
      if (allocationId === undefined)
        throw new ValidationError(
          "Creating a bill credit allocation returned no id.",
        );

      const nextCredit = await this.balances.syncCredit(
        tx,
        billCredit,
        "BillCredit",
      );
      const nextBill = await this.balances.syncDocument(
        tx,
        "Bill",
        bill,
      );

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.billCredit.allocated",
          payload: {
            allocationId,
            billCreditId: billCredit.id,
            billId: bill.id,
            amount: input.amount,
            currency: creditCurrency,
            billCreditUnallocated: nextCredit.unallocated,
            billAmountDue: nextBill.amountDue,
            actor: this.actor(),
            correlationId: input.audit?.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return {
        allocation: toAllocationView({ id: allocationId, data: created }),
        billCredit: { id: billCredit.id, unallocated: nextCredit.unallocated },
        bill: {
          id: bill.id,
          amountDue: nextBill.amountDue,
          paymentStatus: nextBill.paymentStatus,
        },
      };
    });
  }

  /**
   * Reverse a bill-credit allocation — the supported compensating action (§4.12). The row stays on
   * record with the reversal trail, and both balances recompute from what is still live.
   */
  async unallocate(
    allocationId: string,
    audit: SalesAuditContext = {},
  ): Promise<BillCreditAllocationResult> {
    await this.acl.assertAccess("BillCredit", "edit");
    await this.acl.assertAccess("Bill", "edit");
    return await runInTransaction(this.database.db, async (tx) => {
      const allocation = await this.balances.lockRow(
        tx,
        "BillCreditAllocation",
        allocationId,
      );
      if (isReversed(allocation)) {
        throw new ValidationError(
          "This bill credit allocation has already been reversed; the original and its reversal are both on record.",
          { allocationId },
        );
      }
      const billCreditId = text(allocation.data["billCreditId"]);
      const billId = text(allocation.data["billId"]);
      if (billCreditId === undefined || billId === undefined) {
        throw new ValidationError(
          "This allocation is missing its bill credit or bill reference.",
          { allocationId },
        );
      }
      const billCredit = await this.balances.lockRow(
        tx,
        "BillCredit",
        billCreditId,
      );
      const bill = await this.balances.lockRow(tx, "Bill", billId);

      const reversedAt = new Date();
      await runAsSalesInternal(() =>
        this.entities.update("BillCreditAllocation", allocationId, {
          reversedAt,
          reversedBy: this.actor(),
          reversalReason: text(audit.reason) ?? null,
        }),
      );

      const nextCredit = await this.balances.syncCredit(
        tx,
        billCredit,
        "BillCredit",
      );
      const nextBill = await this.balances.syncDocument(tx, "Bill", bill);

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.billCredit.unallocated",
          payload: {
            allocationId,
            billCreditId,
            billId,
            amount: text(allocation.data["amount"]) ?? "0",
            billCreditUnallocated: nextCredit.unallocated,
            billAmountDue: nextBill.amountDue,
            actor: this.actor(),
            reason: text(audit.reason) ?? null,
            correlationId: audit.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return {
        allocation: toAllocationView({
          id: allocationId,
          data: {
            ...allocation.data,
            reversedAt,
            reversedBy: this.actor(),
            reversalReason: text(audit.reason) ?? null,
          },
        }),
        billCredit: { id: billCreditId, unallocated: nextCredit.unallocated },
        bill: {
          id: billId,
          amountDue: nextBill.amountDue,
          paymentStatus: nextBill.paymentStatus,
        },
      };
    });
  }

  /** The bill's payment history — every live and reversed allocation against it. */
  async forBill(billId: string): Promise<readonly BillCreditAllocationView[]> {
    await this.acl.assertAccess("Bill", "read");
    const rows = await this.records.find("BillCreditAllocation", { billId }, 500);
    return rows.map((row) => toAllocationView(row));
  }

  /**
   * The issued bills a bill credit may be allocated to, with what each still owes.
   *
   * Filtered to the credit's own currency when the credit is named, and to the supplier's bills when
   * one is given: a cross-currency allocation needs a conversion snapshot the list cannot infer (§4.13).
   */
  async allocatableBills(
    billCreditId: string | null,
    supplierId: string | null,
  ): Promise<readonly Record<string, unknown>[]> {
    await this.acl.assertAccess("Bill", "read");
    let currencyFilter: string | null = null;
    if (billCreditId !== null) {
      const credit = await this.records.byId("BillCredit", billCreditId);
      if (credit === undefined)
        throw new ValidationError(
          `Bill credit "${billCreditId}" does not exist.`,
          { billCreditId },
        );
      currencyFilter = text(credit.data["currency"]) ?? null;
    }
    const filters: Record<string, string> = { status: "issued" };
    if (supplierId !== null) filters["supplierId"] = supplierId;
    const bills = await this.records.find("Bill", filters, 500);
    const result: Record<string, unknown>[] = [];
    for (const bill of bills) {
      const currency = text(bill.data["currency"]) ?? null;
      if (currencyFilter !== null && currency !== currencyFilter) continue;
      const outstanding = await this.balances.outstandingOf(
        this.database.db,
        bill,
      );
      const amount = parseDecimal(outstanding);
      if (compare(amount, zero(amount.scale)) <= 0) continue;
      result.push({
        id: bill.id,
        number: text(bill.data["number"]) ?? null,
        supplierId: text(bill.data["supplierId"]) ?? null,
        currency,
        grossTotal: text(bill.data["grossTotal"]) ?? "0",
        dueDate: text(bill.data["dueDate"]) ?? null,
        paymentStatus: text(bill.data["paymentStatus"]) ?? null,
        outstanding,
      });
    }
    return result;
  }

  private actor(): string | null {
    return this.scope.principal?.userName ?? this.scope.userId ?? null;
  }
}

function hasSnapshot(row: SalesRow): boolean {
  const value = row.data["exchangeRateSnapshot"];
  return value !== undefined && value !== null;
}

function isReversed(row: SalesRow): boolean {
  return row.data["reversedAt"] !== undefined && row.data["reversedAt"] !== null;
}

function toAllocationView(row: {
  id: string;
  data: Record<string, unknown>;
}): BillCreditAllocationView {
  const reversedAt = isoOrNull(row.data["reversedAt"]);
  return {
    id: row.id,
    billCreditId: text(row.data["billCreditId"]) ?? "",
    billId: text(row.data["billId"]) ?? "",
    amount: text(row.data["amount"]) ?? "0",
    currency: text(row.data["currency"]) ?? "USD",
    baseCurrency: text(row.data["baseCurrency"]) ?? null,
    baseAmount: text(row.data["baseAmount"]) ?? null,
    allocatedAt: isoOrNull(row.data["allocatedAt"]),
    allocatedBy: text(row.data["allocatedBy"]) ?? null,
    reversedAt,
    reversedBy: text(row.data["reversedBy"]) ?? null,
    reversalReason: text(row.data["reversalReason"]) ?? null,
    status: reversedAt === null ? "active" : "reversed",
  };
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value) ?? null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
