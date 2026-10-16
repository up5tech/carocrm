import { NotFoundError } from '@carocrm/core/errors/index.js';
import type { ReportDefinition } from '@carocrm/reports';
import { ReportDefinitionSchema } from '@carocrm/reports';
import { Injectable } from '@nestjs/common';

/**
 * Phase 19-S.18 — the curated Sales report datasets (§12.1, §12.2, §12.3).
 *
 * A dataset is a plain `ReportDefinition` of the generic Report subsystem, so running one goes
 * through `ReportService`: entity existence, per-field read permission, record-level ACL, the Query
 * Engine's filter grammar and the cost limits are all enforced there, not duplicated here. This
 * module only decides *which* reports a commercial user is offered and what each one means.
 *
 * Money (§4.13, §12.4): a dataset never adds up two currencies as if they were one. Either it sums
 * the persisted base-currency snapshot (`baseGrossTotal`), which only exists on the documents that
 * were issued with a conversion snapshot — in which case `coverage` reports how much of the gross
 * was actually converted — or it groups by `currency` so each column stays single-currency.
 */

/** How a dataset's money values should be read (§12.4 labeling requirement). */
export type SalesMoneyBasis = 'base-snapshot' | 'document-currency' | 'quantity' | 'count';

export interface SalesReportDataset {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly moneyBasis: SalesMoneyBasis;
  readonly definition: ReportDefinition;
}

/** Build-time structural check; field existence and permissions are checked when the report runs. */
function dataset(
  input: Omit<SalesReportDataset, 'definition'> & { definition: unknown },
): SalesReportDataset {
  return { ...input, definition: ReportDefinitionSchema.parse(input.definition) };
}

const OPEN_QUOTE_STATES = ['draft', 'sent', 'accepted'];
const SETTLEMENT_STATES = ['unpaid', 'partiallyPaid', 'overdue'];
const PENDING_PERIOD_STATES = ['pending', 'processing', 'failed'];

