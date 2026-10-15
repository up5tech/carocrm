import type { Provider, Type } from '@nestjs/common';

import { SalesCatalogGuardService } from './catalog/sales-guard.service.js';
import { SalesDocumentService } from './document/document.service.js';
import { SalesNumberingService } from './document/numbering.service.js';
import { SalesQuoteSendService } from './document/quote-send.service.js';
import { AllocationService } from './payments/allocation.service.js';
import { PaymentService } from './payments/payment.service.js';
import { BulkPriceService } from './pricing/bulk-price.service.js';
import { PriceResolutionService } from './pricing/price-resolution.service.js';
import { SalesController } from './sales.controller.js';
import { SalesModuleHealthService } from './sales-module-health.service.js';
import { SalesRecords } from './sales-records.js';
import { SalesSettingsService } from './sales-settings.service.js';
import { SalesTaxService } from './tax/tax.service.js';
import { SalesWriteGuardService } from './sales-write-guard.service.js';

/**
 * Sales & Commercial Operations module barrel (PLAN_Phase_19_Sales.md §14, 19-S.1).
 *
 * Like every other domain here, Sales is a directory under `apps/api/src`, not a second framework:
 * entity records use the generic `entity_records` store, and ACL, audit, stream, attachments,
 * hooks, jobs and search are the kernel's and are reused rather than re-implemented.
 *
 * `SALES_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: this controller
 * owns the static `/api/v1/Sales` prefix, and the generic `:entity` wildcard has to stay last so
 * static routes win (docs/module-guide.md).
 */
export const SALES_CONTROLLERS: Type<unknown>[] = [SalesController];

export const SALES_PROVIDERS: Provider[] = [
  SalesRecords,
  SalesSettingsService,
  SalesNumberingService,
  SalesCatalogGuardService,
  SalesWriteGuardService,
  SalesDocumentService,
  SalesQuoteSendService,
  PaymentService,
  AllocationService,
  PriceResolutionService,
  BulkPriceService,
  SalesTaxService,
  SalesModuleHealthService,
];

export { SalesCatalogGuardService } from './catalog/sales-guard.service.js';
export { DEFAULT_NUMBER_SERIES, SalesNumberingService } from './document/numbering.service.js';
export { buildDocumentSnapshot, readDocumentSnapshot } from './document/snapshot.js';
export { BulkPriceService } from './pricing/bulk-price.service.js';
export { PriceResolutionService } from './pricing/price-resolution.service.js';
export { SalesController } from './sales.controller.js';
export { DOCUMENT_DESCRIPTORS, documentDescriptor, IMPLEMENTED_DOCUMENT_KINDS } from './document/descriptors.js';
export { SalesDocumentService } from './document/document.service.js';
export { quoteBlocks, quoteTemplateData, quoteText } from './document/quote-document.js';
export { SalesQuoteSendService, type QuoteRenderResult, type SendQuoteInput, type SendQuoteResult } from './document/quote-send.service.js';
export { assertDocumentEditable, isLocked, protectedFields } from './document/lock.js';
export { AllocationService } from './payments/allocation.service.js';
export { PaymentService } from './payments/payment.service.js';
export { paymentBalance, documentOutstanding, invoicePaymentStatus } from './payments/allocation-math.js';
export { SALES_MODULE } from './sales-module.js';
export { SALES_ENTITY_TYPES,SalesRecords } from './sales-records.js';
export { DEFAULT_SALES_SETTINGS,SalesSettingsService } from './sales-settings.service.js';
export { SalesTaxService } from './tax/tax.service.js';
export { computeTotals } from './tax/totals.js';
