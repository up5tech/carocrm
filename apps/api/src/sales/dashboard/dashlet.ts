import { Injectable } from '@nestjs/common';

import { DashletConfigSchema } from '../../search/portal-shapes.js';

/**
 * Phase 19-S.18 — the standard Sales dashlets (§9.5, §12).
 *
 * These are *definitions*, not a new dashboard engine: each one is a config the shared runner in
 * `DashboardService` already knows how to execute (`list`, `chart`, `kpi`), so access control,
 * the bounded scan and the `truncated` flag come from there. An administrator copies one into a
 * dashboard through the ordinary `POST /api/v1/Dashboard/:id/dashlets` route; nothing here writes.
 */
export interface SalesDashletDefinition {
  readonly key: string;
  readonly name: string;
  readonly kind: 'list' | 'chart' | 'kpi';
  readonly description: string;
  readonly config: Record<string, unknown>;
}

const OPEN_INVOICE_WHERE = [
  { field: 'status', operator: 'equals', value: 'issued' },
  { field: 'paymentStatus', operator: 'in', value: ['unpaid', 'partiallyPaid', 'overdue'] },
];

export const SALES_DASHLET_DEFINITIONS: readonly SalesDashletDefinition[] = [
  {
    key: 'overdueInvoices',
    name: 'Overdue invoices',
    kind: 'list',
    description: 'Issued invoices that are past due and still open.',
    config: {
      entity: 'Invoice',
      where: [
        { field: 'status', operator: 'equals', value: 'issued' },
        { field: 'paymentStatus', operator: 'equals', value: 'overdue' },
      ],
      maxSize: 10,
    },
  },
  {
    key: 'openInvoiceValue',
    name: 'Open invoice value',
    kind: 'kpi',
    description:
      'Total amount due on unsettled invoices. Sums across currencies, so read it next to "receivables by currency".',
    config: { entity: 'Invoice', where: OPEN_INVOICE_WHERE, measure: 'amountDue', aggregation: 'sum', maxSize: 200 },
  },
  {
    key: 'unallocatedPayments',
    name: 'Unallocated payments',
    kind: 'kpi',
    description: 'Confirmed incoming money not yet applied to a document.',
    config: {
      entity: 'Payment',
      where: [
        { field: 'status', operator: 'equals', value: 'confirmed' },
        { field: 'direction', operator: 'equals', value: 'incoming' },
      ],
      measure: 'unallocatedAmount',
      aggregation: 'sum',
      maxSize: 200,
    },
  },
  {
    key: 'quotePipeline',
    name: 'Open quotes by status',
    kind: 'chart',
    description: 'Count and frozen base-currency value of quotes that are still open.',
    config: {
      entity: 'Quote',
      where: [{ field: 'status', operator: 'in', value: ['draft', 'sent', 'accepted'] }],
      groupBy: 'status',
      measure: 'baseGrossTotal',
      aggregation: 'sum',
      maxSize: 200,
    },
  },
  {
    key: 'invoiceCurrencySplit',
    name: 'Receivables by currency',
    kind: 'chart',
    description: 'Open invoice value split by currency, so no two currencies are added together.',
    config: { entity: 'Invoice', where: OPEN_INVOICE_WHERE, groupBy: 'currency', measure: 'amountDue', aggregation: 'sum', maxSize: 200 },
  },
  {
    key: 'upcomingBillingPeriods',
    name: 'Upcoming billing periods',
    kind: 'list',
    description: 'Subscription periods whose invoice is still pending or failed (19-S.16).',
    config: {
      entity: 'SubscriptionPeriod',
      where: [{ field: 'status', operator: 'in', value: ['pending', 'processing', 'failed'] }],
      maxSize: 10,
    },
  },
  {
    key: 'creditNotesToApply',
    name: 'Credit waiting to be applied',
    kind: 'chart',
    description: 'Issued credit notes by currency and the credit still unallocated (§4.9).',
    config: {
      entity: 'CreditNote',
      where: [{ field: 'status', operator: 'equals', value: 'issued' }],
      groupBy: 'currency',
      measure: 'unallocatedAmount',
      aggregation: 'sum',
      maxSize: 200,
    },
  },
];

@Injectable()
export class SalesDashletCatalogService {
  constructor() {
    // Fail fast, at boot, if a definition stops matching the shape the shared runner accepts.
    for (const entry of SALES_DASHLET_DEFINITIONS) {
      const parsed = DashletConfigSchema.safeParse(entry.config);
      if (!parsed.success) {
        throw new Error(`Sales dashlet "${entry.key}" has an invalid config: ${parsed.error.message}`);
      }
    }
  }

  /**
   * Ready to POST as-is to `/api/v1/Dashboard/:dashboardId/dashlets` (`{name, kind, position,
   * config}`); the shared route validates it again against its own schema and the entity metadata.
   */
  catalog(): readonly Record<string, unknown>[] {
    return SALES_DASHLET_DEFINITIONS.map((entry) => ({
      key: entry.key,
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      position: 0,
      config: entry.config,
    }));
  }
}
