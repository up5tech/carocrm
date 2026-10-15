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
import { currentTx, runInTransaction } from "../../entity/tx-context.js";
import { resolveDay } from "../clock.js";
import type { ExchangeRateInput } from "../money/currency.js";
import { normalizeCurrencyCode } from "../money/currency.js";
import {
  runAsSalesInternal,
  SERVER_OWNED_DOCUMENT_FIELDS,
} from "../sales-internal.js";
import { SalesRecords, type SalesRow } from "../sales-records.js";
import {
  type SalesSettings,
  SalesSettingsService,
} from "../sales-settings.service.js";
import { SalesTaxService } from "../tax/tax.service.js";
import type { TotalsResult } from "../tax/totals.js";
import {
  conversionRefusal,
  type DocumentConversion,
  documentDescriptor,
  type DocumentTransition,
  findConversion,
  findTransition,
  type ImplementedDocumentKind,
  type SalesDocumentDescriptor,
} from "./descriptors.js";
import {
  type FulfilmentState,
  type FulfilmentSummary,
  fulfilmentSummary,
  fulfilmentTransitionRefusal,
} from "./fulfilment.js";
import {
  assertWithinRemaining,
  type ItemRecordPayload,
  itemRecordPayloadFromStored,
  itemsToLineInputs,
  itemsToLineInputsWithSource,
  MAX_LINE_ITEMS,
  type RequestedLine,
  type StoredItem,
  validateRequestedLines,
} from "./line-items.js";
import {
  applyUnlock,
  assertDocumentEditable,
  assertUnlockAllowed,
  type DocumentLockPolicy,
  type DocumentLockState,
  isIssued,
  isLocked,
} from "./lock.js";
import { SalesNumberingService } from "./numbering.service.js";
import {
  buildDocumentSnapshot,
  type DocumentSnapshot,
  parseDocumentSnapshot,
  readDocumentSnapshot,
} from "./snapshot.js";
import { dueDateFor, isOverdue, type PaymentTerms } from "./terms.js";
import type { SalesAuditContext } from "./types.js";

/**
 * Phase 19-S.6 – 19-S.12 — the engine every commercial document runs on.
 *
 * One implementation of the mechanics the plan describes once (§4.4): create a document with typed
 * line items, recalculate its totals **on the server for every save**, apply a named state
 * transition, and — for the transition marked `issues` — validate and recalculate with prices
 * required, capture the immutable snapshot, allocate the official number, record issuer and time,
 * apply the lock policy and write the domain event, all in one transaction (§4.7).
 *
 * Deliberately **not** here: the per-document state machines (they are data in `descriptors.ts`),
 * payment allocation, credit allocation, stock movement, PDF/email and expiry jobs. Those live in the
 * services that own them, and none of them gets a back door into this one.
 *
 * Two rules this file exists to enforce:
 *
 *  - **An issued document is read from its snapshot, not recalculated.** After issuance the totals and
 *    the item money facts come from the frozen envelope, so a later tax-rule, price or currency change
 *    cannot silently rewrite a document that was already sent (§4.7, §4.9 acceptance criteria).
 *  - **Every write goes through `EntityCrudService`**, so record ACL, field permissions, validation,
 *    audit, stream and the domain-event hooks still run — the engine is not a bypass (§5.2).
 */

export interface DocumentPartySnapshot {
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly billingAddress: string | null;
  readonly shippingAddress: string | null;
}

/** What an issued document captures so it stays renderable after the catalog moves on (§5.8). */
export interface CommercialSnapshot {
  readonly kind: ImplementedDocumentKind;
  readonly number: string;
  readonly status: string;
  readonly currency: string;
  readonly exchangeRate: string | null;
  readonly baseCurrency: string | null;
  readonly parties: DocumentPartySnapshot;
  readonly items: readonly ItemRecordPayload[];
  readonly totals: TotalsResult;
  /** The calculation policy the numbers were produced under, so a later change is visible. */
  readonly policy: {
    readonly settingsVersion: number;
    readonly roundingStage: string;
    readonly roundingMode: string;
    readonly taxInclusive: boolean;
    readonly quantityPrecision: number;
    readonly missingTaxPolicy: string;
  };
}

export interface DocumentView {
  readonly kind: ImplementedDocumentKind;
  readonly id: string;
  readonly descriptor: {
    readonly label: string;
    readonly entity: string;
    readonly seriesCode: string;
    readonly states: readonly string[];
  };
  readonly document: Record<string, unknown>;
  readonly items: readonly StoredItem[];
  readonly totals: TotalsResult;
  readonly lock: DocumentLockState & { readonly locked: boolean };
  /** True when `totals`/`items` came from the frozen snapshot rather than a live calculation. */
  readonly fromSnapshot: boolean;
  /** Actions the current state allows right now — what a UI renders as buttons. */
  readonly availableTransitions: readonly string[];
  readonly availableConversions: readonly string[];
}

export interface CreateDocumentInput {
  readonly kind: ImplementedDocumentKind;
  /** Header fields the caller supplies (account, dates, currency, addresses, …). */
  readonly data?: Record<string, unknown> | undefined;
  readonly items: readonly RequestedLine[];
  readonly audit?: SalesAuditContext | undefined;
}

export interface UpdateDocumentInput {
  readonly data?: Record<string, unknown> | undefined;
  /** When present, the document's lines are replaced wholesale — the caller's order included. */
  readonly items?: readonly RequestedLine[] | undefined;
  readonly audit?: SalesAuditContext | undefined;
}

/**
 * Fields the server owns live in `sales-internal.ts`, because the write guard
 * (`sales-write-guard.service.ts`) enforces the same list on the generic `/api/v1/:entity` path. This
 * engine refuses them a second time, before the record API is even reached.
 */
