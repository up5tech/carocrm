import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../../acl/acl-api.service.js";
import { OutboxService } from "../../common/outbox.service.js";
import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../../common/request-scope.js";
import { DatabaseService } from "../../database/database.service.js";
import { EntityCrudService } from "../../entity/entity.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import { resolveDay } from "../clock.js";
import { normalizeCurrencyCode } from "../money/currency.js";
import {
  baseAmountOf,
  type ExchangeRateInput,
  readFrozenExchangeRate,
  validateExchangeRateSnapshot,
} from "../money/currency.js";
import { compare, isNegative, parseDecimal, zero } from "../money/decimal.js";
import { runAsSalesInternal } from "../sales-internal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import { SalesSettingsService } from "../sales-settings.service.js";
import {
  assertDirectionAllows,
  PAYMENT_DIRECTIONS,
  PAYMENT_TRANSITIONS,
  type PaymentBalance,
  paymentBalance,
  type PaymentDirection,
} from "./allocation-math.js";
import { SalesBalanceService } from "./balance.service.js";

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
 *  - a payment whose counterparty contradicts its direction — an outgoing payment pays a supplier, an
 *    incoming one collects from a customer, and one that names both is ambiguous money (§4.12);
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
  /** 19-S.18 — the same money at the frozen conversion rate, or null when none was recorded (§4.13). */
  readonly baseCurrency: string | null;
  readonly baseAmount: string | null;
  /** 19-S.18 — the derived balances at that same frozen rate; null when there is no rate. */
  readonly baseAllocatedAmount: string | null;
  readonly baseUnallocatedAmount: string | null;
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
  /** Who an outgoing payment went to (§4.12). A customer payment names an account, never both. */
  readonly supplierId?: string | null | undefined;
  readonly reference?: string | null | undefined;
  readonly memo?: string | null | undefined;
  /**
   * The conversion to freeze on this payment (§4.13). Absent means "this payment has no base-currency
   * figure", which reporting must then say rather than invent.
   */
  readonly exchangeRate?: ExchangeRateInput | undefined;
}

/** Payment request states (§4.8): the provider-neutral half of an online payment. */
export const PAYMENT_REQUEST_STATES: readonly string[] = [
  "pending",
  "paid",
  "failed",
  "expired",
  "cancelled",
];

