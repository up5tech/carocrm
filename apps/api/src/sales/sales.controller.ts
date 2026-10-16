import { timingSafeEqual } from "node:crypto";

import {
  AuthenticationFailedError,
  AuthorizationDeniedError,
  InvalidQueryError,
} from "@carocrm/core/errors/index.js";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { ZodTypeAny } from "zod";

import { Public } from "../auth/auth.guard.js";
import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../common/request-scope.js";
import { type AppConfig, CONFIG_TOKEN } from "../config.js";
import { requireDocumentKind } from "./document/descriptors.js";
import { SalesDocumentService } from "./document/document.service.js";
import { SalesNumberingService } from "./document/numbering.service.js";
import { SalesQuoteSendService } from "./document/quote-send.service.js";
import { SalesDocumentRenderService } from "./document/render.service.js";
import type { SalesAuditContext } from "./document/types.js";
import {
  AdjustmentTransitionSchema,
  AllocatePaymentSchema,
  BillCreditAllocateSchema,
  BillCreditUnallocateSchema,
  BulkPriceUpdateSchema,
  CreateAdjustmentSchema,
  CreateDocumentSchema,
  CreatePaymentRequestSchema,
  CreatePaymentSchema,
  CreateTransferSchema,
  CreditNoteAllocateSchema,
  CreditNoteUnallocateSchema,
  DocumentConvertSchema,
  DocumentTransitionSchema,
  DocumentUnlockSchema,
  ExpireQuotesSchema,
  InventoryReconcileSchema,
  PaymentTransferSchema,
  PaymentTransitionSchema,
  PreviewTotalsSchema,
  ProviderEventSchema,
  ReleaseReservationSchema,
  RenderCreditNoteSchema,
  RenderDocumentSchema,
  RenderQuoteSchema,
  ReserveStockSchema,
  ResolvePriceSchema,
  ResolveSupplierPriceSchema,
  SalesSettingsPatchSchema,
  SendQuoteSchema,
  TodaySchema,
  TransferTransitionSchema,
  UpdateDocumentSchema,
  UpdatePaymentSchema,
  WriteOffApproveSchema,
  WriteOffCreateSchema,
  WriteOffRejectSchema,
  WriteOffReverseSchema,
} from "./dto/sales-shapes.js";
import {
  InventoryService,
  type MovementContext,
} from "./inventory/inventory.service.js";
import { InventoryOperationsService } from "./inventory/inventory-ops.service.js";
import { AllocationService } from "./payments/allocation.service.js";
import { BillCreditService } from "./payments/bill-credit.service.js";
import { CreditNoteService } from "./payments/credit-note.service.js";
import { PaymentService } from "./payments/payment.service.js";
import { WriteOffService } from "./payments/write-off.service.js";
import { BulkPriceService } from "./pricing/bulk-price.service.js";
import { PriceResolutionService } from "./pricing/price-resolution.service.js";
import { SupplierPriceService } from "./pricing/supplier-price.js";
import { runAsSalesInternal } from "./sales-internal.js";
import { SalesModuleHealthService } from "./sales-module-health.service.js";
import { SalesSettingsService } from "./sales-settings.service.js";
import { SalesTaxService } from "./tax/tax.service.js";

/**
 * Phase 19-S.1 – 19-S.14 — Sales domain commands (`/api/v1/Sales`).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API — a Product or a QuoteItem is a metadata
 * record, and the Entity Engine already serves list/detail/create/edit/delete, relations, search and
 * ACL for it. These routes exist only for what a single record cannot express: module diagnostics,
 * the settings document, numbering state, deterministic price resolution, a previewed bulk price
 * change, a server-calculated totals preview, and the commercial **document commands** — create a
 * draft with typed line items, apply a named state transition, issue, unlock, convert and recalculate.
 *
 * Route order: this controller is registered before `ENTITY_CONTROLLERS` in `AppModule`, so the
 * static `Sales` prefix can never be swallowed by the generic `:entity` wildcard.
 */
