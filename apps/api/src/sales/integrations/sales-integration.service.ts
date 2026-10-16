import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../../acl/acl-api.service.js';
import { EntityCrudService } from '../../entity/entity.service.js';
import { requireDocumentKind } from '../document/descriptors.js';
import { SalesDocumentService } from '../document/document.service.js';
import { currencyScale } from '../money/currency.js';
import { add, format, parseDecimal, zero } from '../money/decimal.js';

/**
 * Phase 19-S.19 — the read contracts Sales publishes to other modules (§11.2–§11.4).
 *
 * A consumer (an accounting package, Customer Success, a gateway integration) must not have to read
 * Sales' tables or guess what a number means. These two commands answer from the same records the UI
 * reads, with the same access control applied by `EntityCrudService`, wrapped in a `contractVersion` so
 * a consumer can tell whether it is speaking to a version it was written against. Adding a field is
 * compatible; renaming, retyping or removing one raises `SALES_CONTRACT_VERSION`.
 *
 * Money rules (§4.13, §12.4): an amount is always paired with the currency it is in; base-currency
 * values appear only where the record carries a frozen conversion, and are labelled as that snapshot.
 * Nothing here re-rates historical money.
 */
export const SALES_CONTRACT_VERSION = 1;

const OPEN_PAYMENT_STATES = ['unpaid', 'partiallyPaid', 'overdue'];

/** The settlement rows that may stand against a document, each with its own link field. */
const SETTLEMENT_ROWS: readonly {
  readonly entity: 'PaymentAllocation' | 'CreditNoteAllocation' | 'BillCreditAllocation' | 'WriteOff';
  readonly key: 'documentId' | 'invoiceId' | 'billId';
  readonly out: 'allocations' | 'credits' | 'writeOffs';
  readonly approvedOnly: boolean;
}[] = [
  { entity: 'PaymentAllocation', key: 'documentId', out: 'allocations', approvedOnly: false },
  { entity: 'CreditNoteAllocation', key: 'invoiceId', out: 'credits', approvedOnly: false },
  { entity: 'BillCreditAllocation', key: 'billId', out: 'credits', approvedOnly: false },
  { entity: 'WriteOff', key: 'invoiceId', out: 'writeOffs', approvedOnly: true },
];

@Injectable()
export class SalesIntegrationService {
  constructor(
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(SalesDocumentService) private readonly documents: SalesDocumentService,
  ) {}