export const PAYMENT_REQUEST_TRANSITIONS = [
  { action: "markPaid", label: "Mark paid", from: ["pending"], to: "paid" },
  {
    action: "markFailed",
    label: "Mark failed",
    from: ["pending"],
    to: "failed",
  },
  { action: "expire", label: "Expire", from: ["pending"], to: "expired" },
  { action: "cancel", label: "Cancel", from: ["pending"], to: "cancelled" },
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
const FORBIDDEN_PAYLOAD_KEY =
  /(card|cvc|cvv|pan|iban|bic|secret|token|password|private[_-]?key|mandate)/i;

@Injectable()
export class PaymentService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SalesBalanceService) private readonly balances: SalesBalanceService,
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
    await this.acl.assertAccess("Payment", "create");
    if (!PAYMENT_DIRECTIONS.includes(input.direction)) {
      throw new ValidationError(
        `A payment direction must be one of: ${PAYMENT_DIRECTIONS.join(", ")}.`,
        { direction: input.direction },
      );
    }
    const settings = await this.settings.settings();
    const currency = normalizeCurrencyCode(
      input.currency ?? settings.currency.defaultCurrency,
    );
    const balance = paymentBalance(input.amount, []);
    // 19-S.18 — freeze the conversion the caller supplies and derive the base amount from it, exactly
    // the way a document does. `baseAmountOf` refuses a snapshot whose document currency is not this
    // payment's currency, so a rate can never be attached to the wrong money (§4.13).
    const snapshot =
      input.exchangeRate === undefined
        ? null
        : validateExchangeRateSnapshot(input.exchangeRate);
    const base = baseAmountOf(balance.amount, currency, snapshot);
    await this.requireLookup("PaymentMethod", input.paymentMethodId);
    await this.requireLookup("PaymentChannel", input.paymentChannelId);
    // Which side of the ledger a payment belongs to is decided by its counterparty: a customer
    // payment has an account, a supplier payment has a supplier, and a record that claims both is
    // ambiguous money (§4.12 "preserve separate customer and supplier semantics").
    const supplierId = input.supplierId ?? null;
    if (supplierId !== null) {
      if (input.direction !== "outgoing")
        throw new ValidationError(
          "Only an outgoing payment can name a supplier; an incoming one collects from a customer.",
          { direction: input.direction, supplierId },
        );
      if (input.accountId !== undefined && input.accountId !== null)
        throw new ValidationError(
          "A payment names either an account or a supplier, not both.",
          { accountId: input.accountId, supplierId },
        );
      if ((await this.records.byId("Supplier", supplierId)) === undefined)
        throw new NotFoundError(`Supplier "${supplierId}" does not exist.`);
    }

    const created = await runAsSalesInternal(() =>
      this.entities.create("Payment", {
        name: `Payment ${balance.amount} ${currency}`,
        amount: balance.amount,
        currency,
        direction: input.direction,
        paymentDate: resolveDay(input.date),
        paymentMethodId: input.paymentMethodId ?? null,
        paymentChannelId: input.paymentChannelId ?? null,
        accountId: input.accountId ?? null,
        contactId: input.contactId ?? null,
        supplierId,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        status: "draft",
        exchangeRateSnapshot: snapshot === null ? null : JSON.stringify(snapshot),
        baseCurrency: base?.baseCurrency ?? null,
        baseAmount: base?.baseAmount ?? null,
        baseAllocatedAmount:
          baseAmountOf(balance.allocated, currency, snapshot)?.baseAmount ?? null,
        baseUnallocatedAmount:
          baseAmountOf(balance.unallocated, currency, snapshot)?.baseAmount ?? null,
        allocatedAmount: balance.allocated,
        unallocatedAmount: balance.unallocated,
        allocationStatus: balance.status,
      }),
    );
    const id = requireId(created, "Payment");
    return await this.view(id);
  }

  async view(id: string): Promise<PaymentView> {
    await this.acl.assertAccess("Payment", "read");
    const row = await this.requirePayment(id);
    const balance = await this.balanceOf(row);
    return {
      id: row.id,
      status: text(row.data["status"]) ?? "draft",
      direction: directionOf(row),
      amount: text(row.data["amount"]) ?? "0",
      currency: text(row.data["currency"]) ?? "USD",
      baseCurrency: text(row.data["baseCurrency"]) ?? null,
      baseAmount: text(row.data["baseAmount"]) ?? null,
      baseAllocatedAmount: text(row.data["baseAllocatedAmount"]) ?? null,
      baseUnallocatedAmount: text(row.data["baseUnallocatedAmount"]) ?? null,
      balance,
      payment: { ...row.data, id: row.id },
    };
  }

  /** A payment's live balance, recomputed from its allocation rows — never from a stored number. */
  async balanceOf(row: SalesRow): Promise<PaymentBalance> {
    const allocations = await this.records.find(
      "PaymentAllocation",
      { paymentId: row.id },
      500,
    );
    return paymentBalance(
      text(row.data["amount"]) ?? "0",
      allocations.map((allocation) => text(allocation.data["amount"]) ?? "0"),
    );
  }

  /**
   * Update a payment. Amount and currency become immutable once anything has been allocated against
   * them: changing the amount underneath an allocation would silently move money between documents.
   */
  async update(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<PaymentView> {
    await this.acl.assertAccess("Payment", "edit");
    const row = await this.requirePayment(id);
    const status = text(row.data["status"]) ?? "draft";
    if (status === "cancelled") {
      throw new ValidationError("A cancelled payment cannot be changed.", {
        paymentId: id,
      });
    }
    const balance = await this.balanceOf(row);
    if (compare(parseDecimal(balance.allocated), zero(0)) > 0) {
      for (const field of ["amount", "currency", "direction"]) {
        if (patch[field] !== undefined) {
          throw new ValidationError(
            `"${field}" cannot change while the payment has allocations; unallocate first.`,
            { paymentId: id, field, allocated: balance.allocated },
          );
        }
      }
    }
    if (patch["amount"] !== undefined) {
      const next = paymentBalance(String(patch["amount"]), []);
      patch["amount"] = next.amount;
      patch["unallocatedAmount"] = next.unallocated;
    }

    // 19-S.18 — the conversion belongs to the money it describes. A supplied rate replaces the frozen
    // snapshot (and is refused once allocations exist, exactly like the amount), and any change to the
    // amount re-derives `baseAmount` from *that* snapshot rather than from a fresher quote (§4.13:
    // "never recompute old base-currency values using a newer exchange rate").
    const suppliedRate = patch["exchangeRate"];
    delete patch["exchangeRate"];
    if (suppliedRate !== undefined && compare(parseDecimal(balance.allocated), zero(0)) > 0) {
      throw new ValidationError(
        '"exchangeRate" cannot change while the payment has allocations; unallocate first.',
        { paymentId: id, allocated: balance.allocated },
      );
    }
    const snapshot =
      suppliedRate === undefined
        ? readFrozenExchangeRate(row.data["exchangeRateSnapshot"])
        : validateExchangeRateSnapshot(suppliedRate as ExchangeRateInput);
    const amountForBase =
      typeof patch["amount"] === "string"
        ? patch["amount"]
        : (text(row.data["amount"]) ?? "0");
    const currencyForBase = normalizeCurrencyCode(
      typeof patch["currency"] === "string"
        ? patch["currency"]
        : (text(row.data["currency"]) ?? "USD"),
    );
    const base = baseAmountOf(amountForBase, currencyForBase, snapshot);
    patch["exchangeRateSnapshot"] =
      snapshot === null ? null : JSON.stringify(snapshot);
    patch["baseCurrency"] = base?.baseCurrency ?? null;
    patch["baseAmount"] = base?.baseAmount ?? null;
    if (patch["amount"] !== undefined) {
      // An amount may only change while nothing is allocated against it (refused above), so the base
      // balances move with it one-for-one.
      patch["baseAllocatedAmount"] =
        base === null
          ? null
          : baseAmountOf("0", currencyForBase, snapshot)?.baseAmount ?? null;
      patch["baseUnallocatedAmount"] = base?.baseAmount ?? null;
    }

    await runAsSalesInternal(() => this.entities.update("Payment", id, patch));
    return await this.view(id);
  }

  /** `confirm` makes a payment allocatable; `cancel` is refused once it has allocations. */
  async transition(
    id: string,
    action: string,
    reason?: string,
  ): Promise<PaymentView> {
    await this.acl.assertAccess("Payment", "edit");
    const row = await this.requirePayment(id);
    const current = text(row.data["status"]) ?? "draft";
    const transition = PAYMENT_TRANSITIONS.find(
      (candidate) => candidate.action === action,
    );
    if (transition === undefined) {
      throw new ValidationError(`A payment has no "${action}" action.`, {
        paymentId: id,
        action,
      });
    }
    if (!(transition.from as readonly string[]).includes(current)) {
      throw new ValidationError(
        `"${transition.label}" is not allowed from the "${current}" state of a payment; allowed from: ${transition.from.join(", ")}.`,
        { paymentId: id, action, state: current },
      );
    }
    if (action === "cancel") {
      if (reason === undefined || reason.trim() === "") {
        throw new ValidationError("Cancelling a payment requires a reason.", {
          paymentId: id,
        });
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
        await this.entities.update("Payment", id, { status: transition.to });
        await this.emit(`payment.${action}`, {
          paymentId: id,
          status: transition.to,
          reason: reason ?? null,
        });
      });
    });
    return await this.view(id);
  }

  /**
   * The documents a payment may be allocated to, with what each still owes — the allocation editor's
   * data source (§4.8, §4.12).
   *
   * Direction decides the side of the ledger: an incoming payment lists issued **invoices** it can
   * collect, an outgoing one issued **bills** it can pay, filtered by the counterparty named in the
   * query. Documents with nothing outstanding are omitted, so a "nothing to allocate" list means what
   * it says.
   */
  async allocatableDocuments(
    direction: PaymentDirection,
    filters: { readonly accountId?: string | null; readonly supplierId?: string | null } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    const entity = direction === "incoming" ? "Invoice" : "Bill";
    assertDirectionAllows(direction, entity);
    await this.acl.assertAccess(entity, "read");
    const counterpartyField = direction === "incoming" ? "accountId" : "supplierId";
    const counterpartyId =
      direction === "incoming" ? filters.accountId : filters.supplierId;
    const query: Record<string, string> = { status: "issued" };
    if (counterpartyId !== undefined && counterpartyId !== null && counterpartyId !== "")
      query[counterpartyField] = counterpartyId;
    const documents = await this.records.find(entity, query, 500);
    const result: Record<string, unknown>[] = [];
    for (const document of documents) {
      const outstanding = await this.balances.outstandingOf(
        this.database.db,
        document,
      );
      const amount = parseDecimal(outstanding);
      if (compare(amount, zero(amount.scale)) <= 0) continue;
      result.push({
        id: document.id,
        entity,
        number: text(document.data["number"]) ?? null,
        accountId: text(document.data["accountId"]) ?? null,
        supplierId: text(document.data["supplierId"]) ?? null,
        currency: text(document.data["currency"]) ?? null,
        grossTotal: text(document.data["grossTotal"]) ?? "0",
        dueDate: text(document.data["dueDate"]) ?? null,
        outstanding,
        direction,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Payment requests (provider-neutral) and provider events
  // ---------------------------------------------------------------------------------------------

  /** Create a request for a customer to pay. No gateway call happens here, ever. */
  async createRequest(
    input: CreatePaymentRequestInput,
  ): Promise<Record<string, unknown>> {
    await this.acl.assertAccess("PaymentRequest", "create");
    const settings = await this.settings.settings();
    const currency = normalizeCurrencyCode(
      input.currency ?? settings.currency.defaultCurrency,
    );
    const amount = parseDecimal(input.amount);
    if (isNegative(amount) || compare(amount, zero(0)) === 0) {
      throw new ValidationError(
        "A payment request needs an amount greater than zero.",
        { amount: input.amount },
      );
    }
    const created = await runAsSalesInternal(() =>
      this.entities.create("PaymentRequest", {
        name: `Payment request ${input.amount} ${currency}`,
        amount: input.amount,
        currency,
        accountId: input.accountId,
        invoiceId: input.invoiceId ?? null,
        salesOrderId: input.salesOrderId ?? null,
        expiresAt: input.expiresAt ?? null,
        providerReference: input.providerReference ?? null,
        status: "pending",
      }),
    );
    return created;
  }

  async transitionRequest(
    id: string,
    action: string,
  ): Promise<Record<string, unknown>> {
    await this.acl.assertAccess("PaymentRequest", "edit");
    const row = await this.requireRow("PaymentRequest", id);
    const current = text(row.data["status"]) ?? "pending";
    const transition = PAYMENT_REQUEST_TRANSITIONS.find(
      (candidate) => candidate.action === action,
    );
    if (transition === undefined) {
      throw new ValidationError(
        `A payment request has no "${action}" action.`,
        { paymentRequestId: id, action },
      );
    }
    if (!(transition.from as readonly string[]).includes(current)) {
      throw new ValidationError(
        `"${transition.label}" is not allowed from the "${current}" state of a payment request; allowed from: ${transition.from.join(", ")}.`,
        { paymentRequestId: id, action, state: current },
      );
    }
    const updated = await runAsSalesInternal(() =>
      this.entities.update("PaymentRequest", id, { status: transition.to }),
    );
    await this.emit(`paymentRequest.${action}`, {
      paymentRequestId: id,
      status: transition.to,
    });
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
  async ingestProviderEvent(
    input: ProviderEventInput,
  ): Promise<ProviderEventResult> {
    await this.acl.assertAccess("PaymentRequest", "edit");
    const providerEventId = input.providerEventId.trim();
    if (providerEventId === "")
      throw new ValidationError(
        "A provider event needs the provider's event id.",
      );
    assertNoSensitivePayload(input.payload);

    const existing = await this.records.find(
      "PaymentProviderEventLog",
      { providerEventId },
      1,
    );
    const found = existing[0];
    if (found !== undefined) {
      return {
        id: found.id,
        providerEventId,
        duplicate: true,
        processedStatus: text(found.data["processedStatus"]) ?? "ignored",
        paymentRequestStatus: null,
      };
    }

    const paid = /paid|succeeded|success|completed|captured/i.test(
      input.eventType,
    );
    const failed = /failed|declined|error|cancelled|canceled/i.test(
      input.eventType,
    );

    return await runInTransaction(
      this.database.db,
      async (tx) =>
        await runAsSalesInternal(async () => {
          const created = await this.entities.create(
            "PaymentProviderEventLog",
            {
              name: `${input.provider}:${input.eventType}`,
              provider: input.provider,
              providerEventId,
              eventType: input.eventType,
              paymentRequestId: input.paymentRequestId ?? null,
              payload:
                input.payload === undefined
                  ? null
                  : JSON.stringify(input.payload),
              processedStatus: "received",
              processedAt: new Date(),
            },
          );
          const logId = requireId(created, "PaymentProviderEventLog");

          let requestStatus: string | null = null;
          if (
            input.paymentRequestId !== undefined &&
            input.paymentRequestId !== null
          ) {
            const request = await this.records.byId(
              "PaymentRequest",
              input.paymentRequestId,
            );
            if (request !== undefined) {
              const current = text(request.data["status"]) ?? "pending";
              const next =
                paid && current === "pending"
                  ? "paid"
                  : failed && current === "pending"
                    ? "failed"
                    : null;
              if (next !== null) {
                await this.entities.update(
                  "PaymentRequest",
                  input.paymentRequestId,
                  {
                    status: next,
                    providerReference:
                      text(request.data["providerReference"]) ?? null,
                  },
                );
                requestStatus = next;
              } else {
                requestStatus = current;
              }
            }
          }

          await this.entities.update("PaymentProviderEventLog", logId, {
            processedStatus: requestStatus === null ? "ignored" : "processed",
          });
          await this.outbox.insertMany(tx, [
            {
              eventType: "sales.payment.providerEvent",
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
          return {
            id: logId,
            providerEventId,
            duplicate: false,
            processedStatus: requestStatus === null ? "ignored" : "processed",
            paymentRequestStatus: requestStatus,
          };
        }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private async requirePayment(id: string): Promise<SalesRow> {
    return await this.requireRow("Payment", id);
  }

  private async requireRow(
    entity: "Payment" | "PaymentRequest",
    id: string,
  ): Promise<SalesRow> {
    const row = await this.records.byId(entity, id);
    if (row === undefined)
      throw new NotFoundError(`${entity} "${id}" does not exist.`);
    return row;
  }

  /** A method/channel referenced by a payment must exist — a dangling id is refused, not stored. */
  private async requireLookup(
    entity: "PaymentMethod" | "PaymentChannel",
    id: string | null | undefined,
  ): Promise<void> {
    if (id === undefined || id === null || id.trim() === "") return;
    const row = await this.records.byId(entity, id);
    if (row === undefined)
      throw new NotFoundError(`${entity} "${id}" does not exist.`);
    if (row.data["active"] === false) {
      throw new ValidationError(
        `${entity} "${row.name ?? id}" is inactive and cannot be used on a new payment.`,
        { id },
      );
    }
  }

  private async emit(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
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

function assertNoSensitivePayload(
  payload: Record<string, unknown> | undefined,
): void {
  if (payload === undefined) return;
  const offending = collectKeys(payload).filter((key) =>
    FORBIDDEN_PAYLOAD_KEY.test(key),
  );
  if (offending.length > 0) {
    throw new ValidationError(
      `A provider event must not carry card data, a mandate or a reusable secret; these keys were refused: ${offending.join(", ")}.`,
      { fields: offending },
    );
  }
}

function collectKeys(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  const keys: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    keys.push(key);
    keys.push(...collectKeys(item, depth + 1));
  }
  return keys;
}

function directionOf(row: SalesRow): PaymentDirection {
  return text(row.data["direction"]) === "outgoing" ? "outgoing" : "incoming";
}

function requireId(created: Record<string, unknown>, entity: string): string {
  const id = text(created["id"]);
  if (id === undefined)
    throw new ValidationError(`Creating a ${entity} returned no id.`);
  return id;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