@ApiTags("sales")
@Controller("api/v1/Sales")
export class SalesController {
  constructor(
    @Inject(SalesModuleHealthService)
    private readonly health: SalesModuleHealthService,
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
    @Inject(SalesNumberingService)
    private readonly numbering: SalesNumberingService,
    @Inject(SalesDocumentService)
    private readonly documents: SalesDocumentService,
    @Inject(SalesQuoteSendService)
    private readonly quoteSend: SalesQuoteSendService,
    @Inject(SalesDocumentRenderService)
    private readonly documentRender: SalesDocumentRenderService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(AllocationService) private readonly allocations: AllocationService,
    @Inject(CreditNoteService)
    private readonly creditNotes: CreditNoteService,
    @Inject(BillCreditService)
    private readonly billCredits: BillCreditService,
    @Inject(WriteOffService) private readonly writeOffs: WriteOffService,
    @Inject(PriceResolutionService)
    private readonly prices: PriceResolutionService,
    @Inject(SupplierPriceService)
    private readonly supplierPrices: SupplierPriceService,
    @Inject(BulkPriceService) private readonly bulkPrices: BulkPriceService,
    @Inject(SalesTaxService) private readonly tax: SalesTaxService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(InventoryOperationsService)
    private readonly inventoryOps: InventoryOperationsService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Module diagnostics: dependencies, optional integrations, features and checks. Admin only. */
  @Get("action/health")
  async moduleHealth() {
    this.requireAdmin("module diagnostics");
    return this.health.health();
  }

  /** The validated settings document plus the computed defaults and warnings. */
  @Get("action/settings")
  async readSettings() {
    return this.settings.read();
  }

  /** Update settings; high-impact policy is administrator-only (§13). */
  @HttpCode(200)
  @Post("action/settings")
  async updateSettings(@Body() body: unknown) {
    this.requireAdmin("changing Sales settings");
    parse(SalesSettingsPatchSchema, body);
    return this.settings.update(body);
  }

  /** Number series with the next unallocated number — allocation itself happens at issuance. */
  @Get("action/numbering")
  async numberingState() {
    this.requireAdmin("document numbering");
    return { list: await this.numbering.list() };
  }

  /** Resolve one line's price, with the explanation of which source won (§4.3). */
  @HttpCode(200)
  @Post("action/resolvePrice")
  async resolvePrice(@Body() body: unknown) {
    const input = parse(ResolvePriceSchema, body);
    return this.prices.resolve(input);
  }

  /**
   * Resolve one line's **buying** price from a supplier, with the same explainability and the same
   * "a missing price is never zero" rule (§4.11, §4.12). It reads `SupplierProductPrice` only, so it
   * can neither return nor fall back to a sales price.
   */
  @HttpCode(200)
  @Post("action/resolveSupplierPrice")
  async resolveSupplierPrice(@Body() body: unknown) {
    const input = parse(ResolveSupplierPriceSchema, body);
    return this.supplierPrices.resolve(input);
  }

  /** Preview or apply a bulk price change; `apply` is audited and bounded (§4.3). */
  @HttpCode(200)
  @Post("action/bulkPriceUpdate")
  async bulkPriceUpdate(@Body() body: unknown) {
    const input = parse(BulkPriceUpdateSchema, body);
    return this.bulkPrices.run(input);
  }

  /** Server-calculated totals: discounts, shipping, tax breakdown and rounding policy (§4.12, §5.7). */
  @HttpCode(200)
  @Post("action/previewTotals")
  async previewTotals(@Body() body: unknown) {
    const input = parse(PreviewTotalsSchema, body);
    return this.tax.preview(input);
  }

  // -------------------------------------------------------------------------------------------
  // Commercial documents (19-S.6 – 19-S.13)
  //
  // Every handler below wraps its work in `runAsSalesInternal`: these are the module's own commands,
  // and they are the only callers allowed to move a computed field (`number`, `status`, `amountDue`,
  // the issuance and lock fields). The write guard refuses exactly those fields on the generic
  // `/api/v1/:entity` path, which is what stops a crafted request from forging a paid invoice (§4.7).
  // -------------------------------------------------------------------------------------------

  /** Create a draft quote/order/invoice/credit note/delivery/return with typed line items. */
  @HttpCode(201)
  @Post("document")
  async createDocument(@Body() body: unknown) {
    const input = parse(CreateDocumentSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.create({
        kind: input.kind,
        data: input.data,
        items: input.items,
        audit: this.audit(input.correlationId),
      }),
    );
  }

  /** A document with its items, its totals, and the actions its current state allows. */
  @Get("document/:kind/:id")
  async readDocument(@Param("kind") kind: string, @Param("id") id: string) {
    return this.documents.view(requireDocumentKind(kind), id);
  }

  /** Update a draft. A locked document refuses changes to its protected fields, by name (§4.7). */
  @HttpCode(200)
  @Patch("document/:kind/:id")
  async updateDocument(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateDocumentSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.update(requireDocumentKind(kind), id, {
        data: input.data,
        items: input.items,
        audit: this.audit(input.correlationId),
      }),
    );
  }

