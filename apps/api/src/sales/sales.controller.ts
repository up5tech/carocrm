import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, AuthorizationDeniedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { Public } from '../auth/auth.guard.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { CONFIG_TOKEN, type AppConfig } from '../config.js';
import { requireDocumentKind } from './document/descriptors.js';
import { SalesDocumentService } from './document/document.service.js';
import { SalesNumberingService } from './document/numbering.service.js';
import { SalesQuoteSendService } from './document/quote-send.service.js';
import {
  AllocatePaymentSchema,
  BulkPriceUpdateSchema,
  CreateDocumentSchema,
  CreatePaymentRequestSchema,
  CreatePaymentSchema,
  DocumentConvertSchema,
  DocumentTransitionSchema,
  DocumentUnlockSchema,
  ExpireQuotesSchema,
  PaymentTransferSchema,
  PaymentTransitionSchema,
  PreviewTotalsSchema,
  ProviderEventSchema,
  RenderQuoteSchema,
  ResolvePriceSchema,
  SalesSettingsPatchSchema,
  SendQuoteSchema,
  TodaySchema,
  UpdateDocumentSchema,
  UpdatePaymentSchema,
} from './dto/sales-shapes.js';
import { AllocationService } from './payments/allocation.service.js';
import { PaymentService } from './payments/payment.service.js';
import { BulkPriceService } from './pricing/bulk-price.service.js';
import { PriceResolutionService } from './pricing/price-resolution.service.js';
import { SalesModuleHealthService } from './sales-module-health.service.js';
import { SalesSettingsService } from './sales-settings.service.js';
import { runAsSalesInternal } from './sales-internal.js';
import { SalesTaxService } from './tax/tax.service.js';
import type { SalesAuditContext } from './document/types.js';

