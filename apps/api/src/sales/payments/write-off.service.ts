import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import { OutboxService } from "../../common/outbox.service.js";
import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../../common/request-scope.js";
import { DatabaseService, type DbTx } from "../../database/database.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import type { SalesAuditContext } from "../document/types.js";
import { baseFieldsFor } from "../money/currency.js";
import { runAsSalesInternal } from "../sales-internal.js";
import { assertWriteOffAmount } from "./allocation-math.js";
import { SalesBalanceService } from "./balance.service.js";

/**
 * Phase 19-S.11 — write-offs as approved balance adjustments (§4.9).
 *
 * A write-off is not a payment and must not be disguised as one. It is a two-step decision:
 *
 *  - **request** — anyone with write-off permission asks to reduce an issued invoice's receivable,
 *    with a reason. The request is a `pending` record and changes **no** balance;
 *  - **approval** — an administrator approves (or rejects) it. Only an approved write-off reduces
 *    `amountDue`; the amount is checked against what the invoice still owes *at approval time*,
 *    because balances move between the two steps;
 *  - **reversal** — the compensating action for an approved write-off (§4.9). The record stays, gains
 *    `reversedAt`/`reversedBy`/`reversalReason`, and stops counting toward the balance — the history
 *    of both the original and the compensating entry is kept.
 *
 * Every step is evented, and the `status` field is audited by the Entity Engine, so the trail is the
 * record itself, not a comment about it. The administrator gate for approval lives on the controller
 * (`requireAdmin`), the same as every other privileged Sales command.
 */

export interface WriteOffView {
  readonly id: string;
  readonly invoiceId: string;
  readonly amount: string;
  readonly currency: string;
  readonly reason: string;
  readonly status: string;
  readonly requestedBy: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly reversedBy: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
}

export interface WriteOffResult {
  readonly writeOff: WriteOffView;
  /** The invoice's live balances after the step; `null` when the step changed no balance. */
  readonly invoice: {
    readonly id: string;
    readonly amountDue: string;
    readonly paymentStatus: string;
  } | null;
}

export interface WriteOffRequestInput {
  readonly invoiceId: string;
  readonly amount: string;
  readonly reason: string;
  readonly audit?: SalesAuditContext | undefined;
}