  /**
   * The commercial position of one customer, for a module that displays it rather than bills it
   * (§11.4). Read-only and bounded: it never creates, settles or reverses anything.
   */
  async customerSummary(accountId: string): Promise<Record<string, unknown>> {
    const account = accountId.trim();
    if (account === '') throw new ValidationError('An account id is required.', { accountId });
    for (const entity of ['Invoice', 'CreditNote', 'Payment', 'Subscription']) {
      await this.acl.assertAccess(entity, 'read');
    }

    const [invoices, credits, payments, subscriptions] = await Promise.all([
      this.entities.list('Invoice', {
        where: [
          { field: 'accountId', operator: 'equals', value: account },
          { field: 'status', operator: 'equals', value: 'issued' },
          { field: 'paymentStatus', operator: 'in', value: OPEN_PAYMENT_STATES },
        ],
        select: 'number,dueDate,currency,amountDue,paymentStatus',
        maxSize: 200,
        total: true,
      }),
      this.entities.list('CreditNote', {
        where: [
          { field: 'accountId', operator: 'equals', value: account },
          { field: 'status', operator: 'equals', value: 'issued' },
        ],
        select: 'number,currency,unallocatedAmount',
        maxSize: 200,
        total: true,
      }),
      this.entities.list('Payment', {
        where: [
          { field: 'accountId', operator: 'equals', value: account },
          { field: 'direction', operator: 'equals', value: 'incoming' },
          { field: 'status', operator: 'equals', value: 'confirmed' },
        ],
        select: 'reference,paymentDate,amount,currency,baseAmount,baseCurrency,allocationStatus',
        maxSize: 20,
        total: true,
      }),
      this.entities.list('Subscription', {
        where: [
          { field: 'accountId', operator: 'equals', value: account },
          { field: 'status', operator: 'equals', value: 'active' },
        ],
        select: 'name,renewalDate,currency',
        maxSize: 100,
        total: true,
      }),
    ]);

    return {
      contractVersion: SALES_CONTRACT_VERSION,
      accountId: account,
      receivables: {
        openInvoiceCount: total(invoices),
        outstandingByCurrency: groupSum(
          invoices.list,
          (row) => String(row['currency'] ?? 'USD'),
          (row) => String(row['amountDue'] ?? '0'),
        ),
        oldestUnsettled: invoices.list
          .map((row) => String(row['dueDate'] ?? ''))
          .filter((date) => date !== '')
          .sort()[0] ?? null,
        unappliedCreditByCurrency: groupSum(
          credits.list,
          (row) => String(row['currency'] ?? 'USD'),
          (row) => String(row['unallocatedAmount'] ?? '0'),
        ),
      },
      recentPayments: payments.list.map((payment) => ({
        id: String(payment['id']),
        reference: payment['reference'] ?? null,
        paymentDate: payment['paymentDate'] ?? null,
        amount: String(payment['amount'] ?? '0'),
        currency: String(payment['currency'] ?? 'USD'),
        // Present only when the payment was recorded with a conversion; never computed here.
        baseAmount: payment['baseAmount'] == null ? null : String(payment['baseAmount']),
        baseCurrency: payment['baseCurrency'] == null ? null : String(payment['baseCurrency']),
        allocationStatus: payment['allocationStatus'] ?? null,
      })),
      activeSubscriptions: subscriptions.list.map((subscription) => ({
        id: String(subscription['id']),
        name: subscription['name'] ?? null,
        renewalDate: subscription['renewalDate'] ?? null,
        currency: String(subscription['currency'] ?? 'USD'),
      })),
      truncated:
        total(invoices) > invoices.list.length ||
        total(credits) > credits.list.length ||
        total(payments) > payments.list.length ||
        total(subscriptions) > subscriptions.list.length,
    };
  }