/**
 * Phase 19-S.1 – 19-S.12 — Sales domain commands (`/api/v1/Sales`).
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
@ApiTags('sales')
@Controller('api/v1/Sales')
export class SalesController {
  constructor(
    @Inject(SalesModuleHealthService) private readonly health: SalesModuleHealthService,
    @Inject(SalesSettingsService) private readonly settings: SalesSettingsService,
    @Inject(SalesNumberingService) private readonly numbering: SalesNumberingService,
    @Inject(SalesDocumentService) private readonly documents: SalesDocumentService,
    @Inject(SalesQuoteSendService) private readonly quoteSend: SalesQuoteSendService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(AllocationService) private readonly allocations: AllocationService,
    @Inject(PriceResolutionService) private readonly prices: PriceResolutionService,
    @Inject(BulkPriceService) private readonly bulkPrices: BulkPriceService,
    @Inject(SalesTaxService) private readonly tax: SalesTaxService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Module diagnostics: dependencies, optional integrations, features and checks. Admin only. */
  @Get('action/health')
  async moduleHealth() {
    this.requireAdmin('module diagnostics');
    return this.health.health();
  }

  /** The validated settings document plus the computed defaults and warnings. */
  @Get('action/settings')
  async readSettings() {
    return this.settings.read();
  }

  /** Update settings; high-impact policy is administrator-only (§13). */
  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    this.requireAdmin('changing Sales settings');
    parse(SalesSettingsPatchSchema, body);
    return this.settings.update(body);
  }

  /** Number series with the next unallocated number — allocation itself happens at issuance. */
  @Get('action/numbering')
  async numberingState() {
    this.requireAdmin('document numbering');
    return { list: await this.numbering.list() };
  }

  /** Resolve one line's price, with the explanation of which source won (§4.3). */
  @HttpCode(200)
  @Post('action/resolvePrice')
  async resolvePrice(@Body() body: unknown) {
    const input = parse(ResolvePriceSchema, body);
    return this.prices.resolve(input);
  }

  /** Preview or apply a bulk price change; `apply` is audited and bounded (§4.3). */
  @HttpCode(200)
  @Post('action/bulkPriceUpdate')
  async bulkPriceUpdate(@Body() body: unknown) {
    const input = parse(BulkPriceUpdateSchema, body);
    return this.bulkPrices.run(input);
  }

  /** Server-calculated totals: discounts, shipping, tax breakdown and rounding policy (§4.12, §5.7). */
  @HttpCode(200)
  @Post('action/previewTotals')
  async previewTotals(@Body() body: unknown) {
    const input = parse(PreviewTotalsSchema, body);
    return this.tax.preview(input);
  }

  // -------------------------------------------------------------------------------------------
  // Commercial documents (19-S.6 – 19-S.12)
  //
  // Every handler below wraps its work in `runAsSalesInternal`: these are the module's own commands,
  // and they are the only callers allowed to move a computed field (`number`, `status`, `amountDue`,
  // the issuance and lock fields). The write guard refuses exactly those fields on the generic
  // `/api/v1/:entity` path, which is what stops a crafted request from forging a paid invoice (§4.7).
  // -------------------------------------------------------------------------------------------

  /** Create a draft quote/order/invoice/credit note/delivery/return with typed line items. */
  @HttpCode(201)
  @Post('document')
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
  @Get('document/:kind/:id')
  async readDocument(@Param('kind') kind: string, @Param('id') id: string) {
    return this.documents.view(requireDocumentKind(kind), id);
  }

  /** Update a draft. A locked document refuses changes to its protected fields, by name (§4.7). */
  @HttpCode(200)
  @Patch('document/:kind/:id')
  async updateDocument(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown) {
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
  @Post('document/:kind/:id/transition')
  async transitionDocument(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown) {
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
  @Post('document/:kind/:id/unlock')
  async unlockDocument(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(DocumentUnlockSchema, body);
    return await runAsSalesInternal(() => this.documents.unlock(requireDocumentKind(kind), id, input.reason, this.audit(undefined)));
  }

  /** Convert to another document kind, copying values by value and idempotent on `correlationId`. */
  @HttpCode(201)
  @Post('document/:kind/:id/convert')
  async convertDocument(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(DocumentConvertSchema, body);
    return await runAsSalesInternal(() =>
      this.documents.convert(requireDocumentKind(kind), id, input.action, this.audit(input.correlationId), input.overrides ?? {}),
    );
  }

  /** Recalculate from the server's own numbers. An issued document is never rewritten by this. */
  @HttpCode(200)
  @Post('document/:kind/:id/recalculate')
  async recalculateDocument(@Param('kind') kind: string, @Param('id') id: string) {
    return await runAsSalesInternal(() => this.documents.recalculate(requireDocumentKind(kind), id));
  }

  /** Delete a **draft** only; an issued document is voided or credited instead (§4.9). */
  @HttpCode(204)
  @Delete('document/:kind/:id')
  async deleteDocument(@Param('kind') kind: string, @Param('id') id: string): Promise<void> {
    await runAsSalesInternal(() => this.documents.removeDraft(requireDocumentKind(kind), id));
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
  @Post('quote/:id/render')
  async renderQuote(@Param('id') id: string, @Body() body: unknown) {
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
  @Post('quote/:id/send')
  async sendQuote(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(SendQuoteSchema, body);
    return await runAsSalesInternal(() => this.quoteSend.send(id, { ...input }));
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
  @Post('payment')
  async createPayment(@Body() body: unknown) {
    const input = parse(CreatePaymentSchema, body);
    return await this.payments.create({ ...input });
  }

  /** A payment with its live balance, recomputed from its allocation rows. */
  @Get('payment/:id')
  async readPayment(@Param('id') id: string) {
    return await this.payments.view(id);
  }

  @HttpCode(200)
  @Patch('payment/:id')
  async updatePayment(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(UpdatePaymentSchema, body);
    return await this.payments.update(id, { ...input });
  }

  /** `confirm` makes a payment allocatable; `cancel` is refused while it has allocations. */
  @HttpCode(200)
  @Post('payment/:id/transition')
  async transitionPayment(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(PaymentTransitionSchema, body);
    return await this.payments.transition(id, input.action, input.reason);
  }

  /** The payment's allocation history. */
  @Get('payment/:id/allocations')
  async paymentAllocations(@Param('id') id: string) {
    return { list: await this.allocations.forPayment(id) };
  }

  /** Apply part of a payment to an issued invoice. Over-allocation is refused with both remainders. */
  @HttpCode(201)
  @Post('payment/:id/allocate')
  async allocatePayment(@Param('id') id: string, @Body() body: unknown) {
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
  @Post('payment/:id/transfer')
  async transferPayment(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(PaymentTransferSchema, body);
    return await this.allocations.transfer(id, input.toPaymentId, input.amount);
  }

  /** Remove an allocation. Both sides recompute; the removal is evented, never silent. */
  @HttpCode(204)
  @Delete('allocation/:id')
  async unallocate(@Param('id') id: string): Promise<void> {
    await this.allocations.unallocate(id);
  }

  /** The invoices a payment may be allocated to, with what each still owes. */
  @Get('allocatableInvoices')
  async allocatableInvoices(@Query('direction') direction?: string, @Query('accountId') accountId?: string) {
    return { list: await this.payments.allocatableInvoices(direction === 'outgoing' ? 'outgoing' : 'incoming', accountId ?? null) };
  }

  /** A provider-neutral request for a customer to pay. No gateway call happens here. */
  @HttpCode(201)
  @Post('paymentRequest')
  async createPaymentRequest(@Body() body: unknown) {
    const input = parse(CreatePaymentRequestSchema, body);
    return await this.payments.createRequest({ ...input });
  }

  @HttpCode(200)
  @Post('paymentRequest/:id/transition')
  async transitionPaymentRequest(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(PaymentTransitionSchema, body);
    return await this.payments.transitionRequest(id, input.action);
  }

  /** Ingest one provider event. A duplicate delivery changes nothing and says so. */
  @HttpCode(200)
  @Post('providerEvent')
  async providerEvent(@Body() body: unknown) {
    const input = parse(ProviderEventSchema, body);
    return await this.payments.ingestProviderEvent({ ...input });
  }

  /** Expire quotes past their validity date. Idempotent — an administrator may run it by hand. */
  @HttpCode(200)
  @Post('action/expireQuotes')
  async expireQuotes(@Body() body: unknown) {
    this.requireAdmin('expiring quotes');
    const input = parse(ExpireQuotesSchema, body);
    return await runAsSalesInternal(() => this.documents.expireOverdueQuotes(input.today));
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
  @Post('action/expire-quotes')
  async expireQuotesForWorker(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(ExpireQuotesSchema, body);
    return await runAsSalesInternal(() => this.documents.expireOverdueQuotes(input.today));
  }

  /**
   * Recompute a sales order's fulfilment state from its confirmed delivery orders (19-S.8).
   *
   * The state is derived, not typed: `partiallyFulfilled`/`fulfilled` come from what the order asked
   * for versus what its confirmed deliveries actually moved. Idempotent.
   */
  @HttpCode(200)
  @Post('salesOrder/:id/refreshFulfilment')
  async refreshFulfilment(@Param('id') id: string) {
    return await runAsSalesInternal(() => this.documents.refreshFulfilment(id));
  }

  /** Mark issued invoices past their due date as overdue, emitting one event each (19-S.9). */
  @HttpCode(200)
  @Post('action/markOverdueInvoices')
  async markOverdueInvoices(@Body() body: unknown) {
    this.requireAdmin('overdue detection');
    const input = parse(TodaySchema, body);
    return await runAsSalesInternal(() => this.documents.markOverdueInvoices(input.today));
  }

  /** The same operation for the scheduled job, authorised by the worker capability. */
  @Public()
  @HttpCode(200)
  @Post('action/mark-overdue-invoices')
  async markOverdueInvoicesForWorker(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(TodaySchema, body);
    return await runAsSalesInternal(() => this.documents.markOverdueInvoices(input.today));
  }

  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === '' || supplied === undefined) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError('Invalid worker capability.');
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
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError('The request is not valid.', { issues: parsed.error.issues.map((issue) => issue.message) });
  }
  return parsed.data;
}