  /** Apply a named transition; the issuing one allocates the number and freezes the snapshot. */
  @HttpCode(200)
  @Post("document/:kind/:id/transition")
  async transitionDocument(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(DocumentTransitionSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.transition(requireDocumentKind(kind), id, input.action, {
        ...this.audit(input.correlationId),
        reason: input.reason,
      }),
    );
  }

  /** Privileged unlock of an issued document: dedicated permission plus an audited reason (§4.7). */
  @HttpCode(200)
  @Post("document/:kind/:id/unlock")
  async unlockDocument(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(DocumentUnlockSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.unlock(
        requireDocumentKind(kind),
        id,
        input.reason,
        this.audit(undefined),
      ),
    );
  }

  /** Convert to another document kind, copying values by value and idempotent on `correlationId`. */
  @HttpCode(201)
  @Post("document/:kind/:id/convert")
  async convertDocument(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(DocumentConvertSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.convert(
        requireDocumentKind(kind),
        id,
        input.action,
        this.audit(input.correlationId),
        input.overrides ?? {},
      ),
    );
  }

  /** A document's printable rendering — a named `DocumentTemplate`, or the built-in block layout.
   *  Every kind is served from its descriptor, so a delivery order or a supplier bill prints without
   *  a per-kind service (19-S.12 task 7, 19-S.13 task 8). */
  @HttpCode(200)
  @Post("document/:kind/:id/render")
  async renderDocument(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(RenderDocumentSchema, body);
    return await this.documentRender.render(
      requireDocumentKind(kind),
      id,
      input.templateCode,
    );
  }

  /** Recalculate on the server's own numbers. An issued document is never rewritten by this. */
  @HttpCode(200)
  @Post("document/:kind/:id/recalculate")
  async recalculateDocument(
    @Param("kind") kind: string,
    @Param("id") id: string,
  ) {
    return await runAsSalesInternal(() =>
      this.documents.recalculate(requireDocumentKind(kind), id),
    );
  }