  /**
   * One document as an accounting consumer posts it (§11.3): the header, the totals and tax breakdown
   * it was issued with, the conversion it was converted at, and the settlement rows standing against
   * it. An issued document answers from its frozen snapshot, so these are the numbers the customer was
   * billed, not a recomputation under today's catalog or settings.
   */
  async accountingExport(rawKind: string, id: string): Promise<Record<string, unknown>> {
    const kind = requireDocumentKind(rawKind);
    const view = await this.documents.view(kind, id);
    const totals = view.totals as unknown as Record<string, unknown>;
    const document = view.document;

    const allocations: Record<string, unknown>[] = [];
    const credits: Record<string, unknown>[] = [];
    const writeOffs: Record<string, unknown>[] = [];
    const settlement = { allocations, credits, writeOffs };
    for (const spec of SETTLEMENT_ROWS) {
      if (await this.acl.canUser(spec.entity, 'read') === 'no') continue;
      const result = await this.entities.list(spec.entity, {
        where: [
          { field: spec.key, operator: 'equals', value: view.id },
          ...(spec.approvedOnly
            ? [{ field: 'status', operator: 'equals', value: 'approved' }]
            : []),
        ],
        maxSize: 200,
        total: false,
      });
      settlement[spec.out].push(
        ...result.list
          // A reversed credit allocation or a reversed write-off settled nothing; §4.9 keeps the row
          // as history, and this contract reports it as history.
          .filter((row) => row['reversedAt'] == null)
          .map((row) => ({
            id: String(row['id']),
            amount: String(row['amount'] ?? '0'),
            currency: String(row['currency'] ?? 'USD'),
            baseAmount: row['baseAmount'] == null ? null : String(row['baseAmount']),
            baseCurrency: row['baseCurrency'] == null ? null : String(row['baseCurrency']),
            at: row['allocatedAt'] ?? row['approvedAt'] ?? row['createdAt'] ?? null,
            by: row['allocatedBy'] ?? row['approvedBy'] ?? null,
          })),
      );
    }

    return {
      contractVersion: SALES_CONTRACT_VERSION,
      document: {
        kind,
        entity: view.descriptor.entity,
        id: view.id,
        number: document['number'] ?? null,
        status: document['status'] ?? null,
        issuedAt: document['issuedAt'] ?? null,
        fromSnapshot: view.fromSnapshot,
        currency: totals['currency'] ?? null,
        baseCurrency: totals['baseCurrency'] ?? null,
        baseGrossTotal: totals['baseGrossTotal'] ?? null,
        exchangeRate: totals['exchangeRate'] ?? null,
        // The frozen snapshot verbatim, so a consumer reads the rate's date and source instead of
        // assuming them. Null means this document was never converted.
        exchangeRateSnapshot: document['exchangeRateSnapshot'] ?? null,
        totals: {
          subtotal: totals['subtotal'] ?? null,
          discountTotal: totals['discountTotal'] ?? null,
          shippingAmount: totals['shippingAmount'] ?? null,
          shippingTaxAmount: totals['shippingTaxAmount'] ?? null,
          taxTotal: totals['taxTotal'] ?? null,
          netTotal: totals['netTotal'] ?? null,
          grossTotal: totals['grossTotal'] ?? null,
          // What the document still owes is *live*, not frozen: the snapshot's own `amountDue` is what
          // it was when the number was allocated, which is no longer the receivable once payments,
          // credits or write-offs have landed. An accounting consumer needs the current figure, so it
          // comes from the record the balance service keeps in step with the settlement rows.
          amountDue: document['amountDue'] ?? totals['amountDue'] ?? null,
          taxInclusive: totals['taxInclusive'] ?? null,
          roundingStage: document['roundingStage'] ?? null,
          roundingMode: document['roundingMode'] ?? null,
          settingsVersion: document['settingsVersion'] ?? null,
        },
        taxBreakdown: totals['taxBreakdown'] ?? [],
        parties: {
          accountId: document['accountId'] ?? null,
          supplierId: document['supplierId'] ?? null,
          contactId: document['contactId'] ?? null,
        },
        // The lines are the *calculated* ones, straight out of the same totals object the document was
        // issued with: `netAmount + taxAmount = grossAmount` at the rounding stage that produced them.
        lines: view.totals.lines.map((line) => ({
          position: line.position,
          productId: line.productId,
          name: line.name,
          sku: line.sku,
          unit: line.unit,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
          netAmount: line.netAmount,
          taxAmount: line.taxAmount,
          grossAmount: line.grossAmount,
          taxCodeId: line.tax?.taxCodeId ?? null,
          taxRatePercent: line.tax?.taxRatePercent ?? null,
          taxSource: line.tax?.source ?? null,
        })),
      },
      settledBy: settlement,
      // Sales does not know what an accounting system did with the document. The fields stay null until
      // a module claims them; §11.3 makes the sync state the consumer's record, not Sales' ledger.
      externalSync: { accountingReference: null, syncedAt: null },
    };
  }
}

function total(result: { list: unknown[]; total?: number }): number {
  return result.total ?? result.list.length;
}

/** Sum one canonical-decimal field per currency, so no two currencies share a bucket (§12.4). */
function groupSum(
  rows: readonly Record<string, unknown>[],
  currencyOf: (row: Record<string, unknown>) => string,
  amountOf: (row: Record<string, unknown>) => string,
): { readonly currency: string; readonly amount: string; readonly count: number }[] {
  const buckets = new Map<string, { sum: ReturnType<typeof zero>; count: number }>();
  for (const row of rows) {
    const currency = currencyOf(row);
    const existing = buckets.get(currency) ?? { sum: zero(0), count: 0 };
    buckets.set(currency, {
      sum: add(existing.sum, parseDecimal(amountOf(row))),
      count: existing.count + 1,
    });
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, entry]) => ({
      currency,
      amount: format(entry.sum, currencyScale(currency)),
      count: entry.count,
    }));
}