const SERVER_OWNED_FIELDS = SERVER_OWNED_DOCUMENT_FIELDS;

@Injectable()
export class SalesDocumentService {
  constructor(
    @Inject(SalesRecords) private readonly records: SalesRecords,
    @Inject(SalesSettingsService)
    private readonly settings: SalesSettingsService,
    @Inject(SalesTaxService) private readonly tax: SalesTaxService,
    @Inject(SalesNumberingService)
    private readonly numbering: SalesNumberingService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  /** A document with its items, its totals and the actions its current state allows. */
  async view(kind: ImplementedDocumentKind, id: string): Promise<DocumentView> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "read");
    const row = await this.requireDocument(descriptor, id);
    const items = await this.itemsOf(descriptor, row.id);
    const snapshot = this.issuedSnapshot(descriptor, row);
    if (snapshot !== undefined) {
      const data = readDocumentSnapshot(snapshot);
      return this.toView(descriptor, row, items, data.totals, true);
    }
    const totals = await this.totalsFor(descriptor, row, items, false);
    return this.toView(descriptor, row, items, totals, false);
  }

  /**
   * The items of many documents at once, keyed by document id — one query for a list page, so a list
   * of invoices never becomes one query per row (§16.1).
   */
  async itemsFor(
    descriptor: SalesDocumentDescriptor,
    documentIds: readonly string[],
  ): Promise<Map<string, StoredItem[]>> {
    const grouped = new Map<string, StoredItem[]>();
    if (documentIds.length === 0) return grouped;
    const rows = await this.records.findByIdsIn(
      descriptor.itemEntity,
      descriptor.itemParentField,
      documentIds,
      MAX_LINE_ITEMS * documentIds.length,
    );
    for (const row of rows) {
      const parent = text(row.data[descriptor.itemParentField]);
      if (parent === undefined) continue;
      const list = grouped.get(parent) ?? [];
      list.push(toStoredItem(row));
      grouped.set(parent, list);
    }
    for (const [key, list] of grouped) grouped.set(key, orderByPosition(list));
    return grouped;
  }

  /** The lock policy of a kind, for callers that must explain it without loading a document. */
  lockPolicy(kind: ImplementedDocumentKind): DocumentLockPolicy {
    return documentDescriptor(kind).lockPolicy;
  }

  /**
   * The verified snapshot of an **issued** document, or `undefined` for a draft (19-S.7).
   *
   * The render/email path needs the frozen parties, lines and totals, because a document emailed a
   * month ago must show the customer and the prices it was sent with — not today's account name and
   * not today's price book. That is exactly what the envelope holds, and it is returned only after its
   * digest has been re-verified, so a tampered row cannot be rendered from. A draft has no snapshot,
   * which is also how the caller knows the document has not been issued yet.
   */
  async issuedData(
    kind: ImplementedDocumentKind,
    id: string,
  ): Promise<CommercialSnapshot | undefined> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "read");
    const row = await this.requireDocument(descriptor, id);
    const snapshot = this.issuedSnapshot(descriptor, row);
    return snapshot === undefined ? undefined : readDocumentSnapshot(snapshot);
  }

  // ---------------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------------

  /** Create a draft. Totals are computed here, never taken from the caller (§5.7). */
  async create(input: CreateDocumentInput): Promise<DocumentView> {
    const descriptor = documentDescriptor(input.kind);
    await this.acl.assertAccess(descriptor.entity, "create");
    const settings = await this.settings.read();
    rejectServerOwned(input.data);
    const lines = validateRequestedLines(input.items, {
      quantityPrecision: settings.settings.quantityPrecision,
      minItems: 0,
      maxItems: descriptor.maxItems,
      requireUnitPrice: false,
    });

    const created = await this.entities.create(descriptor.entity, {
      ...(await this.withDueDate(descriptor, { ...(input.data ?? {}) })),
      status: descriptor.initialState,
    });
    const documentId = requireId(created, descriptor);
    try {
      const row = await this.requireDocument(descriptor, documentId);
      await this.replaceItems(
        descriptor,
        documentId,
        row,
        lines,
        settings.settings,
      );
      const stored = await this.itemsOf(descriptor, documentId);
      const fresh = await this.requireDocument(descriptor, documentId);
      const totals = await this.totalsFor(descriptor, fresh, stored, false);
      await this.entities.update(
        descriptor.entity,
        documentId,
        totalsPatch(totals, stored.length, settings),
      );
      return await this.view(input.kind, documentId);
    } catch (error: unknown) {
      // A document whose lines failed validation must not survive as an empty draft.
      await this.entities
        .remove(descriptor.entity, documentId)
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Update a document. A locked (issued) document refuses changes to its protected fields, and the
   * refusal **names** them (§4.7) — it never silently drops a field.
   */
  async update(
    kind: ImplementedDocumentKind,
    id: string,
    input: UpdateDocumentInput,
  ): Promise<DocumentView> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "edit");
    const settings = await this.settings.read();
    const row = await this.requireDocument(descriptor, id);
    const state = lockStateOf(descriptor, row);
    const patch = { ...(input.data ?? {}) };
    rejectServerOwned(patch);
    const changingItems = input.items !== undefined;
    assertDocumentEditable(
      state,
      changingItems ? [...Object.keys(patch), "items"] : Object.keys(patch),
      descriptor.lockPolicy,
    );

    // Header first, then lines: a line's currency, date and shipping context come from the header.
    if (Object.keys(patch).length > 0) {
      // Changing the terms or the document date re-derives the due date; an explicit one always wins.
      const changedTerms =
        patch["paymentTermId"] !== undefined ||
        patch[descriptor.dateField] !== undefined;
      const withTerms = await this.withDueDate(
        descriptor,
        { ...row.data, ...patch },
        changedTerms,
      );
      if (patch["dueDate"] === undefined && withTerms["dueDate"] !== undefined)
        patch["dueDate"] = withTerms["dueDate"];
      await this.entities.update(descriptor.entity, id, patch);
    }
    const header = await this.requireDocument(descriptor, id);
    if (changingItems) {
      const lines = validateRequestedLines(input.items ?? [], {
        quantityPrecision: settings.settings.quantityPrecision,
        minItems: 0,
        maxItems: descriptor.maxItems,
        requireUnitPrice: false,
      });
      await this.replaceItems(descriptor, id, header, lines, settings.settings);
    }
    const stored = await this.itemsOf(descriptor, id);
    const totals = await this.totalsFor(descriptor, header, stored, false);
    await this.entities.update(
      descriptor.entity,
      id,
      totalsPatch(totals, stored.length, settings),
    );
    return await this.view(kind, id);
  }

  /**
   * Expire the quotes whose validity window has passed (19-S.7).
   *
   * Idempotent **by construction**, not by a flag: only a quote in `sent` is a candidate, and moving
   * it to `expired` takes it out of that state — so running this twice, or two workers running it at
   * once, changes nothing the second time. `today` defaults to the current UTC day and is injectable,
   * so the behaviour is testable without a clock.
   *
   * This is the operation a scheduled job runs; registering the cron entry is the remaining wiring.
   */
  async expireOverdueQuotes(
    today?: string,
  ): Promise<{ expired: readonly string[]; skipped: number }> {
    const descriptor = documentDescriptor("quote");
    await this.acl.assertAccess(descriptor.entity, "edit");
    const day = resolveDay(today);
    const candidates = await this.records.find(
      descriptor.entity,
      { status: "sent" },
      MAX_LINE_ITEMS,
    );
    const expired: string[] = [];
    for (const quote of candidates) {
      const validUntil = text(quote.data["validUntil"]);
      if (validUntil === undefined || validUntil >= day) continue;
      await this.transition("quote", quote.id, "expire", {
        reason: `Validity ended ${validUntil}.`,
      });
      expired.push(quote.id);
    }
    return { expired, skipped: candidates.length - expired.length };
  }

  /**
   * Recompute a sales order's fulfilment state from its **confirmed** delivery orders (19-S.8).
   *
   * Derived, not typed: the state is a function of what the order asked for and what its confirmed
   * deliveries actually moved, so "partially fulfilled" cannot be set by hand and cannot be wrong.
   * Idempotent — a second run computes the same state, writes nothing and emits nothing.
   */
  async refreshFulfilment(
    orderId: string,
  ): Promise<{
    state: FulfilmentState;
    changed: boolean;
    summary: FulfilmentSummary;
  }> {
    const descriptor = documentDescriptor("salesOrder");
    await this.acl.assertAccess(descriptor.entity, "edit");
    const order = await this.requireDocument(descriptor, orderId);
    const current = statusOf(order, descriptor);
    if (current === "draft" || current === "cancelled") {
      throw new ValidationError(`A ${current} order has no fulfilment state.`, {
        salesOrderId: orderId,
        status: current,
      });
    }

    const orderItems = await this.itemsOf(descriptor, orderId);
    const moved = await this.confirmedDeliveryQuantities(orderId);
    const summary = fulfilmentSummary(
      orderItems.map((item) => ({
        orderedQuantity: item.quantity,
        movedQuantities: moved.get(item.id) ?? [],
      })),
    );
    const refusal = fulfilmentTransitionRefusal(current, summary.state);
    if (refusal !== null)
      throw new ValidationError(refusal, {
        salesOrderId: orderId,
        state: current,
        next: summary.state,
      });
    if (current === summary.state)
      return { state: summary.state, changed: false, summary };

    await runAsSalesInternal(() =>
      runInTransaction(this.database.db, async () => {
        await this.entities.update(descriptor.entity, orderId, {
          status: summary.state,
        });
        await this.emit(descriptor, orderId, summary.state, {
          status: summary.state,
          fullyMovedLines: summary.fullyMovedLines,
          totalLines: summary.totalLines,
        });
      }),
    );
    return { state: summary.state, changed: true, summary };
  }

  /**
   * Mark issued invoices past their due date as overdue, emitting one event each (19-S.9).
   *
   * Idempotent: an invoice already marked `overdue` is not a candidate, so a second run emits nothing.
   * Payment status is a *payment* concept, so the invoice's own `status` is untouched — an overdue
   * invoice is still an issued invoice (§4.7).
   */
  async markOverdueInvoices(
    today?: string,
  ): Promise<{ overdue: readonly string[]; checked: number }> {
    const descriptor = documentDescriptor("invoice");
    await this.acl.assertAccess(descriptor.entity, "edit");
    const day = resolveDay(today);
    const candidates = await this.records.find(
      descriptor.entity,
      { status: "issued" },
      MAX_LINE_ITEMS,
    );
    const overdue: string[] = [];
    for (const invoice of candidates) {
      const paymentStatus = text(invoice.data["paymentStatus"]) ?? "unpaid";
      if (paymentStatus === "overdue" || paymentStatus === "paid") continue;
      const dueDate = text(invoice.data["dueDate"]);
      if (!isOverdue(dueDate, day)) continue;
      await runAsSalesInternal(() =>
        runInTransaction(this.database.db, async () => {
          await this.entities.update(descriptor.entity, invoice.id, {
            paymentStatus: "overdue",
          });
          await this.emit(descriptor, invoice.id, "overdue", {
            dueDate,
            number: text(invoice.data["number"]) ?? null,
            amountDue: text(invoice.data["amountDue"]) ?? "0",
          });
        }),
      );
      overdue.push(invoice.id);
    }
    return { overdue, checked: candidates.length };
  }

  /**
   * Fill a document's due date from the payment terms it references (19-S.9).
   *
   * Computed, never guessed: `dueDateField` marks the kinds that have one, an explicit `dueDate` from
   * the caller always wins, and `recompute` (the terms or the document date changed) replaces a stored
   * value with the derived one.
   */
  private async withDueDate(
    descriptor: SalesDocumentDescriptor,
    data: Record<string, unknown>,
    recompute = false,
  ): Promise<Record<string, unknown>> {
    const field = descriptor.dueDateField;
    if (field === undefined) return data;
    const terms = await this.paymentTermsFor(text(data["paymentTermId"]));
    if (terms === null) return data;
    if (!recompute && text(data[field]) !== undefined) return data;
    const documentDate = text(data[descriptor.dateField]);
    if (documentDate === undefined) return data;
    return { ...data, [field]: dueDateFor(documentDate, terms) };
  }

  /** The terms a document references, or `null` when it references none. */
  private async paymentTermsFor(
    paymentTermId: string | undefined,
  ): Promise<PaymentTerms | null> {
    if (paymentTermId === undefined) return null;
    const row = await this.records.byId("PaymentTermProfile", paymentTermId);
    if (row === undefined)
      throw new NotFoundError(`Payment terms "${paymentTermId}" do not exist.`);
    if (row.data["active"] === false) {
      throw new ValidationError(
        `Payment terms "${row.name ?? paymentTermId}" are inactive.`,
        { paymentTermId },
      );
    }
    return {
      dueDays:
        typeof row.data["dueDays"] === "number" ? row.data["dueDays"] : 30,
      basis: text(row.data["basis"]) === "endOfMonth" ? "endOfMonth" : "net",
    };
  }

  /**
   * How much of each order line the confirmed delivery orders have moved.
   *
   * A delivery order item names the source line it came from (`sourceItemId`), and a delivery order
   * that was never confirmed moved nothing. This is the read the fulfilment state is derived from, and
   * the same read a stock reservation would use once inventory arrives in 19-S.14.
   */
  private async confirmedDeliveryQuantities(
    orderId: string,
  ): Promise<Map<string, string[]>> {
    const moved = new Map<string, string[]>();
    const deliveries = await this.records.find(
      "DeliveryOrder",
      { salesOrderId: orderId, status: "confirmed" },
      MAX_LINE_ITEMS,
    );
    if (deliveries.length === 0) return moved;
    const deliveryIds = deliveries.map((delivery) => delivery.id);
    const items = await this.records.findByIdsIn(
      "DeliveryOrderItem",
      "deliveryOrderId",
      deliveryIds,
      MAX_LINE_ITEMS * deliveryIds.length,
    );
    for (const item of items) {
      const sourceItemId = text(item.data["sourceItemId"]);
      if (sourceItemId === undefined) continue;
      const list = moved.get(sourceItemId) ?? [];
      list.push(text(item.data["quantity"]) ?? "0");
      moved.set(sourceItemId, list);
    }
    return moved;
  }

  /**
   * Refuse a conversion that would bill or fulfil the same thing twice (§4.5, §4.6).
   *
   * Two rules: one generated document per (source, destination kind), and a quote that already became a
   * sales order cannot also be invoiced directly — that is the same acceptance reaching the customer
   * twice by two routes. A repeated call with the same `correlationId` never reaches here, because it
   * returns the document that already exists.
   */
  private async assertConvertible(
    descriptor: SalesDocumentDescriptor,
    row: SalesRow,
    conversion: DocumentConversion,
  ): Promise<void> {
    const targetDescriptor = documentDescriptor(conversion.toKind);
    const sameKind = await this.records.find(
      targetDescriptor.entity,
      { sourceEntity: descriptor.entity, sourceId: row.id },
      1,
    );
    const existing = sameKind[0];
    if (existing !== undefined) {
      throw new ValidationError(
        `This ${descriptor.label.toLowerCase()} already produced a ${targetDescriptor.label.toLowerCase()}; a second one needs an explicit workflow that does not exist yet.`,
        { kind: descriptor.kind, id: row.id, existingId: existing.id },
      );
    }
    if (descriptor.kind === "quote" && conversion.toKind === "invoice") {
      const orders = await this.records.find(
        documentDescriptor("salesOrder").entity,
        { sourceEntity: descriptor.entity, sourceId: row.id },
        1,
      );
      const order = orders[0];
      if (order !== undefined) {
        throw new ValidationError(
          "This quote already became a sales order; invoice the order instead, so the same acceptance is not billed twice.",
          { quoteId: row.id, salesOrderId: order.id },
        );
      }
    }
  }

  /** Recalculate on demand. An issued document is never rewritten by this. */
  async recalculate(
    kind: ImplementedDocumentKind,
    id: string,
  ): Promise<DocumentView> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "read");
    const settings = await this.settings.read();
    const row = await this.requireDocument(descriptor, id);
    if (!isIssued(lockStateOf(descriptor, row))) {
      const stored = await this.itemsOf(descriptor, id);
      const totals = await this.totalsFor(descriptor, row, stored, false);
      await this.entities.update(
        descriptor.entity,
        id,
        totalsPatch(totals, stored.length, settings),
      );
    }
    return await this.view(kind, id);
  }

  /**
   * Apply a named state transition.
   *
   * The issuing transition is the transaction the plan calls out (§4.7): validate, recalculate with
   * prices required, snapshot, allocate the number, record issuer/time, lock, emit the event. No
   * external call happens inside the transaction.
   */
  async transition(
    kind: ImplementedDocumentKind,
    id: string,
    action: string,
    audit: SalesAuditContext = {},
  ): Promise<DocumentView> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "edit");
    const settings = await this.settings.read();
    const row = await this.requireDocument(descriptor, id);
    const currentState = statusOf(row, descriptor);

    const transition = findTransition(descriptor, action);
    if (transition === undefined) {
      throw new ValidationError(
        `A ${descriptor.label.toLowerCase()} has no "${action}" action.`,
        { kind, action },
      );
    }
    if (!transition.from.includes(currentState)) {
      throw new ValidationError(
        `"${transition.label}" is not allowed from the "${currentState}" state of a ${descriptor.label.toLowerCase()}; allowed from: ${transition.from.join(", ")}.`,
        { kind, action, state: currentState, allowedFrom: transition.from },
      );
    }
    if (transition.requiresReason === true)
      requireReason(audit.reason, `"${transition.label}"`);
    assertInventoryPolicy(
      descriptor,
      transition,
      settings.settings.features.inventory,
    );

    if (transition.issues === true) {
      await this.issue(descriptor, row, transition, settings);
    } else {
      await runInTransaction(this.database.db, async () => {
        await this.entities.update(descriptor.entity, id, {
          status: transition.to,
        });
        await this.emit(descriptor, id, action, {
          status: transition.to,
          reason: audit.reason ?? null,
        });
      });
    }
    return await this.view(kind, id);
  }

  /**
   * Privileged unlock of an issued document (§4.7). Requires the dedicated permission (or an
   * administrator) plus a reason; both land in the audit trail and the event.
   */
  async unlock(
    kind: ImplementedDocumentKind,
    id: string,
    reason: string,
    audit: SalesAuditContext = {},
  ): Promise<DocumentView> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "edit");
    const row = await this.requireDocument(descriptor, id);
    const state = lockStateOf(descriptor, row);
    assertUnlockAllowed(state, {
      isAdmin: this.scope.isAdmin,
      canUnlock: false,
    });
    const unlocked = applyUnlock(
      state,
      { userId: this.scope.userId ?? "system" },
      reason,
      new Date().toISOString(),
    );
    await runInTransaction(this.database.db, async () => {
      await this.entities.update(descriptor.entity, id, {
        lockedAt: null,
        lockedBy: null,
        unlockedAt: unlocked.state.unlockedAt,
        unlockedBy: unlocked.state.unlockedBy,
      });
      await this.emit(descriptor, id, "unlocked", {
        reason: unlocked.reason,
        correlationId: audit.correlationId ?? null,
      });
    });
    return await this.view(kind, id);
  }

  /**
   * Delete a **draft**. An issued document is never deleted: it is voided, credited or corrected, and
   * the compensating records stay (§4.9).
   */
  async removeDraft(kind: ImplementedDocumentKind, id: string): Promise<void> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "delete");
    const row = await this.requireDocument(descriptor, id);
    const state = lockStateOf(descriptor, row);
    if (isIssued(state)) {
      throw new ValidationError(
        `An issued ${descriptor.label.toLowerCase()} is never deleted; void it or issue a credit note instead.`,
        { kind, issuedAt: state.issuedAt },
      );
    }
    await runInTransaction(this.database.db, async () => {
      await this.deleteItems(descriptor, id);
      await this.entities.remove(descriptor.entity, id);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Conversion — the quote → order → invoice/delivery chain (§4.5, §4.6)
  // ---------------------------------------------------------------------------------------------

  /**
   * Convert a source document into a new draft of another kind.
   *
   * Values are **copied by value**: the destination's lines are re-snapshotted from the source's
   * stored items, never re-resolved from the catalog, so an accepted quote converts into exactly what
   * was accepted (§4.6). Idempotency is the caller's `correlationId` — a repeated call with the same
   * correlation returns the document that already exists instead of creating a second one.
   */
  async convert(
    kind: ImplementedDocumentKind,
    id: string,
    action: string,
    audit: SalesAuditContext = {},
    overrides: Record<string, unknown> = {},
  ): Promise<DocumentView> {
    const descriptor = documentDescriptor(kind);
    await this.acl.assertAccess(descriptor.entity, "read");
    const row = await this.requireDocument(descriptor, id);
    const currentState = statusOf(row, descriptor);

    const conversion = findConversion(descriptor, action);
    if (conversion === undefined) {
      throw new ValidationError(
        `A ${descriptor.label.toLowerCase()} cannot be converted with "${action}".`,
        { kind, action },
      );
    }
    const refusal = conversionRefusal(descriptor, action, currentState);
    if (refusal !== null)
      throw new ValidationError(refusal, { kind, action, state: currentState });

    const target = documentDescriptor(conversion.toKind);
    await this.acl.assertAccess(target.entity, "create");

    // Idempotency first: a retry of the *same* conversion must return the document it already created,
    // not be refused by the duplicate guard below. The guard exists for a genuinely second conversion,
    // which is a different request with a different correlation id.
    const correlationId = audit.correlationId?.trim();
    if (correlationId !== undefined && correlationId !== "") {
      const existing = await this.findBySource(
        target,
        descriptor.entity,
        row.id,
        correlationId,
      );
      if (existing !== undefined)
        return await this.view(conversion.toKind, existing);
    }
    await this.assertConvertible(descriptor, row, conversion);

    const sourceItems = await this.itemsOf(descriptor, id);
    if (sourceItems.length === 0) {
      throw new ValidationError(
        `A ${descriptor.label.toLowerCase()} with no lines cannot be converted.`,
        { kind, id },
      );
    }

    const header: Record<string, unknown> = {
      sourceEntity: descriptor.entity,
      sourceId: row.id,
      correlationId: correlationId ?? null,
      ...overrides,
    };
    for (const field of conversion.copyFields) {
      const value = row.data[field];
      if (value !== undefined && value !== null) header[field] = value;
    }

    return await this.create({
      kind: conversion.toKind,
      data: header,
      items: itemsToLineInputsWithSource(sourceItems),
      audit,
    });
  }

  /** Remaining-quantity guard shared by delivery, return and partial invoicing (§4.10). */
  async assertWithinRemaining(
    descriptor: SalesDocumentDescriptor,
    sourceDocumentId: string,
    requested: ReadonlyMap<string, string>,
    alreadyMoved: ReadonlyMap<string, readonly string[]>,
  ): Promise<void> {
    const items = await this.itemsOf(descriptor, sourceDocumentId);
    assertWithinRemaining(
      requested,
      alreadyMoved,
      new Map(items.map((item) => [item.id, item.quantity])),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  /**
   * The issuance transaction (§4.7): everything local happens here, and the outbox row is written in
   * the same transaction, so a crash between the two is impossible.
   */
  private async issue(
    descriptor: SalesDocumentDescriptor,
    row: SalesRow,
    transition: DocumentTransition,
    settings: Awaited<ReturnType<SalesSettingsService["read"]>>,
  ): Promise<void> {
    const items = await this.itemsOf(descriptor, row.id);
    // Prices are required at issuance: an unpriced line must not become an official document.
    const totals = await this.totalsFor(descriptor, row, items, true);
    const parties = await this.partySnapshot(row);
    const issuedAt = new Date();
    const issuer = this.scope.principal?.userName ?? this.scope.userId ?? null;
    const locked = descriptor.lockPolicy.lockOnIssue;

    const captured: CommercialSnapshot = {
      kind: descriptor.kind,
      number: "",
      status: transition.to,
      currency: totals.currency,
      exchangeRate: totals.exchangeRate,
      baseCurrency: totals.baseCurrency,
      parties,
      items: items.map((item, index) =>
        itemRecordPayloadFromStored(item, totals.lines[index] as never),
      ),
      totals,
      policy: {
        settingsVersion: settings.version,
        roundingStage: settings.settings.tax.roundingStage,
        roundingMode: settings.settings.tax.roundingMode,
        taxInclusive: totals.taxInclusive,
        quantityPrecision: settings.settings.quantityPrecision,
        missingTaxPolicy: settings.settings.tax.missingTaxPolicy,
      },
    };

    await runInTransaction(this.database.db, async (tx) => {
      const allocation = await this.numbering.allocate(descriptor.seriesCode, {
        documentType: descriptor.entity,
        documentId: row.id,
      });
      const envelope = buildDocumentSnapshot<CommercialSnapshot>(
        `${descriptor.entity}:${row.id}`,
        { ...captured, number: allocation.formatted },
        issuedAt.toISOString(),
      );
      await this.entities.update(descriptor.entity, row.id, {
        ...totalsPatch(totals, items.length, settings),
        number: allocation.formatted,
        status: transition.to,
        issuedAt,
        issuedBy: issuer,
        lockedAt: locked ? issuedAt : null,
        lockedBy: locked ? issuer : null,
        snapshot: JSON.stringify(envelope),
      });
      await this.outbox.insertMany(tx, [
        {
          eventType: `sales.${descriptor.kind}.${transition.action}`,
          payload: {
            kind: descriptor.kind,
            entity: descriptor.entity,
            id: row.id,
            number: allocation.formatted,
            status: transition.to,
            currency: totals.currency,
            grossTotal: totals.grossTotal,
            accountId: parties.accountId,
            actor: issuer,
            occurredAt: issuedAt.toISOString(),
          },
        },
      ]);
    });
  }

  /**
   * Party data captured by value. Reading the Account/Contact goes through the record API, so a user
   * who may not read the customer cannot issue a document to them — a refusal, not a silent gap.
   */
  private async partySnapshot(row: SalesRow): Promise<DocumentPartySnapshot> {
    const accountId = text(row.data["accountId"]) ?? null;
    const contactId = text(row.data["contactId"]) ?? null;
    let accountName: string | null = null;
    let contactName: string | null = null;
    if (accountId !== null)
      accountName =
        text((await this.entities.get("Account", accountId))["name"]) ?? null;
    if (contactId !== null)
      contactName =
        text((await this.entities.get("Contact", contactId))["name"]) ?? null;
    return {
      accountId,
      accountName,
      contactId,
      contactName,
      billingAddress: text(row.data["billingAddress"]) ?? null,
      shippingAddress: text(row.data["shippingAddress"]) ?? null,
    };
  }

  /**
   * Replace a document's lines: delete the old ones, calculate the new ones with the document's own
   * context (currency, date, shipping, discount) and write them as records. Item-level net/tax are
   * stored, so a line's own numbers survive even if the catalog changes later.
   */
  private async replaceItems(
    descriptor: SalesDocumentDescriptor,
    documentId: string,
    row: SalesRow,
    lines: readonly RequestedLine[],
    settings: SalesSettings,
  ): Promise<void> {
    validateRequestedLines(lines, {
      quantityPrecision: settings.quantityPrecision,
      minItems: 0,
      maxItems: descriptor.maxItems,
      requireUnitPrice: false,
    });
    const totals = await this.totalsForRequested(
      descriptor,
      row,
      lines,
      settings,
    );
    await runInTransaction(this.database.db, async () => {
      await this.deleteItems(descriptor, documentId);
      for (const [index, line] of lines.entries()) {
        const lineTotals = totals.lines[index];
        if (lineTotals === undefined) {
          throw new ValidationError(
            `Line ${String(index + 1)} could not be calculated.`,
            { line: index + 1 },
          );
        }
        await this.entities.create(descriptor.itemEntity, {
          position: lineTotals.position,
          productId: lineTotals.productId,
          name: lineTotals.name ?? line.name ?? `Line ${String(index + 1)}`,
          sku: lineTotals.sku,
          unit: lineTotals.unit,
          quantity: lineTotals.quantity,
          unitPrice: lineTotals.unitPrice,
          discountPercent: line.discountPercent ?? null,
          discountAmount: lineTotals.discountAmount,
          taxCodeId: lineTotals.tax?.taxCodeId ?? null,
          taxRatePercent: lineTotals.tax?.taxRatePercent ?? "0",
          taxSource: lineTotals.tax?.source ?? "none",
          taxRuleId: lineTotals.tax?.ruleId ?? null,
          sourceItemId: line.sourceItemId ?? null,
          netAmount: lineTotals.netAmount,
          taxAmount: lineTotals.taxAmount,
          grossAmount: lineTotals.grossAmount,
          [descriptor.itemParentField]: documentId,
        });
      }
    });
  }

  private async deleteItems(
    descriptor: SalesDocumentDescriptor,
    documentId: string,
  ): Promise<void> {
    const rows = await this.records.find(
      descriptor.itemEntity,
      { [descriptor.itemParentField]: documentId },
      MAX_LINE_ITEMS,
    );
    for (const row of rows)
      await this.entities.remove(descriptor.itemEntity, row.id);
  }

  /** Recalculate from the document's stored items. */
  private async totalsFor(
    descriptor: SalesDocumentDescriptor,
    row: SalesRow,
    items: readonly StoredItem[],
    requireUnitPrice: boolean,
  ): Promise<TotalsResult> {
    const settings = (await this.settings.read()).settings;
    const lines = itemsToLineInputs(items);
    validateRequestedLines(lines, {
      quantityPrecision: settings.quantityPrecision,
      minItems: requireUnitPrice ? descriptor.minItems : 0,
      maxItems: descriptor.maxItems,
      requireUnitPrice,
    });
    return await this.calculate(descriptor, row, lines, settings);
  }

  /** Calculate a set of requested lines in the document's own context. */
  private async totalsForRequested(
    descriptor: SalesDocumentDescriptor,
    row: SalesRow,
    lines: readonly RequestedLine[],
    settings: SalesSettings,
  ): Promise<TotalsResult> {
    return await this.calculate(descriptor, row, lines, settings);
  }

  private async calculate(
    descriptor: SalesDocumentDescriptor,
    row: SalesRow,
    lines: readonly RequestedLine[],
    settings: SalesSettings,
  ): Promise<TotalsResult> {
    const data = row.data;
    const currency = normalizeCurrencyCode(
      text(data["currency"]) ?? settings.currency.defaultCurrency,
    );
    const date = resolveDay(text(data[descriptor.dateField]));
    const shippingAmount = text(data["shippingAmount"]);
    const shipping =
      shippingAmount === undefined || isZeroString(shippingAmount)
        ? undefined
        : {
            amount: shippingAmount,
            taxCodeId: text(data["shippingTaxCodeId"]) ?? null,
          };
    return await this.tax.preview({
      currency,
      date,
      taxInclusive:
        typeof data["taxInclusive"] === "boolean"
          ? data["taxInclusive"]
          : undefined,
      accountId: text(data["accountId"]) ?? null,
      jurisdiction: text(data["jurisdiction"]) ?? null,
      lines: lines.map((line) => ({ ...line })),
      shipping,
      documentDiscountAmount: text(data["documentDiscountAmount"]) ?? undefined,
      exchangeRate: readExchangeRate(data["exchangeRateSnapshot"]),
    });
  }

  private async itemsOf(
    descriptor: SalesDocumentDescriptor,
    documentId: string,
  ): Promise<StoredItem[]> {
    const rows = await this.records.find(
      descriptor.itemEntity,
      { [descriptor.itemParentField]: documentId },
      MAX_LINE_ITEMS,
    );
    return orderByPosition(rows.map(toStoredItem));
  }

  private async requireDocument(
    descriptor: SalesDocumentDescriptor,
    id: string,
  ): Promise<SalesRow> {
    const row = await this.records.byId(descriptor.entity, id);
    if (row === undefined)
      throw new NotFoundError(`${descriptor.label} "${id}" does not exist.`);
    return row;
  }

  /** The frozen envelope of an issued document, integrity-checked before it is trusted. */
  private issuedSnapshot(
    descriptor: SalesDocumentDescriptor,
    row: SalesRow,
  ): DocumentSnapshot<CommercialSnapshot> | undefined {
    if (!isIssued(lockStateOf(descriptor, row))) return undefined;
    const stored = row.data["snapshot"];
    if (stored === undefined || stored === null || stored === "")
      return undefined;
    try {
      return parseDocumentSnapshot<CommercialSnapshot>(
        stored as string | DocumentSnapshot<CommercialSnapshot>,
      );
    } catch {
      throw new ValidationError(
        "The stored document snapshot failed its integrity check; the document cannot be rendered from it.",
        {
          kind: descriptor.kind,
          id: row.id,
        },
      );
    }
  }

  private async findBySource(
    target: SalesDocumentDescriptor,
    sourceEntity: string,
    sourceId: string,
    correlationId: string,
  ): Promise<string | undefined> {
    const rows = await this.records.find(
      target.entity,
      { sourceEntity, sourceId, correlationId },
      1,
    );
    return rows[0]?.id;
  }

  private async emit(
    descriptor: SalesDocumentDescriptor,
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const db = currentTx() ?? this.database.db;
    await this.outbox.insertMany(db, [
      {
        eventType: `sales.${descriptor.kind}.${action}`,
        payload: {
          kind: descriptor.kind,
          entity: descriptor.entity,
          id,
          actor: this.scope.principal?.userName ?? this.scope.userId ?? null,
          occurredAt: new Date().toISOString(),
          ...payload,
        },
      },
    ]);
  }

  private toView(
    descriptor: SalesDocumentDescriptor,
    row: SalesRow,
    items: readonly StoredItem[],
    totals: TotalsResult,
    fromSnapshot: boolean,
  ): DocumentView {
    const state = lockStateOf(descriptor, row);
    const currentState = statusOf(row, descriptor);
    return {
      kind: descriptor.kind,
      id: row.id,
      descriptor: {
        label: descriptor.label,
        entity: descriptor.entity,
        seriesCode: descriptor.seriesCode,
        states: descriptor.states,
      },
      document: { ...row.data, id: row.id, status: currentState },
      items,
      totals,
      lock: { ...state, locked: isLocked(state, descriptor.lockPolicy) },
      fromSnapshot,
      availableTransitions: descriptor.transitions
        .filter((transition) => transition.from.includes(currentState))
        .map((transition) => transition.action),
      availableConversions: descriptor.conversions
        .filter((conversion) => conversion.from.includes(currentState))
        .map((conversion) => conversion.action),
    };
  }
}

function requireReason(reason: string | undefined, what: string): void {
  if (reason === undefined || reason.trim() === "") {
    throw new ValidationError(`${what} requires a reason.`, {
      reason: reason ?? null,
    });
  }
}

/**
 * Inventory is a feature flag, and the stock effects of a confirmation arrive with 19-S.14.
 *
 * With the flag off — the default — confirming a document has no stock consequence, and saying so is
 * honest. With the flag **on**, refusing is the only correct answer: silently confirming would leave an
 * operator believing stock had been reserved when nothing was written (§4.6 "confirmation must not
 * decrement stock unless the configured policy explicitly says it does").
 */
function assertInventoryPolicy(
  descriptor: SalesDocumentDescriptor,
  transition: DocumentTransition,
  inventoryEnabled: boolean,
): void {
  if (!inventoryEnabled || transition.issues !== true) return;
  if (
    descriptor.kind !== "salesOrder" &&
    descriptor.kind !== "deliveryOrder" &&
    descriptor.kind !== "returnOrder"
  )
    return;
  throw new ValidationError(
    `Inventory is enabled, but stock reservation and movement arrive with 19-S.14. Confirming this ${descriptor.label.toLowerCase()} would silently skip them, so it is refused.`,
    { kind: descriptor.kind, action: transition.action },
  );
}

/** A caller may not set a field the server owns — a crafted request must not be able to. */
function rejectServerOwned(data: Record<string, unknown> | undefined): void {
  if (data === undefined) return;
  const offending = Object.keys(data).filter((key) =>
    SERVER_OWNED_FIELDS.includes(key),
  );
  if (offending.length > 0) {
    throw new ValidationError(
      `These fields are computed by the server and cannot be set: ${offending.join(", ")}.`,
      {
        fields: offending,
      },
    );
  }
}

function totalsPatch(
  totals: TotalsResult,
  itemsCount: number,
  settings: Awaited<ReturnType<SalesSettingsService["read"]>>,
): Record<string, unknown> {
  return {
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    shippingTaxAmount: totals.shippingTaxAmount,
    taxBreakdown: JSON.stringify(totals.taxBreakdown),
    taxTotal: totals.taxTotal,
    netTotal: totals.netTotal,
    grossTotal: totals.grossTotal,
    amountDue: totals.amountDue,
    baseCurrency: totals.baseCurrency,
    exchangeRate: totals.exchangeRate,
    baseGrossTotal: totals.baseGrossTotal,
    roundingStage: settings.settings.tax.roundingStage,
    roundingMode: settings.settings.tax.roundingMode,
    taxInclusive: totals.taxInclusive,
    settingsVersion: settings.version,
    itemsCount,
  };
}

function lockStateOf(
  descriptor: SalesDocumentDescriptor,
  row: SalesRow,
): DocumentLockState {
  return {
    kind: descriptor.kind,
    issuedAt: isoOrNull(row.data["issuedAt"]),
    issuedBy: text(row.data["issuedBy"]) ?? null,
    lockedAt: isoOrNull(row.data["lockedAt"]),
    lockedBy: text(row.data["lockedBy"]) ?? null,
    unlockedAt: isoOrNull(row.data["unlockedAt"]),
    unlockedBy: text(row.data["unlockedBy"]) ?? null,
  };
}

function statusOf(row: SalesRow, descriptor: SalesDocumentDescriptor): string {
  return text(row.data["status"]) ?? descriptor.initialState;
}

function toStoredItem(row: SalesRow): StoredItem {
  return {
    id: row.id,
    position: numberOr(row.data["position"], 0),
    productId: text(row.data["productId"]) ?? null,
    name: text(row.data["name"]) ?? null,
    sku: text(row.data["sku"]) ?? null,
    unit: text(row.data["unit"]) ?? null,
    quantity: text(row.data["quantity"]) ?? "0",
    unitPrice: text(row.data["unitPrice"]) ?? "0",
    discountPercent: text(row.data["discountPercent"]) ?? null,
    discountAmount: text(row.data["discountAmount"]) ?? "0",
    taxCodeId: text(row.data["taxCodeId"]) ?? null,
    taxRatePercent: text(row.data["taxRatePercent"]) ?? null,
  };
}

function orderByPosition(items: readonly StoredItem[]): StoredItem[] {
  return [...items].sort(
    (left, right) =>
      left.position - right.position ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

function readExchangeRate(value: unknown): ExchangeRateInput | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as ExchangeRateInput;
    } catch {
      throw new ValidationError(
        "The stored exchange-rate snapshot is not valid JSON.",
      );
    }
  }
  if (typeof value === "object") return value as ExchangeRateInput;
  throw new ValidationError(
    "The exchange-rate snapshot must be an object or a JSON string.",
  );
}

function requireId(
  created: Record<string, unknown>,
  descriptor: SalesDocumentDescriptor,
): string {
  const id = text(created["id"]);
  if (id === undefined)
    throw new ValidationError(
      `Creating a ${descriptor.label.toLowerCase()} returned no id.`,
    );
  return id;
}

function isZeroString(value: string): boolean {
  return /^-?0(\.0+)?$/.test(value);
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value) ?? null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
