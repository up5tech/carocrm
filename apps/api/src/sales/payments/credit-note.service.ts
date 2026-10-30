import { ValidationError } from "@carocrm/core/errors/index.js";
import { type DocumentBlock,pdfAvailable } from "@carocrm/document";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import { OutboxService } from "../../common/outbox.service.js";
import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../../common/request-scope.js";
import { DatabaseService } from "../../database/database.service.js";
import { DocumentTemplateService } from "../../document/document-template.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import {
  creditNoteBlocks,
  type CreditNoteRenderInput,
  creditNoteSubject,
  creditNoteTemplateData,
  creditNoteText,
} from "../document/credit-note-document.js";
import { type DocumentView,SalesDocumentService } from "../document/document.service.js";
import { documentRenderLine } from "../document/render-blocks.js";
import type { SalesAuditContext } from "../document/types.js";
import { baseFieldsFor } from "../money/currency.js";
import { runAsSalesInternal } from "../sales-internal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import {
  type AllocatablePage,
  type AllocatableResult,
  collectAllocatable,
  DEFAULT_ALLOCATABLE_PAGE,
} from "./allocatable.js";
import { assertCreditAllocatable, assertSameCurrency } from "./allocation-math.js";
import { SalesBalanceService } from "./balance.service.js";

/**
 * Phase 19-S.11 — credit-note allocation (§4.9).
 *
 * A credit note reduces a receivable the same way a payment does: through an explicit allocation
 * record against an issued invoice, never by editing the invoice. What differs is the correction
 * model. A payment allocation that was wrong is removed (the link disappears, both sides recompute);
 * a **credit** allocation is *reversed*, because §4.9 requires every correction of a credit to keep
 * the history of both the original and the compensating entry:
 *
 *  - the allocation row stays, gains `reversedAt`/`reversedBy`/`reversalReason`, and stops counting
 *    toward every balance from that moment on (`SalesBalanceService` filters it out);
 *  - re-allocating the credit afterwards writes a *new* row, so the reversal and the replacement are
 *    both visible.
 *
 * Concurrency follows the same rule as payment allocation: one transaction, the credit note row and
 * the invoice row locked in that order, both balances recomputed inside the lock (§6.3).
 */

export interface CreditAllocationView {
  readonly id: string;
  readonly creditNoteId: string;
  readonly invoiceId: string;
  readonly amount: string;
  readonly currency: string;
  /** 19-S.18 — the credit applied at the credit note's frozen rate (§4.13). */
  readonly baseCurrency: string | null;
  readonly baseAmount: string | null;
  readonly allocatedAt: string | null;
  readonly allocatedBy: string | null;
  readonly reversedAt: string | null;
  readonly reversedBy: string | null;
  readonly reversalReason: string | null;
  /** `reversed` once the compensating action ran; an active row still settles the invoice. */
  readonly status: "active" | "reversed";
}

export interface CreditAllocationResult {
  readonly allocation: CreditAllocationView;
  readonly creditNote: { readonly id: string; readonly unallocated: string };
  readonly invoice: {
    readonly id: string;
    readonly amountDue: string;
    readonly paymentStatus: string;
  };
}

export interface AllocateCreditInput {
  readonly creditNoteId: string;
  readonly invoiceId: string;
  readonly amount: string;
  readonly audit?: SalesAuditContext | undefined;
}

