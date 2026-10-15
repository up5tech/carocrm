import { describe, expect, it } from 'vitest';

import { coreMetadata } from '../../../database/seed-metadata.js';
import {
  admitsRestock,
  DEFAULT_RESTOCK_DISPOSITION,
  movementKey,
  parseRestockDisposition,
  planDeliveryMovement,
  planReceiptMovement,
  planReturnMovement,
  RESTOCK_DISPOSITIONS,
  restockingLines,
} from '../src/sales/document/stock-movement.js';

/**
 * Phase 19-S.12 / 19-S.13 — the stock-movement contract, pure.
 *
 * Three things the acceptance criteria rest on, with no database, no clock and no ledger:
 *
 *  - a return restocks **only** the lines whose disposition allows it, and still records the lines it
 *    refused, because "this line was scrapped" is a fact an operator has to see;
 *  - the idempotency key comes from the document, never from a request value, so a retried
 *    confirmation asks for the same movement once;
 *  - the disposition enum the contract knows is the one the metadata stores — a drift between the two
 *    would silently turn a stored `scrap` into the default `restock`.
 */

const lines = [
  { position: 1, productId: 'p1', sourceItemId: 's1', quantity: '2' },
  { position: 2, productId: 'p2', sourceItemId: 's2', quantity: '3' },
];

describe('movement keys (19-S.12)', () => {
  it('is the document entity and id, so a retry produces the same key', () => {
    expect(movementKey('DeliveryOrder', 'do1')).toBe('DeliveryOrder:do1');
    const first = planDeliveryMovement({ documentEntity: 'DeliveryOrder', documentId: 'do1', items: lines });
    const retry = planDeliveryMovement({ documentEntity: 'DeliveryOrder', documentId: 'do1', items: lines });
    expect(first.key).toBe(retry.key);
  });

  it('names the document it was frozen from, including its official number', () => {
    const plan = planDeliveryMovement({
      documentEntity: 'DeliveryOrder',
      documentId: 'do1',
      documentNumber: 'DO-000007',
      warehouseId: 'wh1',
      items: lines,
    });
    expect(plan).toMatchObject({ kind: 'delivery', documentNumber: 'DO-000007', warehouseId: 'wh1' });
    expect(plan.lines.map((line) => line.warehouseId)).toEqual(['wh1', 'wh1']);
  });
});

describe('delivery and receipt plans (19-S.12, 19-S.13)', () => {
  it('moves every line it carries — there is no per-line gate on the way out', () => {
    const plan = planDeliveryMovement({ documentEntity: 'DeliveryOrder', documentId: 'do1', items: lines });
    expect(plan.lines.every((line) => line.restocked)).toBe(true);
    expect(restockingLines(plan)).toHaveLength(2);
  });

  it('records a confirmed receipt as an inbound movement of its own kind', () => {
    const plan = planReceiptMovement({ documentEntity: 'ReceiptOrder', documentId: 'ro1', items: lines });
    expect(plan.kind).toBe('receipt');
    expect(plan.key).toBe('ReceiptOrder:ro1');
    expect(plan.lines.every((line) => line.restocked)).toBe(true);
  });
});

describe('return dispositions (19-S.12)', () => {
  it('brings back only the lines whose disposition allows it', () => {
    const plan = planReturnMovement({
      documentEntity: 'ReturnOrder',
      documentId: 'r1',
      items: [
        { ...lines[0], disposition: 'restock' },
        { ...lines[1], disposition: 'scrap' },
      ],
    });
    // Every line stays on the plan: one that must not be restocked is still a fact to report.
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[1]).toMatchObject({ restocked: false, disposition: 'scrap' });
    expect(restockingLines(plan).map((line) => line.position)).toEqual([1]);
  });

  it('defaults an absent disposition to restock, and refuses one it does not recognise', () => {
    const plan = planReturnMovement({
      documentEntity: 'ReturnOrder',
      documentId: 'r1',
      items: [{ ...lines[0], disposition: null }, { ...lines[1], disposition: 'melted' }],
    });
    expect(DEFAULT_RESTOCK_DISPOSITION).toBe('restock');
    // An absent disposition is the documented default; a value outside the enum fails closed.
    expect(plan.lines[0]).toMatchObject({ restocked: true, disposition: null });
    expect(plan.lines[1]).toMatchObject({ restocked: false, disposition: null });
    expect(admitsRestock('quarantine')).toBe(false);
    expect(admitsRestock(null)).toBe(true);
  });

  it('reads only the dispositions the contract knows', () => {
    expect(parseRestockDisposition('quarantine')).toBe('quarantine');
    expect(parseRestockDisposition('RESTOCK')).toBeNull();
    expect(parseRestockDisposition(undefined)).toBeNull();
  });
});

describe('the metadata mirror', () => {
  /**
   * `ReturnOrderItem.disposition` is an `enum` field whose values are the contract's list. Read from
   * the seed source rather than the database so the check runs with no database at all.
   */
  it('stores exactly the dispositions `stock-movement.ts` admits', () => {
    const entry = coreMetadata.find((candidate) => candidate.name === 'ReturnOrderItem');
    const fields = (entry?.data as { fields?: Record<string, { values?: string[] }> } | undefined)?.fields;
    expect(fields?.['disposition']?.values).toEqual([...RESTOCK_DISPOSITIONS]);
  });
});
