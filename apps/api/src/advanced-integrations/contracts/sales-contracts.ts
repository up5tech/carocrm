import { Inject, Injectable, Optional } from '@nestjs/common';

import { SalesIntegrationService } from '../../sales/integrations/sales-integration.service.js';
import { PaymentService } from '../../sales/payments/payment.service.js';
import { IntegrationContractRegistry } from '../integration-contracts.js';

/**
 * Phase 19-INT.25 — the `Sales` contracts
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.4, §12.8, §14.2; `19-INT.25`).
 *
 * `Sales` owns the commercial document lifecycle. Three of its behaviours are reachable from a
 * connector, and each is published as a contract rather than re-implemented:
 *
 *  - **a provider payment event** → `PaymentService.ingestProviderEvent`. This is the *only* way
 *    a payment state changes. The service is idempotent on the provider's event id, writes the
 *    audit row and the outbox event in the same transaction, and never moves a payment out of a
 *    terminal state. The connector does not re-implement any of that.
 *  - **the accounting export** of a document → `SalesIntegrationService.accountingExport`. A read
 *    contract: an accounting connector reads what Sales issued, with the frozen snapshot, the tax
 *    breakdown and the settlement rows. It never reads a Sales table.
 *  - **the customer summary** → `SalesIntegrationService.customerSummary`. A read contract, used
 *    by a connector that needs a customer's commercial position.
 *
 * The contracts are **optional**: a deployment without the Sales module publishes none of them,
 * and a provider event that needs one is recorded and left for an operator rather than failing a
 * worker.
 */

/** The input of the provider payment event contract. */
export interface SalesProviderPaymentEventInput {
  /** The provider's own event id. It is the idempotency key. */
  readonly providerEventId: string;
  /** The provider's event type, e.g. `payment_intent.succeeded`. */
  readonly eventType: string;
  /** The CRM payment request the event belongs to, when the connector could resolve it. */
  readonly paymentRequestId?: string | null | undefined;
  /** A **summary** of the event. Card data is refused by the owner. */
  readonly payload?: Record<string, unknown> | undefined;
}

export interface SalesProviderPaymentEventOutput {
  /** The provider event log row. */
  readonly id: string;
  /** True when the event had already been recorded. */
  readonly duplicate: boolean;
  readonly processedStatus: string;
  readonly paymentRequestStatus: string | null;
}

export interface SalesAccountingExportInput {
  readonly documentKind: string;
  readonly documentId: string;
}

export interface SalesAccountingExportOutput {
  readonly contractVersion: number;
  readonly document: Record<string, unknown>;
  readonly totals: Record<string, unknown>;
  readonly lines: readonly Record<string, unknown>[];
  readonly settledBy: Record<string, unknown>;
}

export interface SalesCustomerSummaryInput {
  readonly accountId: string;
}

export interface SalesCustomerSummaryOutput {
  readonly contractVersion: number;
  readonly accountId: string;
  readonly receivables: Record<string, unknown>;
  readonly recentPayments: readonly Record<string, unknown>[];
  readonly activeSubscriptions: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

@Injectable()
export class SalesIntegrationContracts {
  constructor(
    @Inject(IntegrationContractRegistry) private readonly registry: IntegrationContractRegistry,
    @Optional() @Inject(PaymentService) private readonly payments: PaymentService | null,
    @Optional() @Inject(SalesIntegrationService) private readonly sales: SalesIntegrationService | null,
  ) {
    if (this.payments !== null) {
      this.registry.register< SalesProviderPaymentEventInput, SalesProviderPaymentEventOutput>({
        contractKey: 'sales.payment.providerEvent',
        contractVersion: 1,
        owningModule: 'Sales',
        ownership:
          'The payment lifecycle, the issued-document rules and the payment audit trail. A provider may report a payment; it may not decide that money was paid.',
        apply: async (input) => {
          const payments = this.payments;
          if (payments === null) throw new Error('The Sales module is not available.');
          const result = await payments.ingestProviderEvent({
            provider: 'stripe',
            providerEventId: input.providerEventId,
            eventType: input.eventType,
            ...(input.paymentRequestId === undefined ? {} : { paymentRequestId: input.paymentRequestId }),
            ...(input.payload === undefined ? {} : { payload: input.payload }),
          });
          return {
            value: {
              id: result.id,
              duplicate: result.duplicate,
              processedStatus: result.processedStatus,
              paymentRequestStatus: result.paymentRequestStatus,
            },
            // The payment request the owner changed. The integration module records its origin so
            // the change is not pushed back to the provider.
            affectedRecords:
              input.paymentRequestId === undefined || input.paymentRequestId === null
                ? []
                : [{ entityType: 'PaymentRequest', entityId: input.paymentRequestId }],
          };
        },
      });
    }

    if (this.sales !== null) {
      this.registry.register<SalesAccountingExportInput, SalesAccountingExportOutput>({
        contractKey: 'sales.accounting.export',
        contractVersion: 1,
        owningModule: 'Sales',
        ownership:
          'The document as Sales issued it: the frozen snapshot, the totals, the tax breakdown and the settlement rows. A read contract; the consumer never writes to Sales.',
        apply: async (input) => {
          const sales = this.sales;
          if (sales === null) throw new Error('The Sales module is not available.');
          const view = (await sales.accountingExport(input.documentKind, input.documentId)) as unknown as {
            contractVersion: number;
            document: Record<string, unknown>;
            totals: Record<string, unknown>;
            lines: readonly Record<string, unknown>[];
            settledBy: Record<string, unknown>;
          };
          return {
            value: {
              contractVersion: view.contractVersion,
              document: view.document,
              totals: view.totals,
              lines: view.lines,
              settledBy: view.settledBy,
            },
            affectedRecords: [],
          };
        },
      });

      this.registry.register<SalesCustomerSummaryInput, SalesCustomerSummaryOutput>({
        contractKey: 'sales.customer.summary',
        contractVersion: 1,
        owningModule: 'Sales',
        ownership:
          'The commercial position of a customer: open invoices, recent payments and active subscriptions. A read contract.',
        apply: async (input) => {
          const sales = this.sales;
          if (sales === null) throw new Error('The Sales module is not available.');
          const view = (await sales.customerSummary(input.accountId)) as unknown as {
            contractVersion: number;
            accountId: string;
            receivables: Record<string, unknown>;
            recentPayments: readonly Record<string, unknown>[];
            activeSubscriptions: readonly Record<string, unknown>[];
            truncated: boolean;
          };
          return {
            value: {
              contractVersion: view.contractVersion,
              accountId: view.accountId,
              receivables: view.receivables,
              recentPayments: view.recentPayments,
              activeSubscriptions: view.activeSubscriptions,
              truncated: view.truncated,
            },
            affectedRecords: [],
          };
        },
      });
    }
  }

  /** The contracts this module publishes. Used by the diagnostics. */
  static readonly publishedContractKeys: readonly string[] = [
    'sales.payment.providerEvent',
    'sales.accounting.export',
    'sales.customer.summary',
  ];
}
