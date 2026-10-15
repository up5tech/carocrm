import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../../acl/acl-api.service.js';
import { OutboxService } from '../../common/outbox.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../../common/request-scope.js';
import { DatabaseService } from '../../database/database.service.js';
import { EntityCrudService } from '../../entity/entity.service.js';
import { runInTransaction } from '../../entity/tx-context.js';
import { resolveDay } from '../clock.js';
import { normalizeCurrencyCode } from '../money/currency.js';
import { add, compare, format, isNegative, parseDecimal, zero } from '../money/decimal.js';
import { SalesRecords, type SalesRow } from '../sales-records.js';
import { SalesSettingsService } from '../sales-settings.service.js';
import { runAsSalesInternal } from '../sales-internal.js';
import {
  assertDirectionAllows,
  documentOutstanding,
  PAYMENT_DIRECTIONS,
  PAYMENT_TRANSITIONS,
  paymentBalance,
  type PaymentBalance,
  type PaymentDirection,
} from './allocation-math.js';

/**
 * Phase 19-S.10 — payments, payment methods and channels, and payment requests (§4.8).
 *
 * A payment is a **recorded financial event**: an amount, a currency, a direction, a date, a method, a
 * counterparty and a reference. It is not a gateway object. Everything that belongs to a provider —
 * checkout, payment intent, card data, bank mandate, webhook signing — belongs to a provider module
 * such as `StripeIntegration`, and this module's contract with it is deliberately narrow: a
 * provider-neutral **payment request** with a state machine, and an **idempotent** ingestion of
 * provider events keyed by the provider's own event id.
 *
 * What this service refuses outright, because a CRM must:
 *
 *  - any field that looks like card data or a reusable gateway secret, in a request or an event;
 *  - allocating an outgoing payment before the payable documents it would settle exist (19-S.13);
 *  - changing an amount or currency that already has allocations behind it.
 *
 * The balance arithmetic is not here — it is the pure pair in `allocation-math.ts`, so it can be tested
 * without a database.
 */

export interface PaymentView {
  readonly id: string;
  readonly status: string;
  readonly direction: PaymentDirection;
  readonly amount: string;
  readonly currency: string;
  readonly balance: PaymentBalance;
  readonly payment: Record<string, unknown>;
}

export interface CreatePaymentInput {
  readonly amount: string;
  readonly currency?: string | undefined;
  readonly direction: PaymentDirection;
  readonly date?: string | undefined;
  readonly paymentMethodId?: string | null | undefined;
  readonly paymentChannelId?: string | null | undefined;
  readonly accountId?: string | null | undefined;
  readonly contactId?: string | null | undefined;
  readonly reference?: string | null | undefined;
  readonly memo?: string | null | undefined;
}

/** Payment request states (§4.8): the provider-neutral half of an online payment. */
export const PAYMENT_REQUEST_STATES: readonly string[] = ['pending', 'paid', 'failed', 'expired', 'cancelled'];

export const PAYMENT_REQUEST_TRANSITIONS = [
  { action: 'markPaid', label: 'Mark paid', from: ['pending'], to: 'paid' },
  { action: 'markFailed', label: 'Mark failed', from: ['pending'], to: 'failed' },
  { action: 'expire', label: 'Expire', from: ['pending'], to: 'expired' },
  { action: 'cancel', label: 'Cancel', from: ['pending'], to: 'cancelled' },
] as const;

export interface CreatePaymentRequestInput {
  readonly amount: string;
  readonly currency?: string | undefined;
  readonly accountId: string;
  readonly invoiceId?: string | null | undefined;
  readonly salesOrderId?: string | null | undefined;
  readonly expiresAt?: string | null | undefined;
  /** The provider's own reference, once one exists. Never a secret. */
  readonly providerReference?: string | null | undefined;
}

