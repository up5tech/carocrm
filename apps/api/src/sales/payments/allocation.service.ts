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
import { runAsSalesInternal } from "../sales-internal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import {
  assertAllocatable,
  assertDirectionAllows,
  assertSameCurrency,
  type PaymentDirection,
} from "./allocation-math.js";
import { SalesBalanceService } from "./balance.service.js";

/**
 * Phase 19-S.10 — allocation and unallocation (§4.8).
 *
 * An allocation is the record that says *this payment settles this much of that document*. It is
 * never inferred from a stored balance, and it is never deleted to "correct" a mistake — unallocation
 * removes the link and both sides recompute.
 *
 * Concurrency is the whole point of this file. Two operators allocating the last 100 of an invoice at
 * the same time must not both succeed, so every command runs in one transaction that **locks the
 * payment row and then the document row** (always in that order, so two concurrent commands cannot
 * deadlock each other), recomputes both balances *inside* the lock, and only then writes. The unique
 * index on `(paymentId, documentId, amount, createdAt)` is not the guarantee — the lock is.
 *
 * What is deliberately absent: any call to a payment provider. Allocation is bookkeeping on money that
 * has already arrived.
 */

export interface AllocationView {
  readonly id: string;
  readonly paymentId: string;
  readonly documentEntity: string;
  readonly documentId: string;
  readonly amount: string;
  readonly currency: string;
  /** 19-S.18 — this allocation at the payment's frozen rate; null when the payment has none. */
  readonly baseCurrency: string | null;
  readonly baseAmount: string | null;
  readonly allocatedAt: string | null;
}

export interface AllocationResult {
  readonly allocation: AllocationView;
  readonly payment: {
    readonly allocated: string;
    readonly unallocated: string;
    readonly status: string;
  };
  readonly document: {
    readonly amountDue: string;
    readonly paymentStatus: string;
  };
}

export interface AllocateInput {
  readonly paymentId: string;
  readonly documentEntity?: string | undefined;
  readonly documentId: string;
  readonly amount: string;
  readonly audit?: SalesAuditContext | undefined;
}