export const SALES_REPORT_DATASETS: readonly SalesReportDataset[] = [
  dataset({
    key: 'quotePipeline',
    label: 'Quote pipeline',
    description:
      'Open quotes by status. Value is the frozen base-currency snapshot; coverage is the share of gross that has one.',
    moneyBasis: 'base-snapshot',
    definition: {
      version: 1,
      entityType: 'Quote',
      kind: 'grouped',
      filters: [{ field: 'status', operator: 'in', value: OPEN_QUOTE_STATES }],
      columns: [],
      groupBy: { field: 'status' },
      metrics: [
        { name: 'quote_count', operation: 'count' },
        { name: 'base_value', operation: 'sum', field: 'baseGrossTotal' },
      ],
    },
  }),
  dataset({
    key: 'quoteOutcome',
    label: 'Quote outcome',
    description:
      'Every quote this installation holds, by state — the conversion view a selling team reads against the pipeline above (§12.1).',
    moneyBasis: 'count',
    definition: {
      version: 1,
      entityType: 'Quote',
      kind: 'grouped',
      filters: [],
      columns: [],
      groupBy: { field: 'status' },
      metrics: [{ name: 'quote_count', operation: 'count' }],
    },
  }),
  dataset({
    key: 'writeOffs',
    label: 'Write-offs by state',
    description:
      'Balances forgiven rather than paid (§4.9). Only an approved write-off has reduced a receivable, and only while it stays un-reversed.',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'WriteOff',
      kind: 'grouped',
      filters: [],
      columns: [],
      groupBy: { field: 'status' },
      metrics: [
        { name: 'write_off_count', operation: 'count' },
        { name: 'written_off', operation: 'sum', field: 'amount' },
      ],
    },
  }),
  dataset({
    key: 'invoiceAging',
    label: 'Invoice aging',
    description:
      'Issued, not-yet-settled invoices by due-date month. Outstanding is summed per document currency, so read it together with the currency dataset below.',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'Invoice',
      kind: 'grouped',
      filters: [
        { field: 'status', operator: 'equals', value: 'issued' },
        { field: 'paymentStatus', operator: 'in', value: SETTLEMENT_STATES },
      ],
      columns: [],
      groupBy: { field: 'dueDate', grain: 'month' },
      metrics: [
        { name: 'invoice_count', operation: 'count' },
        { name: 'outstanding', operation: 'sum', field: 'amountDue' },
      ],
    },
  }),
  dataset({
    key: 'receivableByCurrency',
    label: 'Receivables by currency',
    description: 'Unsettled invoice value grouped by currency, so no two currencies are added together.',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'Invoice',
      kind: 'grouped',
      filters: [
        { field: 'status', operator: 'equals', value: 'issued' },
        { field: 'paymentStatus', operator: 'in', value: SETTLEMENT_STATES },
      ],
      columns: [],
      groupBy: { field: 'currency' },
      metrics: [
        { name: 'invoice_count', operation: 'count' },
        { name: 'outstanding', operation: 'sum', field: 'amountDue' },
        { name: 'settled_base', operation: 'sum', field: 'baseGrossTotal' },
      ],
    },
  }),
  dataset({
    key: 'payableByCurrency',
    label: 'Supplier payables by currency',
    description: 'Issued, unsettled supplier bills grouped by currency (19-S.13).',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'Bill',
      kind: 'grouped',
      filters: [
        { field: 'status', operator: 'equals', value: 'issued' },
        { field: 'paymentStatus', operator: 'in', value: SETTLEMENT_STATES },
      ],
      columns: [],
      groupBy: { field: 'currency' },
      metrics: [
        { name: 'bill_count', operation: 'count' },
        { name: 'outstanding', operation: 'sum', field: 'amountDue' },
      ],
    },
  }),
  dataset({
    key: 'paymentFlow',
    label: 'Confirmed payments by direction',
    description:
      'Money in and out, valued at the conversion frozen on each payment (19-S.18). A payment recorded without a rate contributes nothing here, so this is not the same total as the currency dataset.',
    moneyBasis: 'base-snapshot',
    definition: {
      version: 1,
      entityType: 'Payment',
      kind: 'grouped',
      filters: [{ field: 'status', operator: 'equals', value: 'confirmed' }],
      columns: [],
      groupBy: { field: 'direction' },
      metrics: [
        { name: 'payment_count', operation: 'count' },
        { name: 'base_total', operation: 'sum', field: 'baseAmount' },
        { name: 'base_unallocated', operation: 'sum', field: 'baseUnallocatedAmount' },
      ],
    },
  }),
  dataset({
    key: 'paymentsByCurrency',
    label: 'Confirmed payments by currency',
    description: 'The same money kept inside its own currency, so no two currencies are added together.',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'Payment',
      kind: 'grouped',
      filters: [{ field: 'status', operator: 'equals', value: 'confirmed' }],
      columns: [],
      groupBy: { field: 'currency' },
      metrics: [
        { name: 'payment_count', operation: 'count' },
        { name: 'amount_total', operation: 'sum', field: 'amount' },
        { name: 'unallocated_total', operation: 'sum', field: 'unallocatedAmount' },
      ],
    },
  }),
  dataset({
    key: 'allocationsBaseByMonth',
    label: 'Allocations in base currency by month',
    description:
      'What was actually applied to documents each month, at the conversion frozen on the paying record (19-S.18).',
    moneyBasis: 'base-snapshot',
    definition: {
      version: 1,
      entityType: 'PaymentAllocation',
      kind: 'grouped',
      filters: [],
      columns: [],
      groupBy: { field: 'allocatedAt', grain: 'month' },
      metrics: [
        { name: 'allocation_count', operation: 'count' },
        { name: 'base_allocated', operation: 'sum', field: 'baseAmount' },
      ],
    },
  }),
  dataset({
    key: 'allocationsByMonth',
    label: 'Allocations by month',
    description: 'How much of the ledger was applied to documents each month, per currency.',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'PaymentAllocation',
      kind: 'matrix',
      filters: [],
      columns: [],
      matrix: { rows: { field: 'allocatedAt', grain: 'month' }, columns: { field: 'currency' } },
      metrics: [
        { name: 'allocation_count', operation: 'count' },
        { name: 'allocated', operation: 'sum', field: 'amount' },
      ],
    },
  }),
  dataset({
    key: 'creditNoteOutstanding',
    label: 'Unapplied credit',
    description: 'Issued credit notes and the credit still waiting to be allocated to an invoice (§4.9).',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'CreditNote',
      kind: 'grouped',
      filters: [{ field: 'status', operator: 'equals', value: 'issued' }],
      columns: [],
      groupBy: { field: 'currency' },
      metrics: [
        { name: 'credit_note_count', operation: 'count' },
        { name: 'unallocated', operation: 'sum', field: 'unallocatedAmount' },
      ],
    },
  }),
  dataset({
    key: 'billCreditOutstanding',
    label: 'Unapplied supplier credit',
    description: 'Issued bill credits not yet applied to a bill (19-S.13).',
    moneyBasis: 'document-currency',
    definition: {
      version: 1,
      entityType: 'BillCredit',
      kind: 'summary',
      filters: [{ field: 'status', operator: 'equals', value: 'issued' }],
      columns: [],
      metrics: [
        { name: 'bill_credit_count', operation: 'count' },
        { name: 'unallocated', operation: 'sum', field: 'unallocatedAmount' },
      ],
    },
  }),
  dataset({
    key: 'purchasePipeline',
    label: 'Purchase orders by status',
    description: 'Open purchasing commitment by document status, in the frozen base snapshot.',
    moneyBasis: 'base-snapshot',
    definition: {
      version: 1,
      entityType: 'PurchaseOrder',
      kind: 'grouped',
      filters: [{ field: 'status', operator: 'equals', value: 'confirmed' }],
      columns: [],
      groupBy: { field: 'status' },
      metrics: [
        { name: 'order_count', operation: 'count' },
        { name: 'base_value', operation: 'sum', field: 'baseGrossTotal' },
      ],
    },
  }),
  dataset({
    key: 'upcomingBillingPeriods',
    label: 'Upcoming subscription billing',
    description:
      'Subscription periods still pending, processing or failed, with the date their invoice is planned (19-S.16).',
    moneyBasis: 'count',
    definition: {
      version: 1,
      entityType: 'SubscriptionPeriod',
      kind: 'list',
      filters: [{ field: 'status', operator: 'in', value: PENDING_PERIOD_STATES }],
      columns: ['name', 'status', 'periodStart', 'periodEnd', 'plannedInvoiceDate', 'attemptCount'],
    },
  }),
  dataset({
    key: 'subscriptionStatus',
    label: 'Subscriptions by status',
    description: 'The recurring book: how many subscriptions sit in each state.',
    moneyBasis: 'count',
    definition: {
      version: 1,
      entityType: 'Subscription',
      kind: 'grouped',
      filters: [],
      columns: [],
      groupBy: { field: 'status' },
      metrics: [{ name: 'subscription_count', operation: 'count' }],
    },
  }),
];

const BY_KEY = new Map(SALES_REPORT_DATASETS.map((entry) => [entry.key, entry]));

@Injectable()
export class SalesReportCatalogService {
  catalog(): readonly Omit<SalesReportDataset, 'definition'>[] {
    return SALES_REPORT_DATASETS.map(({ definition: _definition, ...publicView }) => publicView);
  }

  /** The saved definition for one key, with nothing added and nothing inferred from the caller. */
  definition(key: string): ReportDefinition {
    const found = BY_KEY.get(key);
    if (!found) {
      throw new NotFoundError(`Sales report dataset "${key}" does not exist.`);
    }
    return found.definition;
  }
}