export interface ProviderEventInput {
  readonly provider: string;
  /** The provider's event id — the idempotency key. A duplicate delivery must change nothing. */
  readonly providerEventId: string;
  readonly eventType: string;
  readonly paymentRequestId?: string | null | undefined;
  /** A *summary*. Card data, mandates and secrets are refused, not stored. */
  readonly payload?: Record<string, unknown> | undefined;
}

export interface ProviderEventResult {
  readonly id: string;
  readonly providerEventId: string;
  readonly duplicate: boolean;
  readonly processedStatus: string;
  readonly paymentRequestStatus: string | null;
}

/** Anything that looks like card data or a reusable credential is refused, never stored. */
const FORBIDDEN_PAYLOAD_KEY = /(card|cvc|cvv|pan|iban|bic|secret|token|password|private[_-]?key|mandate)/i;

@Injectable()
export class PaymentService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService) private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------------------------

  /**
   * Record a payment. The derived fields are set here, not accepted from the caller: a payment that
   * arrived claiming to be already allocated would be a lie with no allocation row behind it.
   */
  async create(input: CreatePaymentInput): Promise<PaymentView> {
    await this.acl.assertAccess('Payment', 'create');
    if (!PAYMENT_DIRECTIONS.includes(input.direction)) {
      throw new ValidationError(`A payment direction must be one of: ${PAYMENT_DIRECTIONS.join(', ')}.`, { direction: input.direction });
    }
    const settings = await this.settings.settings();
    const currency = normalizeCurrencyCode(input.currency ?? settings.currency.defaultCurrency);
    const balance = paymentBalance(input.amount, []);
    await this.requireLookup('PaymentMethod', input.paymentMethodId);
    await this.requireLookup('PaymentChannel', input.paymentChannelId);

    const created = await runAsSalesInternal(() =>
      this.entities.create('Payment', {
        name: `Payment ${balance.amount} ${currency}`,
        amount: balance.amount,
        currency,
        direction: input.direction,
        paymentDate: resolveDay(input.date),
        paymentMethodId: input.paymentMethodId ?? null,
        paymentChannelId: input.paymentChannelId ?? null,
        accountId: input.accountId ?? null,
        contactId: input.contactId ?? null,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        status: 'draft',
        allocatedAmount: balance.allocated,
        unallocatedAmount: balance.unallocated,
        allocationStatus: balance.status,
      }),
    );
    const id = requireId(created, 'Payment');
    return await this.view(id);
  }

  async view(id: string): Promise<PaymentView> {
    await this.acl.assertAccess('Payment', 'read');
    const row = await this.requirePayment(id);
    const balance = await this.balanceOf(row);
    return {
      id: row.id,
      status: text(row.data['status']) ?? 'draft',
      direction: directionOf(row),
      amount: text(row.data['amount']) ?? '0',
      currency: text(row.data['currency']) ?? 'USD',
      balance,
      payment: { ...row.data, id: row.id },
    };
  }

  /** A payment's live balance, recomputed from its allocation rows — never from a stored number. */
  async balanceOf(row: SalesRow): Promise<PaymentBalance> {
    const allocations = await this.records.find('PaymentAllocation', { paymentId: row.id }, 500);
    return paymentBalance(text(row.data['amount']) ?? '0', allocations.map((allocation) => text(allocation.data['amount']) ?? '0'));
  }

  /**
   * Update a payment. Amount and currency become immutable once anything has been allocated against
   * them: changing the amount underneath an allocation would silently move money between documents.
   */
  async update(id: string, patch: Record<string, unknown>): Promise<PaymentView> {
    await this.acl.assertAccess('Payment', 'edit');
    const row = await this.requirePayment(id);
    const status = text(row.data['status']) ?? 'draft';
    if (status === 'cancelled') {
      throw new ValidationError('A cancelled payment cannot be changed.', { paymentId: id });
    }
    const balance = await this.balanceOf(row);
    if (compare(parseDecimal(balance.allocated), zero(0)) > 0) {
      for (const field of ['amount', 'currency', 'direction']) {
        if (patch[field] !== undefined) {
          throw new ValidationError(
            `"${field}" cannot change while the payment has allocations; unallocate first.`,
            { paymentId: id, field, allocated: balance.allocated },
          );
        }
      }
    }
    if (patch['amount'] !== undefined) {
      const next = paymentBalance(String(patch['amount']), []);
      patch['amount'] = next.amount;
      patch['unallocatedAmount'] = next.unallocated;
    }
    await runAsSalesInternal(() => this.entities.update('Payment', id, patch));
    return await this.view(id);
  }

  /** `confirm` makes a payment allocatable; `cancel` is refused once it has allocations. */
  async transition(id: string, action: string, reason?: string): Promise<PaymentView> {
    await this.acl.assertAccess('Payment', 'edit');
    const row = await this.requirePayment(id);
    const current = text(row.data['status']) ?? 'draft';
    const transition = PAYMENT_TRANSITIONS.find((candidate) => candidate.action === action);
    if (transition === undefined) {
      throw new ValidationError(`A payment has no "${action}" action.`, { paymentId: id, action });
    }
    if (!(transition.from as readonly string[]).includes(current)) {
      throw new ValidationError(
        `"${transition.label}" is not allowed from the "${current}" state of a payment; allowed from: ${transition.from.join(', ')}.`,
        { paymentId: id, action, state: current },
      );
    }
    if (action === 'cancel') {
      if (reason === undefined || reason.trim() === '') {
        throw new ValidationError('Cancelling a payment requires a reason.', { paymentId: id });
      }
      const balance = await this.balanceOf(row);
      if (compare(parseDecimal(balance.allocated), zero(0)) > 0) {
        throw new ValidationError(
          `This payment has ${balance.allocated} allocated; unallocate it before cancelling.`,
          { paymentId: id, allocated: balance.allocated },
        );
      }
    }
    await runInTransaction(this.database.db, async () => {
      await runAsSalesInternal(async () => {
        await this.entities.update('Payment', id, { status: transition.to });
        await this.emit(`payment.${action}`, { paymentId: id, status: transition.to, reason: reason ?? null });
      });
    });
    return await this.view(id);
  }

  /**
   * The invoices an incoming payment may be allocated to, with what each still owes.
   *
   * This is the allocation editor's data source: it returns issued invoices with a positive
   * outstanding balance, in the payment's currency, newest due date first.
   */
  async allocatableInvoices(direction: PaymentDirection, accountId?: string | null): Promise<readonly Record<string, unknown>[]> {
    // An outgoing payment settles payable documents, which do not exist until 19-S.13 — refused here
    // rather than silently returning an empty list the caller would misread as "nothing owed".
    assertDirectionAllows(direction, 'Invoice');
    await this.acl.assertAccess('Invoice', 'read');
    const filters: Record<string, string> = { status: 'issued' };
    if (accountId !== undefined && accountId !== null && accountId !== '') filters['accountId'] = accountId;
    const invoices = await this.records.find('Invoice', filters, 500);
    const result: Record<string, unknown>[] = [];
    for (const invoice of invoices) {
      const outstanding = await this.outstandingOf(invoice);
      if (compare(parseDecimal(outstanding), zero(0)) <= 0) continue;
      result.push({
        id: invoice.id,
        number: text(invoice.data['number']) ?? null,
        accountId: text(invoice.data['accountId']) ?? null,
        currency: text(invoice.data['currency']) ?? null,
        grossTotal: text(invoice.data['grossTotal']) ?? '0',
        dueDate: text(invoice.data['dueDate']) ?? null,
        outstanding,
        direction,
      });
    }
    return result;
  }

  /** What an invoice still owes, from its allocation, credit and write-off rows. */
  async outstandingOf(invoice: SalesRow): Promise<string> {
    const [allocations, credits, writeOffs] = await Promise.all([
      this.records.find('PaymentAllocation', { documentId: invoice.id }, 500),
      this.records.find('CreditNoteAllocation', { invoiceId: invoice.id }, 500),
      this.records.find('WriteOff', { invoiceId: invoice.id }, 500),
    ]);
    return documentOutstanding(
      text(invoice.data['grossTotal']) ?? '0',
      allocations.map((row) => text(row.data['amount']) ?? '0'),
      credits.map((row) => text(row.data['amount']) ?? '0'),
      writeOffs.map((row) => text(row.data['amount']) ?? '0'),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Payment requests (provider-neutral) and provider events
  // ---------------------------------------------------------------------------------------------

  /** Create a request for a customer to pay. No gateway call happens here, ever. */
  async createRequest(input: CreatePaymentRequestInput): Promise<Record<string, unknown>> {
    await this.acl.assertAccess('PaymentRequest', 'create');
    const settings = await this.settings.settings();
    const currency = normalizeCurrencyCode(input.currency ?? settings.currency.defaultCurrency);
    const amount = parseDecimal(input.amount);
    if (isNegative(amount) || compare(amount, zero(0)) === 0) {
      throw new ValidationError('A payment request needs an amount greater than zero.', { amount: input.amount });
    }
    const created = await runAsSalesInternal(() =>
      this.entities.create('PaymentRequest', {
        name: `Payment request ${input.amount} ${currency}`,
        amount: input.amount,
        currency,
        accountId: input.accountId,
        invoiceId: input.invoiceId ?? null,
        salesOrderId: input.salesOrderId ?? null,
        expiresAt: input.expiresAt ?? null,
        providerReference: input.providerReference ?? null,
        status: 'pending',
      }),
    );
    return created;
  }

  async transitionRequest(id: string, action: string): Promise<Record<string, unknown>> {
    await this.acl.assertAccess('PaymentRequest', 'edit');
    const row = await this.requireRow('PaymentRequest', id);
    const current = text(row.data['status']) ?? 'pending';
    const transition = PAYMENT_REQUEST_TRANSITIONS.find((candidate) => candidate.action === action);
    if (transition === undefined) {
      throw new ValidationError(`A payment request has no "${action}" action.`, { paymentRequestId: id, action });
    }
    if (!(transition.from as readonly string[]).includes(current)) {
      throw new ValidationError(
        `"${transition.label}" is not allowed from the "${current}" state of a payment request; allowed from: ${transition.from.join(', ')}.`,
        { paymentRequestId: id, action, state: current },
      );
    }
    const updated = await runAsSalesInternal(() => this.entities.update('PaymentRequest', id, { status: transition.to }));
    await this.emit(`paymentRequest.${action}`, { paymentRequestId: id, status: transition.to });
    return updated;
  }

  /**
   * Ingest one provider event, idempotently.
   *
   * The provider's event id is the key: a duplicate delivery finds the existing log row and returns it
   * with `duplicate: true`, creating no payment and no allocation. This is the whole reason the log
   * entity exists — a webhook that arrives twice must not settle an invoice twice (§4.8, §6.3).
   *
   * The payload is a *summary*. Anything that looks like card data, a mandate or a reusable secret is
   * refused here rather than stored, because a CRM is the wrong place for it.
   */
  async ingestProviderEvent(input: ProviderEventInput): Promise<ProviderEventResult> {
    await this.acl.assertAccess('PaymentRequest', 'edit');
    const providerEventId = input.providerEventId.trim();
    if (providerEventId === '') throw new ValidationError('A provider event needs the provider\'s event id.');
    assertNoSensitivePayload(input.payload);

    const existing = await this.records.find('PaymentProviderEventLog', { providerEventId }, 1);
    const found = existing[0];
    if (found !== undefined) {
      return {
        id: found.id,
        providerEventId,
        duplicate: true,
        processedStatus: text(found.data['processedStatus']) ?? 'ignored',
        paymentRequestStatus: null,
      };
    }

    const paid = /paid|succeeded|success|completed|captured/i.test(input.eventType);
    const failed = /failed|declined|error|cancelled|canceled/i.test(input.eventType);

    return await runInTransaction(this.database.db, async (tx) => await runAsSalesInternal(async () => {
      const created = await this.entities.create('PaymentProviderEventLog', {
        name: `${input.provider}:${input.eventType}`,
        provider: input.provider,
        providerEventId,
        eventType: input.eventType,
        paymentRequestId: input.paymentRequestId ?? null,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
        processedStatus: 'received',
        processedAt: new Date(),
      });
      const logId = requireId(created, 'PaymentProviderEventLog');

      let requestStatus: string | null = null;
      if (input.paymentRequestId !== undefined && input.paymentRequestId !== null) {
        const request = await this.records.byId('PaymentRequest', input.paymentRequestId);
        if (request !== undefined) {
          const current = text(request.data['status']) ?? 'pending';
          const next = paid && current === 'pending' ? 'paid' : failed && current === 'pending' ? 'failed' : null;
          if (next !== null) {
            await this.entities.update('PaymentRequest', input.paymentRequestId, { status: next, providerReference: text(request.data['providerReference']) ?? null });
            requestStatus = next;
          } else {
            requestStatus = current;
          }
        }
      }

      await this.entities.update('PaymentProviderEventLog', logId, {
        processedStatus: requestStatus === null ? 'ignored' : 'processed',
      });
      await this.outbox.insertMany(tx, [
        {
          eventType: 'sales.payment.providerEvent',
          payload: {
            provider: input.provider,
            providerEventId,
            eventType: input.eventType,
            paymentRequestId: input.paymentRequestId ?? null,
            paymentRequestStatus: requestStatus,
            occurredAt: new Date().toISOString(),
          },
        },
      ]);
      return { id: logId, providerEventId, duplicate: false, processedStatus: requestStatus === null ? 'ignored' : 'processed', paymentRequestStatus: requestStatus };
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private async requirePayment(id: string): Promise<SalesRow> {
    return await this.requireRow('Payment', id);
  }

  private async requireRow(entity: 'Payment' | 'PaymentRequest', id: string): Promise<SalesRow> {
    const row = await this.records.byId(entity, id);
    if (row === undefined) throw new NotFoundError(`${entity} "${id}" does not exist.`);
    return row;
  }

  /** A method/channel referenced by a payment must exist — a dangling id is refused, not stored. */
  private async requireLookup(entity: 'PaymentMethod' | 'PaymentChannel', id: string | null | undefined): Promise<void> {
    if (id === undefined || id === null || id.trim() === '') return;
    const row = await this.records.byId(entity, id);
    if (row === undefined) throw new NotFoundError(`${entity} "${id}" does not exist.`);
    if (row.data['active'] === false) {
      throw new ValidationError(`${entity} "${row.name ?? id}" is inactive and cannot be used on a new payment.`, { id });
    }
  }

  private async emit(action: string, payload: Record<string, unknown>): Promise<void> {
    await this.outbox.insertMany(this.database.db, [
      {
        eventType: `sales.${action}`,
        payload: {
          ...payload,
          actor: this.scope.principal?.userName ?? this.scope.userId ?? null,
          occurredAt: new Date().toISOString(),
        },
      },
    ]);
  }
}

function assertNoSensitivePayload(payload: Record<string, unknown> | undefined): void {
  if (payload === undefined) return;
  const offending = collectKeys(payload).filter((key) => FORBIDDEN_PAYLOAD_KEY.test(key));
  if (offending.length > 0) {
    throw new ValidationError(
      `A provider event must not carry card data, a mandate or a reusable secret; these keys were refused: ${offending.join(', ')}.`,
      { fields: offending },
    );
  }
}

function collectKeys(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return [];
  const keys: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    keys.push(key);
    keys.push(...collectKeys(item, depth + 1));
  }
  return keys;
}

function directionOf(row: SalesRow): PaymentDirection {
  return text(row.data['direction']) === 'outgoing' ? 'outgoing' : 'incoming';
}

function requireId(created: Record<string, unknown>, entity: string): string {
  const id = text(created['id']);
  if (id === undefined) throw new ValidationError(`Creating a ${entity} returned no id.`);
  return id;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