@Injectable()
export class AllocationService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SalesBalanceService) private readonly balances: SalesBalanceService,
  ) {}

  /** Every allocation of a payment, newest first — the payment's history. */
  async forPayment(paymentId: string): Promise<readonly AllocationView[]> {
    await this.acl.assertAccess("Payment", "read");
    const rows = await this.records.find(
      "PaymentAllocation",
      { paymentId },
      500,
    );
    return rows
      .map(toAllocationView)
      .sort((left, right) =>
        (left.allocatedAt ?? "") < (right.allocatedAt ?? "") ? 1 : -1,
      );
  }

  /** Every allocation against a document — the invoice's payment history. */
  async forDocument(documentId: string): Promise<readonly AllocationView[]> {
    await this.acl.assertAccess("Payment", "read");
    const rows = await this.records.find(
      "PaymentAllocation",
      { documentId },
      500,
    );
    return rows.map(toAllocationView);
  }

  /**
   * Apply `amount` of a payment to a document.
   *
   * Refused, with the remaining amounts attached: a payment that is not confirmed, a document that is
   * not issued, an amount larger than either side still has open, and a cross-currency allocation
   * without a conversion snapshot.
   */
  async allocate(input: AllocateInput): Promise<AllocationResult> {
    const documentEntity = input.documentEntity ?? "Invoice";
    await this.acl.assertAccess("Payment", "edit");
    await this.acl.assertAccess(documentEntity, "edit");

    return await runInTransaction(this.database.db, async (tx) => {
      // Lock order is fixed: payment, then document. Two concurrent commands therefore queue instead
      // of deadlocking, and both recompute inside the lock (§6.3).
      const payment = await this.balances.lockRow(tx, "Payment", input.paymentId);
      const document = await this.balances.lockRow(
        tx,
        documentEntity,
        input.documentId,
      );

      const direction = directionOf(payment);
      // An incoming payment settles a customer invoice, an outgoing one a supplier bill — never the
      // other way round (§4.12), and the refusal says which side each belongs to.
      assertDirectionAllows(direction, documentEntity);
      const paymentStatus = text(payment.data["status"]) ?? "draft";
      if (paymentStatus !== "confirmed") {
        throw new ValidationError(
          `A payment must be confirmed before it can be allocated; this one is "${paymentStatus}".`,
          {
            paymentId: payment.id,
            status: paymentStatus,
          },
        );
      }
      const documentStatus = text(document.data["status"]) ?? "draft";
      if (documentStatus !== "issued") {
        throw new ValidationError(
          `Only an issued ${documentEntity.toLowerCase()} can be allocated to; this one is "${documentStatus}".`,
          {
            documentId: document.id,
            status: documentStatus,
          },
        );
      }

      const paymentCurrency = text(payment.data["currency"]) ?? "USD";
      const documentCurrency =
        text(document.data["currency"]) ?? paymentCurrency;
      const allocationCurrency = text(payment.data["currency"]) ?? "USD";
      assertSameCurrency({
        paymentCurrency,
        documentCurrency,
        allocationCurrency,
        hasConversion:
          document.data["exchangeRateSnapshot"] !== undefined &&
          document.data["exchangeRateSnapshot"] !== null,
      });

      const balance = await this.balances.paymentBalanceOf(tx, payment);
      const outstanding = await this.balances.outstandingOf(tx, document);
      assertAllocatable({
        amount: input.amount,
        paymentRemaining: balance.unallocated,
        documentRemaining: outstanding,
        paymentId: payment.id,
        documentId: document.id,
      });

      const allocation = await runAsSalesInternal(() =>
        this.entities.create("PaymentAllocation", {
          name: `Allocation ${input.amount} ${allocationCurrency}`,
          paymentId: payment.id,
          documentEntity,
          documentId: document.id,
          amount: input.amount,
          currency: allocationCurrency,
          // 19-S.18 — settled money keeps the conversion its payment was recorded with, so an
          // allocation ledger can be totalled in base currency without a newer rate (§4.13).
          ...baseFieldsFor(
            input.amount,
            allocationCurrency,
            payment.data["exchangeRateSnapshot"],
          ),
          allocatedAt: new Date(),
          allocatedBy:
            this.scope.principal?.userName ?? this.scope.userId ?? null,
          correlationId: input.audit?.correlationId ?? null,
        }),
      );
      const allocationId = text(allocation["id"]);
      if (allocationId === undefined)
        throw new ValidationError("Creating an allocation returned no id.");

      const nextPayment = await this.balances.syncPayment(tx, payment);
      const nextDocument = await this.balances.syncDocument(
        tx,
        documentEntity,
        document,
      );

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.payment.allocated",
          payload: {
            allocationId,
            paymentId: payment.id,
            documentEntity,
            documentId: document.id,
            amount: input.amount,
            currency: allocationCurrency,
            paymentUnallocated: nextPayment.unallocated,
            documentAmountDue: nextDocument.amountDue,
            actor: this.scope.principal?.userName ?? this.scope.userId ?? null,
            correlationId: input.audit?.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return {
        allocation: toAllocationView({
          id: allocationId,
          data: allocation,
          name: null,
          version: 1,
        }),
        payment: nextPayment,
        document: nextDocument,
      };
    });
  }

  /**
   * Remove an allocation. Both sides recompute from their remaining rows, so a correction can never
   * leave a balance that no record explains (§4.9 "compensating action, never a silent delete" — the
   * removal itself is audited and evented).
   */
  async unallocate(
    allocationId: string,
    audit: SalesAuditContext = {},
  ): Promise<AllocationResult> {
    await this.acl.assertAccess("Payment", "edit");
    return await runInTransaction(this.database.db, async (tx) => {
      const allocation = await this.balances.lockRow(
        tx,
        "PaymentAllocation",
        allocationId,
      );
      const paymentId = text(allocation.data["paymentId"]);
      const documentId = text(allocation.data["documentId"]);
      const documentEntity =
        text(allocation.data["documentEntity"]) ?? "Invoice";
      if (paymentId === undefined || documentId === undefined) {
        throw new ValidationError(
          "This allocation does not name a payment and a document.",
          { allocationId },
        );
      }
      const payment = await this.balances.lockRow(tx, "Payment", paymentId);
      const document = await this.balances.lockRow(
        tx,
        documentEntity,
        documentId,
      );

      await runAsSalesInternal(() =>
        this.entities.remove("PaymentAllocation", allocationId),
      );

      const nextPayment = await this.balances.syncPayment(tx, payment);
      const nextDocument = await this.balances.syncDocument(
        tx,
        documentEntity,
        document,
      );

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.payment.unallocated",
          payload: {
            allocationId,
            paymentId,
            documentEntity,
            documentId,
            amount: text(allocation.data["amount"]) ?? "0",
            actor: this.scope.principal?.userName ?? this.scope.userId ?? null,
            reason: audit.reason ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return {
        allocation: toAllocationView(allocation),
        payment: nextPayment,
        document: nextDocument,
      };
    });
  }

  /**
   * A payment-to-payment transfer (a refund, or moving an unapplied amount). Modelled as its own
   * record: the plan is explicit that negative allocations that confuse balances are not an
   * implementation (§4.8).
   */
  async transfer(
    fromPaymentId: string,
    toPaymentId: string,
    amount: string,
  ): Promise<Record<string, unknown>> {
    await this.acl.assertAccess("Payment", "edit");
    if (fromPaymentId === toPaymentId) {
      throw new ValidationError("A payment cannot transfer to itself.", {
        paymentId: fromPaymentId,
      });
    }
    return await runInTransaction(this.database.db, async (tx) => {
      const from = await this.balances.lockRow(tx, "Payment", fromPaymentId);
      const to = await this.balances.lockRow(tx, "Payment", toPaymentId);
      const fromCurrency = text(from.data["currency"]) ?? "USD";
      const toCurrency = text(to.data["currency"]) ?? "USD";
      if (fromCurrency !== toCurrency) {
        throw new ValidationError(
          `A transfer needs both payments in the same currency; these are ${fromCurrency} and ${toCurrency}.`,
          {
            fromPaymentId,
            toPaymentId,
          },
        );
      }
      const balance = await this.balances.paymentBalanceOf(tx, from);
      assertAllocatable({
        amount,
        paymentRemaining: balance.unallocated,
        documentRemaining: balance.unallocated,
        paymentId: fromPaymentId,
        documentId: toPaymentId,
      });

      const created = await runAsSalesInternal(() =>
        this.entities.create("PaymentTransferAllocation", {
          name: `Transfer ${amount} ${fromCurrency}`,
          fromPaymentId,
          toPaymentId,
          amount,
          currency: fromCurrency,
          transferredAt: new Date(),
          transferredBy:
            this.scope.principal?.userName ?? this.scope.userId ?? null,
        }),
      );
      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.payment.transferred",
          payload: {
            fromPaymentId,
            toPaymentId,
            amount,
            currency: fromCurrency,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);
      return created;
    });
  }
}

function toAllocationView(row: {
  id: string;
  data: Record<string, unknown>;
  name: string | null;
  version: number;
}): AllocationView {
  return {
    id: row.id,
    paymentId: text(row.data["paymentId"]) ?? "",
    documentEntity: text(row.data["documentEntity"]) ?? "Invoice",
    documentId: text(row.data["documentId"]) ?? "",
    amount: text(row.data["amount"]) ?? "0",
    currency: text(row.data["currency"]) ?? "USD",
    baseCurrency: text(row.data["baseCurrency"]) ?? null,
    baseAmount: text(row.data["baseAmount"]) ?? null,
    allocatedAt: isoOrNull(row.data["allocatedAt"]),
  };
}

function directionOf(payment: SalesRow): PaymentDirection {
  return text(payment.data["direction"]) === "outgoing"
    ? "outgoing"
    : "incoming";
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