@Injectable()
export class WriteOffService {
  constructor(
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SalesBalanceService) private readonly balances: SalesBalanceService,
  ) {}

  /** Ask to write off part (or all) of an issued invoice's receivable. No balance changes yet. */
  async request(input: WriteOffRequestInput): Promise<WriteOffResult> {
    await this.acl.assertAccess("WriteOff", "create");
    await this.acl.assertAccess("Invoice", "edit");
    return await runInTransaction(this.database.db, async (tx) => {
      const invoice = await this.balances.lockRow(tx, "Invoice", input.invoiceId);
      const status = text(invoice.data["status"]) ?? "draft";
      if (status !== "issued") {
        throw new ValidationError(
          `A write-off can only be requested against an issued invoice; this one is "${status}".`,
          { invoiceId: invoice.id, status },
        );
      }
      const outstanding = await this.balances.outstandingOf(tx, invoice);
      assertWriteOffAmount({
        amount: input.amount,
        documentRemaining: outstanding,
        documentId: invoice.id,
      });

      const currency = text(invoice.data["currency"]) ?? "USD";
      const created = await runAsSalesInternal(() =>
        this.entities.create("WriteOff", {
          name: `Write-off ${input.amount} ${currency}`,
          invoiceId: invoice.id,
          amount: input.amount,
          currency,
          // 19-S.18 — the forgiven amount at the invoice's own frozen conversion (§4.13).
          ...baseFieldsFor(input.amount, currency, invoice.data["exchangeRateSnapshot"]),
          reason: input.reason,
          status: "pending",
          requestedBy: this.actor(),
          correlationId: input.audit?.correlationId ?? null,
        }),
      );
      const writeOffId = text(created["id"]);
      if (writeOffId === undefined)
        throw new ValidationError("Creating a write-off returned no id.");

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.writeOff.requested",
          payload: {
            writeOffId,
            invoiceId: invoice.id,
            amount: input.amount,
            currency,
            reason: input.reason,
            actor: this.actor(),
            correlationId: input.audit?.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return { writeOff: toWriteOffView(writeOffId, created), invoice: null };
    });
  }

  /**
   * Approve a pending write-off, reducing the invoice by its amount. The amount is checked against
   * the invoice's *current* outstanding — an invoice paid in the meantime refuses the approval.
   */
  async approve(
    id: string,
    audit: SalesAuditContext = {},
  ): Promise<WriteOffResult> {
    return await runInTransaction(this.database.db, async (tx) => {
      const writeOff = await this.balances.lockRow(tx, "WriteOff", id);
      requireStatus(writeOff, "pending", "approved");
      const invoice = await this.lockInvoiceOf(tx, writeOff);
      const status = text(invoice.data["status"]) ?? "draft";
      if (status !== "issued") {
        throw new ValidationError(
          `This write-off's invoice is no longer issued ("${status}"); a write-off only adjusts an issued receivable.`,
          { writeOffId: id, invoiceId: invoice.id, status },
        );
      }
      const amount = text(writeOff.data["amount"]) ?? "0";
      const outstanding = await this.balances.outstandingOf(tx, invoice);
      assertWriteOffAmount({
        amount,
        documentRemaining: outstanding,
        documentId: invoice.id,
      });

      const approvedAt = new Date();
      await runAsSalesInternal(() =>
        this.entities.update("WriteOff", id, {
          status: "approved",
          approvedBy: this.actor(),
          approvedAt,
        }),
      );
      const nextInvoice = await this.balances.syncDocument(
        tx,
        "Invoice",
        invoice,
      );

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.writeOff.approved",
          payload: {
            writeOffId: id,
            invoiceId: invoice.id,
            amount,
            invoiceAmountDue: nextInvoice.amountDue,
            actor: this.actor(),
            correlationId: audit.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return {
        writeOff: toWriteOffView(id, {
          ...writeOff.data,
          status: "approved",
          approvedBy: this.actor(),
          approvedAt,
        }),
        invoice: {
          id: invoice.id,
          amountDue: nextInvoice.amountDue,
          paymentStatus: nextInvoice.paymentStatus,
        },
      };
    });
  }

  /** Reject a pending write-off. The request stays on record; nothing about the invoice changes. */
  async reject(
    id: string,
    audit: SalesAuditContext = {},
  ): Promise<WriteOffResult> {
    return await runInTransaction(this.database.db, async (tx) => {
      const writeOff = await this.balances.lockRow(tx, "WriteOff", id);
      requireStatus(writeOff, "pending", "rejected");
      await runAsSalesInternal(() =>
        this.entities.update("WriteOff", id, { status: "rejected" }),
      );
      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.writeOff.rejected",
          payload: {
            writeOffId: id,
            invoiceId: text(writeOff.data["invoiceId"]) ?? null,
            amount: text(writeOff.data["amount"]) ?? "0",
            actor: this.actor(),
            reason: text(audit.reason) ?? null,
            correlationId: audit.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);
      return {
        writeOff: toWriteOffView(id, {
          ...writeOff.data,
          status: "rejected",
        }),
        invoice: null,
      };
    });
  }

  /**
   * Reverse an approved write-off — the compensating action (§4.9). The record is marked, never
   * deleted, and the invoice's receivable is restored by the same derived-balance recompute that
   * approved it.
   */
  async reverse(
    id: string,
    audit: SalesAuditContext = {},
  ): Promise<WriteOffResult> {
    const reason = text(audit.reason);
    if (reason === undefined) {
      throw new ValidationError(
        "Reversing a write-off requires a reason.",
        { writeOffId: id },
      );
    }
    return await runInTransaction(this.database.db, async (tx) => {
      const writeOff = await this.balances.lockRow(tx, "WriteOff", id);
      requireStatus(writeOff, "approved", "reversed");
      const invoice = await this.lockInvoiceOf(tx, writeOff);

      const reversedAt = new Date();
      await runAsSalesInternal(() =>
        this.entities.update("WriteOff", id, {
          status: "reversed",
          reversedBy: this.actor(),
          reversedAt,
          reversalReason: reason,
        }),
      );
      const nextInvoice = await this.balances.syncDocument(
        tx,
        "Invoice",
        invoice,
      );

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.writeOff.reversed",
          payload: {
            writeOffId: id,
            invoiceId: invoice.id,
            amount: text(writeOff.data["amount"]) ?? "0",
            invoiceAmountDue: nextInvoice.amountDue,
            actor: this.actor(),
            reason,
            correlationId: audit.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return {
        writeOff: toWriteOffView(id, {
          ...writeOff.data,
          status: "reversed",
          reversedBy: this.actor(),
          reversedAt,
          reversalReason: reason,
        }),
        invoice: {
          id: invoice.id,
          amountDue: nextInvoice.amountDue,
          paymentStatus: nextInvoice.paymentStatus,
        },
      };
    });
  }

  private async lockInvoiceOf(
    tx: DbTx,
    writeOff: { readonly data: Record<string, unknown> },
  ) {
    const invoiceId = text(writeOff.data["invoiceId"]);
    if (invoiceId === undefined) {
      throw new ValidationError(
        "This write-off does not name an invoice.",
        { invoiceId: null },
      );
    }
    return await this.balances.lockRow(tx, "Invoice", invoiceId);
  }

  private actor(): string | null {
    return this.scope.principal?.userName ?? this.scope.userId ?? null;
  }
}

function requireStatus(
  row: { readonly data: Record<string, unknown> },
  expected: string,
  action: string,
): void {
  const status = text(row.data["status"]) ?? "pending";
  if (status !== expected) {
    throw new ValidationError(
      `A write-off can only be ${action} while it is "${expected}"; this one is "${status}".`,
      { status, expected },
    );
  }
}

function toWriteOffView(
  id: string,
  data: Record<string, unknown>,
): WriteOffView {
  return {
    id,
    invoiceId: text(data["invoiceId"]) ?? "",
    amount: text(data["amount"]) ?? "0",
    currency: text(data["currency"]) ?? "USD",
    reason: text(data["reason"]) ?? "",
    status: text(data["status"]) ?? "pending",
    requestedBy: text(data["requestedBy"]) ?? null,
    approvedBy: text(data["approvedBy"]) ?? null,
    approvedAt: isoOrNull(data["approvedAt"]),
    reversedBy: text(data["reversedBy"]) ?? null,
    reversedAt: isoOrNull(data["reversedAt"]),
    reversalReason: text(data["reversalReason"]) ?? null,
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