@Injectable()
export class CreditNoteService {
  constructor(
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SalesBalanceService) private readonly balances: SalesBalanceService,
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesDocumentService) private readonly documents: SalesDocumentService,
    @Inject(DocumentTemplateService)
    private readonly templates: DocumentTemplateService,
  ) {}

  /**
   * Apply part of an issued credit note to an issued invoice.
   *
   * Refused, with both remainders attached: a credit note or invoice that is not issued, an amount
   * larger than the credit note still has unallocated or the invoice still owes, and a cross-currency
   * allocation without a conversion snapshot (§4.13).
   */
  async allocate(input: AllocateCreditInput): Promise<CreditAllocationResult> {
    await this.acl.assertAccess("CreditNote", "edit");
    await this.acl.assertAccess("Invoice", "edit");
    return await runInTransaction(this.database.db, async (tx) => {
      // Lock order is fixed: credit note, then invoice — the same order every command in this module
      // that touches an invoice uses as its last lock, so concurrent commands queue instead of
      // deadlocking.
      const creditNote = await this.balances.lockRow(
        tx,
        "CreditNote",
        input.creditNoteId,
      );
      const invoice = await this.balances.lockRow(
        tx,
        "Invoice",
        input.invoiceId,
      );

      const creditNoteStatus = text(creditNote.data["status"]) ?? "draft";
      if (creditNoteStatus !== "issued") {
        throw new ValidationError(
          `Only an issued credit note can be allocated; this one is "${creditNoteStatus}".`,
          { creditNoteId: creditNote.id, status: creditNoteStatus },
        );
      }
      const invoiceStatus = text(invoice.data["status"]) ?? "draft";
      if (invoiceStatus !== "issued") {
        throw new ValidationError(
          `Only an issued invoice can receive a credit note allocation; this one is "${invoiceStatus}".`,
          { invoiceId: invoice.id, status: invoiceStatus },
        );
      }

      const creditCurrency = text(creditNote.data["currency"]) ?? "USD";
      const invoiceCurrency = text(invoice.data["currency"]) ?? creditCurrency;
      assertSameCurrency({
        paymentCurrency: creditCurrency,
        documentCurrency: invoiceCurrency,
        allocationCurrency: creditCurrency,
        hasConversion:
          invoice.data["exchangeRateSnapshot"] !== undefined &&
          invoice.data["exchangeRateSnapshot"] !== null,
      });

      const unallocated = await this.balances.creditUnallocated(tx, creditNote, "CreditNote");
      const outstanding = await this.balances.outstandingOf(tx, invoice);
      assertCreditAllocatable({
        amount: input.amount,
        creditRemaining: unallocated,
        documentRemaining: outstanding,
        creditId: creditNote.id,
        documentId: invoice.id,
      });

      const created = await runAsSalesInternal(() =>
        this.entities.create("CreditNoteAllocation", {
          name: `Credit Note Allocation ${input.amount} ${creditCurrency}`,
          creditNoteId: creditNote.id,
          invoiceId: invoice.id,
          amount: input.amount,
          currency: creditCurrency,
          // 19-S.18 — the credit's own frozen conversion, carried onto the row it settles with (§4.13).
          ...baseFieldsFor(
            input.amount,
            creditCurrency,
            creditNote.data["exchangeRateSnapshot"],
          ),
          allocatedAt: new Date(),
          allocatedBy: this.actor(),
          correlationId: input.audit?.correlationId ?? null,
        }),
      );
      const allocationId = text(created["id"]);
      if (allocationId === undefined)
        throw new ValidationError(
          "Creating a credit note allocation returned no id.",
        );

      const nextCreditNote = await this.balances.syncCredit(tx, creditNote, "CreditNote");
      const nextInvoice = await this.balances.syncDocument(
        tx,
        "Invoice",
        invoice,
      );

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.creditNote.allocated",
          payload: {
            allocationId,
            creditNoteId: creditNote.id,
            invoiceId: invoice.id,
            amount: input.amount,
            currency: creditCurrency,
            creditNoteUnallocated: nextCreditNote.unallocated,
            invoiceAmountDue: nextInvoice.amountDue,
            actor: this.actor(),
            correlationId: input.audit?.correlationId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);

      return {
        allocation: toAllocationView({ id: allocationId, data: created }),
        creditNote: { id: creditNote.id, unallocated: nextCreditNote.unallocated },
        invoice: {
          id: invoice.id,
          amountDue: nextInvoice.amountDue,
          paymentStatus: nextInvoice.paymentStatus,
        },
      };
    });
  }

  /**
   * Reverse a credit-note allocation — the supported compensating action (§4.9). The row is kept and
   * marked; both balances are recomputed from the live rows, so undoing a correction never leaves a
   * balance no record explains.
   */
  async unallocate(
    allocationId: string,
    audit: SalesAuditContext = {},
  ): Promise<CreditAllocationResult> {
    await this.acl.assertAccess("CreditNote", "edit");
    await this.acl.assertAccess("Invoice", "edit");
    return await runInTransaction(this.database.db, async (tx) => {
      const allocation = await this.balances.lockRow(
        tx,
        "CreditNoteAllocation",
        allocationId,
      );
      if (isReversed(allocation)) {
        throw new ValidationError(
          "This credit note allocation has already been reversed; the original and its reversal are both on record.",
          { allocationId },
        );
      }
      const creditNoteId = text(allocation.data["creditNoteId"]);
      const invoiceId = text(allocation.data["invoiceId"]);
      if (creditNoteId === undefined || invoiceId === undefined) {
        throw new ValidationError(
          "This allocation is missing its credit note or invoice reference.",
          { allocationId },
        );
      }
      const creditNote = await this.balances.lockRow(
        tx,
        "CreditNote",
        creditNoteId,
      );
      const invoice = await this.balances.lockRow(tx, "Invoice", invoiceId);
      const creditNoteStatus = text(creditNote.data["status"]) ?? "draft";
      if (creditNoteStatus !== "issued") {
        throw new ValidationError(
          `Only an issued credit note can be unallocated; this one is "${creditNoteStatus}".`,
          { creditNoteId, status: creditNoteStatus },
        );
      }

      const reversedAt = new Date();
      await runAsSalesInternal(() =>
        this.entities.update("CreditNoteAllocation", allocationId, {
          reversedAt,
          reversedBy: this.actor(),
          reversalReason: text(audit.reason) ?? null,
        }),
      );

      const nextCreditNote = await this.balances.syncCredit(tx, creditNote, "CreditNote");
      const nextInvoice = await this.balances.syncDocument(
        tx,
        "Invoice",
        invoice,
      );

      await this.outbox.insertMany(tx, [
        {
          eventType: "sales.creditNote.unallocated",
          payload: {
            allocationId,
            creditNoteId,
            invoiceId,
            amount: text(allocation.data["amount"]) ?? "0",
            creditNoteUnallocated: nextCreditNote.unallocated,
            invoiceAmountDue: nextInvoice.amountDue,
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
        creditNote: { id: creditNoteId, unallocated: nextCreditNote.unallocated },
        invoice: {
          id: invoiceId,
          amountDue: nextInvoice.amountDue,
          paymentStatus: nextInvoice.paymentStatus,
        },
      };
    });
  }

  /**
   * The issued invoices a credit note may be allocated to, with what each still owes.
   *
   * When the credit note is named, the list is filtered to its currency — a cross-currency allocation
   * needs a conversion snapshot the generic path cannot infer (§4.13). Invoices with nothing
   * outstanding are omitted.
   */
  async allocatableInvoices(
    creditNoteId: string | null,
    accountId: string | null,
    page: AllocatablePage = DEFAULT_ALLOCATABLE_PAGE,
  ): Promise<AllocatableResult> {
    await this.acl.assertAccess("Invoice", "read");
    let currencyFilter: string | null = null;
    if (creditNoteId !== null) {
      const creditNote = await this.records.byId("CreditNote", creditNoteId);
      if (creditNote === undefined)
        throw new ValidationError(
          `Credit note "${creditNoteId}" does not exist.`,
          { creditNoteId },
        );
      currencyFilter = text(creditNote.data["currency"]) ?? null;
    }
    const filters: Record<string, string> = { status: "issued" };
    if (accountId !== null) filters["accountId"] = accountId;
    if (currencyFilter !== null) filters["currency"] = currencyFilter;
    const slice = await collectAllocatable(
      this.records,
      this.balances,
      this.database.db,
      "Invoice",
      filters,
      page,
    );
    return {
      list: slice.rows.map((invoice) => ({
        id: invoice.id,
        number: text(invoice.data["number"]) ?? null,
        accountId: text(invoice.data["accountId"]) ?? null,
        currency: text(invoice.data["currency"]) ?? null,
        grossTotal: text(invoice.data["grossTotal"]) ?? "0",
        dueDate: text(invoice.data["dueDate"]) ?? null,
        paymentStatus: text(invoice.data["paymentStatus"]) ?? null,
        outstanding: slice.outstanding.get(invoice.id) ?? "0",
      })),
      hasMore: slice.hasMore,
      limit: page.limit,
      offset: page.offset,
    };
  }

  private actor(): string | null {
    return this.scope.principal?.userName ?? this.scope.userId ?? null;
  }

  /**
   * Render a credit note against a template — 19-S.11 task 8's document support, through the kernel
   * `document` module, exactly as a quote renders (19-S.7): a named `DocumentTemplate`, or the
   * built-in block layout when the entity type has none. An issued credit note renders from its
   * frozen snapshot, so later catalog moves cannot rewrite what was credited.
   */
  async render(
    id: string,
    templateCode?: string,
  ): Promise<CreditNoteRenderResult> {
    const view = await this.documents.view("creditNote", id);
    const input = await this.renderInputFor(view);
    const blocks = creditNoteBlocks(input);
    const text = creditNoteText(input);
    const pdf = await pdfAvailable();

    const code =
      templateCode ??
      (await this.templates.defaultTemplateCode("CreditNote"));
    if (code === undefined) {
      return {
        creditNoteId: view.id,
        number: input.number,
        status: input.status,
        fromSnapshot: view.fromSnapshot,
        templateCode: null,
        format: "text",
        subject: creditNoteSubject(input),
        body: text,
        text,
        blocks,
        warnings: [],
        pdf,
      };
    }

    const rendered = await this.templates.render(
      code,
      creditNoteTemplateData(input),
    );
    const subject = rendered.subject.trim();
    return {
      creditNoteId: view.id,
      number: input.number,
      status: input.status,
      fromSnapshot: view.fromSnapshot,
      templateCode: code,
      format: rendered.format,
      subject: subject === "" ? creditNoteSubject(input) : subject,
      body: rendered.body,
      text,
      blocks,
      warnings: rendered.warnings,
      pdf,
    };
  }

  private async renderInputFor(
    view: DocumentView,
  ): Promise<CreditNoteRenderInput> {
    const document = view.document;
    const snapshot = await this.documents.issuedData("creditNote", view.id);
    const parties =
      snapshot !== undefined
        ? snapshot.parties
        : {
            accountName: await this.nameOf(
              "Account",
              text(document["accountId"]),
            ),
            contactName: await this.nameOf(
              "Contact",
              text(document["contactId"]),
            ),
            billingAddress: text(document["billingAddress"]) ?? null,
            shippingAddress: text(document["shippingAddress"]) ?? null,
          };
    return {
      number: text(document["number"]) ?? null,
      status: text(document["status"]) ?? "draft",
      creditDate: text(document["creditDate"]) ?? null,
      invoiceNumber: await this.invoiceNumberOf(
        text(document["invoiceId"]),
      ),
      reason: text(document["reason"]) ?? null,
      unallocatedAmount: text(document["unallocatedAmount"]) ?? null,
      accountName: parties.accountName,
      contactName: parties.contactName,
      billingAddress: parties.billingAddress,
      shippingAddress: parties.shippingAddress,
      description: text(document["description"]) ?? null,
      lines: view.totals.lines.map(documentRenderLine),
      totals: {
        subtotal: view.totals.subtotal,
        discountTotal: view.totals.discountTotal,
        shippingAmount: view.totals.shippingAmount,
        shippingTaxAmount: view.totals.shippingTaxAmount,
        taxTotal: view.totals.taxTotal,
        netTotal: view.totals.netTotal,
        grossTotal: view.totals.grossTotal,
        currency: view.totals.currency,
      },
    };
  }

  private async nameOf(
    entity: string,
    id: string | undefined,
  ): Promise<string | null> {
    if (id === undefined) return null;
    const record = await this.entities.get(entity, id);
    return text(record["name"]) ?? null;
  }

  /** The credited invoice's human reference (`number`, falling back to its id). */
  private async invoiceNumberOf(
    invoiceId: string | undefined,
  ): Promise<string | null> {
    if (invoiceId === undefined) return null;
    const invoice = await this.records.byId("Invoice", invoiceId);
    if (invoice === undefined) return invoiceId;
    return text(invoice.data["number"]) ?? invoiceId;
  }
}

/** What a credit-note render produced; mirrors the quote render result (19-S.7). */
export interface CreditNoteRenderResult {
  readonly creditNoteId: string;
  readonly number: string | null;
  readonly status: string;
  readonly fromSnapshot: boolean;
  readonly templateCode: string | null;
  readonly format: string;
  readonly subject: string;
  readonly body: string;
  /** The plain-text rendering of the block model, always present. */
  readonly text: string;
  /** The block model itself, so a PDF renderer can be handed the same document. */
  readonly blocks: readonly DocumentBlock[];
  readonly warnings: readonly string[];
  readonly pdf: { readonly available: boolean; readonly reason: string | null };
}

function isReversed(row: SalesRow): boolean {
  return row.data["reversedAt"] !== undefined && row.data["reversedAt"] !== null;
}

function toAllocationView(row: {
  id: string;
  data: Record<string, unknown>;
}): CreditAllocationView {
  const reversedAt = isoOrNull(row.data["reversedAt"]);
  return {
    id: row.id,
    creditNoteId: text(row.data["creditNoteId"]) ?? "",
    invoiceId: text(row.data["invoiceId"]) ?? "",
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