  /** Delete a **draft** only; an issued document is voided or credited instead (§4.9). */
  @HttpCode(204)
  @Delete("document/:kind/:id")
  async deleteDocument(
    @Param("kind") kind: string,
    @Param("id") id: string,
  ): Promise<void> {
    await runAsSalesInternal(() =>
      this.documents.removeDraft(requireDocumentKind(kind), id),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Quotes — render and send (19-S.7)
  //
  // The two halves of "prepare a quote and get it to the customer". Rendering goes through the kernel
  // `document` module; sending goes through the mail module, which queues the actual delivery to the
  // worker. Neither opens a socket in the API process.
  // -------------------------------------------------------------------------------------------

  /**
   * Render a quote against a template — the preview the UI shows before anybody commits to sending.
   * The entity type's default template is used when none is named; with no template configured the
   * built-in block layout is rendered instead, which is a valid install rather than a failure.
   */
  @HttpCode(200)
  @Post("quote/:id/render")
  async renderQuote(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(RenderQuoteSchema, body);
    return await this.quoteSend.render(id, input.templateCode);
  }

  /**
   * Send a quote: issue it when it is still a draft, then email it through the mail module.
   *
   * The issuing transition writes server-owned fields (`status`, `number`, the frozen snapshot), so
   * the handler runs as an internal Sales write. A recipient (explicit, or the contact's/account's
   * address) and a configured mail transport are both required — the quote is not issued otherwise.
   */
  @HttpCode(200)
  @Post("quote/:id/send")
  async sendQuote(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(SendQuoteSchema, body);
    return await runAsSalesInternal(() =>
      this.quoteSend.send(id, { ...input }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Payments, allocations and payment requests (19-S.10)
  //
  // A payment is recorded here, never charged here: no handler in this module talks to a gateway.
  // The provider-facing half is `paymentRequest` (a provider-neutral record with a state machine) and
  // `providerEvent` (idempotent ingestion keyed by the provider's own event id).
  // -------------------------------------------------------------------------------------------

  /** Record an incoming or outgoing payment. Its balances are derived, never supplied. */
  @HttpCode(201)
  @Post("payment")
  async createPayment(@Body() body: unknown) {
    const input = parse(CreatePaymentSchema, body);
    return await this.payments.create({ ...input });
  }

  /** A payment with its live balance, recomputed from its allocation rows. */
  @Get("payment/:id")
  async readPayment(@Param("id") id: string) {
    return await this.payments.view(id);
  }

  @HttpCode(200)
  @Patch("payment/:id")
  async updatePayment(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(UpdatePaymentSchema, body);
    return await this.payments.update(id, { ...input });
  }

  /** `confirm` makes a payment allocatable; `cancel` is refused while it has allocations. */
  @HttpCode(200)
  @Post("payment/:id/transition")
  async transitionPayment(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(PaymentTransitionSchema, body);
    return await this.payments.transition(id, input.action, input.reason);
  }

  /** The payment's allocation history. */
  @Get("payment/:id/allocations")
  async paymentAllocations(@Param("id") id: string) {
    return { list: await this.allocations.forPayment(id) };
  }

  /** Apply part of a payment to an issued invoice. Over-allocation is refused with both remainders. */
  @HttpCode(201)
  @Post("payment/:id/allocate")
  async allocatePayment(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(AllocatePaymentSchema, body);
    return await this.allocations.allocate({
      paymentId: id,
      documentId: input.documentId,
      documentEntity: input.documentEntity,
      amount: input.amount,
      audit: this.audit(input.correlationId),
    });
  }

  /** A payment-to-payment transfer (a refund or a moved unapplied amount), as its own record. */
  @HttpCode(200)
  @Post("payment/:id/transfer")
  async transferPayment(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(PaymentTransferSchema, body);
    return await this.allocations.transfer(id, input.toPaymentId, input.amount);
  }

  /** Remove an allocation. Both sides recompute; the removal is evented, never silent. */
  @HttpCode(204)
  @Delete("allocation/:id")
  async unallocate(@Param("id") id: string): Promise<void> {
    await this.allocations.unallocate(id);
  }

  /**
   * The documents a payment may settle: issued invoices for an incoming payment, issued bills for an
   * outgoing one, each with what it still owes (§4.8, §4.12).
   */
  @Get("allocatableDocuments")
  async allocatableDocuments(
    @Query("direction") direction?: string,
    @Query("accountId") accountId?: string,
    @Query("supplierId") supplierId?: string,
  ) {
    return {
      list: await this.payments.allocatableDocuments(
        direction === "outgoing" ? "outgoing" : "incoming",
        { accountId: accountId ?? null, supplierId: supplierId ?? null },
      ),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Credit notes and write-offs (19-S.11)
  //
  // The two supported ways a receivable is reduced without a payment. A credit note is allocated to
  // invoices through explicit rows and locked recomputes, exactly like a payment — but its
  // corrections are *reversals*: the allocation row is kept and marked, never deleted. A write-off is
  // requested with a reason, approved (or rejected) by an administrator — only approval changes a
  // balance — and reversed, if it must be undone, as a compensating state change with its own audit
  // trail (§4.9).
  // -------------------------------------------------------------------------------------------

  /** Allocate part of an issued credit note to an issued invoice. Over-allocation is refused. */
  @HttpCode(201)
  @Post("creditNote/:id/allocate")
  async allocateCreditNote(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(CreditNoteAllocateSchema, body);
    return await this.creditNotes.allocate({
      creditNoteId: id,
      invoiceId: input.invoiceId,
      amount: input.amount,
      audit: this.audit(input.correlationId),
    });
  }

  /** Reverse a credit-note allocation. The row is kept and marked; both balances recompute (§4.9). */
  @HttpCode(200)
  @Delete("creditNote/allocation/:id")
  async unallocateCreditNote(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(CreditNoteUnallocateSchema, body);
    return await this.creditNotes.unallocate(id, {
      ...this.audit(input.correlationId),
      reason: input.reason,
    });
  }

  /** The issued invoices a credit note may be allocated to, with what each still owes. */
  @Get("creditNote/allocatableInvoices")
  async creditNoteAllocatableInvoices(
    @Query("creditNoteId") creditNoteId?: string,
    @Query("accountId") accountId?: string,
  ) {
    return {
      list: await this.creditNotes.allocatableInvoices(
        creditNoteId ?? null,
        accountId ?? null,
      ),
    };
  }

  /** Render a credit note through the kernel `document` module — a named template, or the built-in layout. */
  @HttpCode(200)
  @Post("creditNote/:id/render")
  async renderCreditNote(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(RenderCreditNoteSchema, body);
    return await this.creditNotes.render(id, input.templateCode);
  }

  /** Request a write-off against an issued invoice. A request is `pending` and changes no balance. */
  @HttpCode(201)
  @Post("write-off")
  async requestWriteOff(@Body() body: unknown) {
    const input = parse(WriteOffCreateSchema, body);
    return await this.writeOffs.request({
      invoiceId: input.invoiceId,
      amount: input.amount,
      reason: input.reason,
      audit: this.audit(input.correlationId),
    });
  }

  /** Approve a pending write-off; administrator-only, and re-checked against the live balance. */
  @HttpCode(200)
  @Post("write-off/:id/approve")
  async approveWriteOff(@Param("id") id: string, @Body() body: unknown) {
    this.requireAdmin("approving write-offs");
    const input = parse(WriteOffApproveSchema, body);
    return await this.writeOffs.approve(id, this.audit(input.correlationId));
  }

  /** Reject a pending write-off. The request stays on record; the invoice is untouched. */
  @HttpCode(200)
  @Post("write-off/:id/reject")
  async rejectWriteOff(@Param("id") id: string, @Body() body: unknown) {
    this.requireAdmin("rejecting write-offs");
    const input = parse(WriteOffRejectSchema, body);
    return await this.writeOffs.reject(id, {
      ...this.audit(input.correlationId),
      reason: input.reason,
    });
  }

  /** Reverse an approved write-off, restoring the invoice; the record keeps both entries (§4.9). */
  @HttpCode(200)
  @Post("write-off/:id/reverse")
  async reverseWriteOff(@Param("id") id: string, @Body() body: unknown) {
    this.requireAdmin("reversing write-offs");
    const input = parse(WriteOffReverseSchema, body);
    return await this.writeOffs.reverse(id, {
      ...this.audit(input.correlationId),
      reason: input.reason,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Purchasing (19-S.13): the derived receipt state, and the credits that reduce a payable
  // -------------------------------------------------------------------------------------------

  /**
   * Recompute a purchase order's receipt state from its confirmed receipt orders (§4.12). Derived,
   * not typed, and idempotent — the purchasing twin of `refreshFulfilment`.
   */
  @HttpCode(200)
  @Post("purchaseOrder/:id/refreshReceipt")
  async refreshReceipt(@Param("id") id: string) {
    return await runAsSalesInternal(() => this.documents.refreshReceipt(id));
  }

  /** Allocate part of an issued bill credit to an issued bill. Over-allocation is refused. */
  @HttpCode(201)
  @Post("billCredit/:id/allocate")
  async allocateBillCredit(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(BillCreditAllocateSchema, body);
    return await this.billCredits.allocate({
      billCreditId: id,
      billId: input.billId,
      amount: input.amount,
      audit: this.audit(input.correlationId),
    });
  }

  /** Reverse a bill-credit allocation; the row is kept and marked (§4.12). */
  @HttpCode(200)
  @Delete("billCredit/allocation/:id")
  async unallocateBillCredit(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(BillCreditUnallocateSchema, body);
    return await this.billCredits.unallocate(id, {
      ...this.audit(input.correlationId),
      reason: input.reason,
    });
  }

  /** The bill's credit history — live and reversed allocations both stay on record. */
  @Get("bill/:id/creditAllocations")
  async billCreditAllocations(@Param("id") id: string) {
    return { list: await this.billCredits.forBill(id) };
  }

  /** The issued bills a bill credit may be allocated to, with what each still owes. */
  @Get("billCredit/allocatableBills")
  async billCreditAllocatableBills(
    @Query("billCreditId") billCreditId?: string,
    @Query("supplierId") supplierId?: string,
  ) {
    return {
      list: await this.billCredits.allocatableBills(
        billCreditId ?? null,
        supplierId ?? null,
      ),
    };
  }

  /** A provider-neutral request for a customer to pay. No gateway call happens here. */
  @HttpCode(201)
  @Post("paymentRequest")
  async createPaymentRequest(@Body() body: unknown) {
    const input = parse(CreatePaymentRequestSchema, body);
    return await this.payments.createRequest({ ...input });
  }

  @HttpCode(200)
  @Post("paymentRequest/:id/transition")
  async transitionPaymentRequest(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(PaymentTransitionSchema, body);
    return await this.payments.transitionRequest(id, input.action);
  }

  /** Ingest one provider event. A duplicate delivery changes nothing and says so. */
  @HttpCode(200)
  @Post("providerEvent")
  async providerEvent(@Body() body: unknown) {
    const input = parse(ProviderEventSchema, body);
    return await this.payments.ingestProviderEvent({ ...input });
  }

  /** Expire quotes past their validity date. Idempotent — an administrator may run it by hand. */
  @HttpCode(200)
  @Post("action/expireQuotes")
  async expireQuotes(@Body() body: unknown) {
    this.requireAdmin("expiring quotes");
    const input = parse(ExpireQuotesSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.expireOverdueQuotes(input.today),
    );
  }

  /**
   * The same operation, for the scheduled job (19-S.7).
   *
   * The worker has no user session, so `@Public()` skips session authentication and the shared
   * worker→API capability in `x-worker-secret` is the authorisation — compared in constant time, and
   * refused outright when no capability is configured. The operation is idempotent, so a retried job
   * attempt changes nothing; that is what makes a capability rather than a session the right check
   * here.
   *
   * The capability is the same one the report delivery job uses (`REPORT_WORKER_SECRET`, documented as
   * the shared worker-to-API key). If the two ever need different blast radii, split it then.
   */
  @Public()
  @HttpCode(200)
  @Post("action/expire-quotes")
  async expireQuotesForWorker(
    @Body() body: unknown,
    @Headers("x-worker-secret") secret?: string,
  ) {
    this.assertWorkerSecret(secret);
    const input = parse(ExpireQuotesSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.expireOverdueQuotes(input.today),
    );
  }

  /**
   * Recompute a sales order's fulfilment state from its confirmed delivery orders (19-S.8).
   *
   * The state is derived, not typed: `partiallyFulfilled`/`fulfilled` come from what the order asked
   * for versus what its confirmed deliveries actually moved. Idempotent.
   */
  @HttpCode(200)
  @Post("salesOrder/:id/refreshFulfilment")
  async refreshFulfilment(@Param("id") id: string) {
    return await runAsSalesInternal(() => this.documents.refreshFulfilment(id));
  }

  /** Mark issued invoices past their due date as overdue, emitting one event each (19-S.9). */
  @HttpCode(200)
  @Post("action/markOverdueInvoices")
  async markOverdueInvoices(@Body() body: unknown) {
    this.requireAdmin("overdue detection");
    const input = parse(TodaySchema, body);
    return await runAsSalesInternal(() =>
      this.documents.markOverdueInvoices(input.today),
    );
  }

  /** The same operation for the scheduled job, authorised by the worker capability. */
  @Public()
  @HttpCode(200)
  @Post("action/mark-overdue-invoices")
  async markOverdueInvoicesForWorker(
    @Body() body: unknown,
    @Headers("x-worker-secret") secret?: string,
  ) {
    this.assertWorkerSecret(secret);
    const input = parse(TodaySchema, body);
    return await runAsSalesInternal(() =>
      this.documents.markOverdueInvoices(input.today),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Inventory (19-S.14)
  //
  // Warehouses, the movement ledger and reservations are metadata entities, so create/read/update
  // stay on `/api/v1/Warehouse` and friends. These routes are the operations a single record cannot
  // express: an availability figure that mixes on-hand, reserved and incoming; a reservation; a
  // reviewed adjustment; a two-sided transfer; and the reconciliation of the projection against the
  // ledger. Every one of them is refused outright while `features.inventory` is off.
  // -------------------------------------------------------------------------------------------

  /** On-hand, reserved, available and incoming for one product in one warehouse. */
  @Get("inventory/availability")
  async inventoryAvailability(
    @Query("productId") productId?: string,
    @Query("warehouseId") warehouseId?: string,
  ) {
    return await this.inventory.availability(
      requireQuery(productId, "productId"),
      warehouseId ?? null,
    );
  }

  /** A bounded page of stock levels, optionally filtered by warehouse or product. */
  @Get("inventory/stock")
  async inventoryStock(
    @Query("warehouseId") warehouseId?: string,
    @Query("productId") productId?: string,
    @Query("limit") limit?: string,
  ) {
    return {
      list: await this.inventory.stockList({
        warehouseId: warehouseId ?? null,
        productId: productId ?? null,
        limit: numberOrUndefined(limit),
      }),
    };
  }

  /** Movement history, newest first. Never unbounded (§16.1). */
  @Get("inventory/history")
  async inventoryHistory(
    @Query("productId") productId?: string,
    @Query("warehouseId") warehouseId?: string,
    @Query("limit") limit?: string,
  ) {
    return {
      list: await this.inventory.history({
        productId: productId ?? null,
        warehouseId: warehouseId ?? null,
        limit: numberOrUndefined(limit),
      }),
    };
  }

  /** Compare the stock projection with the ledger; discrepancies are reported, never auto-corrected. */
  @HttpCode(200)
  @Post("inventory/reconcile")
  async inventoryReconcile(@Body() body: unknown) {
    const input = parse(InventoryReconcileSchema, body);
    return await this.inventory.reconcile({
      warehouseId: input.warehouseId ?? null,
      productId: input.productId ?? null,
    });
  }

  /** Active/released reservations, filtered. */
  @Get("inventory/reservations")
  async inventoryReservations(
    @Query("productId") productId?: string,
    @Query("warehouseId") warehouseId?: string,
    @Query("status") status?: string,
    @Query("sourceId") sourceId?: string,
    @Query("limit") limit?: string,
  ) {
    return {
      list: await this.inventory.listReservations({
        productId: productId ?? null,
        warehouseId: warehouseId ?? null,
        status: status ?? null,
        sourceId: sourceId ?? null,
        limit: numberOrUndefined(limit),
      }),
    };
  }

  /** Place a reservation. Under the default `hard` policy an over-reservation is refused. */
  @HttpCode(201)
  @Post("inventory/reserve")
  async reserveStock(@Body() body: unknown) {
    const input = parse(ReserveStockSchema, body);
    return await this.inventory.reserve({ ...input });
  }

  /** Release a reservation, freeing the stock it promised. */
  @HttpCode(200)
  @Post("inventory/reservation/:id/release")
  async releaseReservation(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(ReleaseReservationSchema, body);
    return await this.inventory.releaseReservation(id, input.reason ?? null);
  }

  /** Request a stock correction (reviewed, with a reason). */
  @HttpCode(201)
  @Post("inventory/adjustment")
  async createAdjustment(@Body() body: unknown) {
    const input = parse(CreateAdjustmentSchema, body);
    return await this.inventoryOps.createAdjustment(
      { ...input },
      this.movementContext(undefined),
    );
  }

  /** Approve (move the stock) or reject a pending adjustment. Administrator-only, audited. */
  @HttpCode(200)
  @Post("inventory/adjustment/:id/transition")
  async transitionAdjustment(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    this.requireAdmin("deciding inventory adjustments");
    const input = parse(AdjustmentTransitionSchema, body);
    const result = await this.inventoryOps.transitionAdjustment(
      id,
      input.action,
      input.reason,
      this.movementContext(undefined),
    );
    return result;
  }

  /** Create a draft transfer between two warehouses. */
  @HttpCode(201)
  @Post("inventory/transfer")
  async createTransfer(@Body() body: unknown) {
    const input = parse(CreateTransferSchema, body);
    return await this.inventoryOps.createTransfer({ ...input });
  }

  /** A transfer with its lines. */
  @Get("inventory/transfer/:id")
  async readTransfer(@Param("id") id: string) {
    return await this.inventoryOps.viewTransfer(id);
  }

  /** Transfers dispatched but not yet received — the safe intermediate state. */
  @Get("inventory/transfers/inTransit")
  async listInTransit(@Query("warehouseId") warehouseId?: string) {
    return { list: await this.inventoryOps.listInTransit(warehouseId ?? null) };
  }

  /** `confirm` dispatches, `receive` completes, `cancel` needs a reason (draft only). */
  @HttpCode(200)
  @Post("inventory/transfer/:id/transition")
  async transitionTransfer(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parse(TransferTransitionSchema, body);
    return await this.inventoryOps.transitionTransfer(
      id,
      input.action,
      input.reason,
      this.movementContext(undefined),
    );
  }

  private movementContext(correlationId: string | undefined): MovementContext {
    return {
      actor: this.scope.principal?.userName ?? this.scope.userId ?? null,
      correlationId: correlationId ?? null,
    };
  }

  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === "" || supplied === undefined) {
      throw new AuthenticationFailedError("Invalid worker capability.");
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (
      expectedBytes.length !== suppliedBytes.length ||
      !timingSafeEqual(expectedBytes, suppliedBytes)
    ) {
      throw new AuthenticationFailedError("Invalid worker capability.");
    }
  }

  private audit(correlationId: string | undefined): SalesAuditContext {
    return {
      userId: this.scope.userId,
      userName: this.scope.principal?.userName,
      correlationId,
    };
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(
        `Administrator access is required for ${action}.`,
      );
    }
  }
}

/** A required query parameter, with the same validation error the body parser produces. */
function requireQuery(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new InvalidQueryError(`The "${name}" query parameter is required.`, {
      parameter: name,
    });
  }
  return value.trim();
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T["_output"] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError("The request is not valid.", {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}
