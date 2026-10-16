import { describe, expect, it } from 'vitest';

import {
  actionRefusal,
  ADJUSTMENT_TRANSITIONS,
  assertDeltaSign,
  availableToPromise,
  findNamedAction,
  levelKey,
  movementKeyFor,
  reconcileStock,
  reservationRefusal,
  signedQuantity,
  signOf,
  stockLevel,
  TRANSFER_TRANSITIONS,
} from '../src/sales/inventory/ledger.js';

/**
 * Phase 19-S.14 — the pure inventory rules, with no database, no clock and no socket.
 *
 * The plan's acceptance criteria for the ledger are that every movement's direction is fixed by what
 * happened, that availability keeps on-hand/reserved/available/incoming apart, and that a projection
 * can be reconciled against the ledger. All three are functions of their arguments here, so they are
 * exercised directly rather than through a confirmation.
 */
describe('inventory ledger — signed movement quantities', () => {
  it('fixes the sign of every physical event type', () => {
    expect(signOf('receipt')).toBe(1);
    expect(signOf('return')).toBe(1);
    expect(signOf('transferIn')).toBe(1);
    expect(signOf('openingBalance')).toBe(1);
    expect(signOf('delivery')).toBe(-1);
    expect(signOf('transferOut')).toBe(-1);
    // A correction is the two that may legitimately carry either sign.
    expect(signOf('adjustment')).toBe(0);
    expect(signOf('correction')).toBe(0);
  });

  it('combines a positive magnitude with the direction of the movement', () => {
    expect(signedQuantity('5', 1)).toBe('5');
    expect(signedQuantity('5', -1)).toBe('-5');
    // The magnitude's own scale is preserved, so a movement keeps the precision it was stated at.
    expect(signedQuantity('2.50', -1)).toBe('-2.50');
    // Zero has no sign to carry.
    expect(signedQuantity('0', -1)).toBe('0');
  });

  it('refuses a caller that passes a signed magnitude', () => {
    expect(() => signedQuantity('-5', 1)).toThrow(/positive magnitude/);
  });

  it('refuses a delta whose sign contradicts its type', () => {
    expect(() => assertDeltaSign('delivery', '-3')).not.toThrow();
    expect(() => assertDeltaSign('delivery', '3')).toThrow(/outbound/);
    expect(() => assertDeltaSign('receipt', '3')).not.toThrow();
    expect(() => assertDeltaSign('receipt', '-3')).toThrow(/inbound/);
    // Both directions are legitimate for a reviewed correction.
    expect(() => assertDeltaSign('adjustment', '3')).not.toThrow();
    expect(() => assertDeltaSign('adjustment', '-3')).not.toThrow();
    // Zero is never a movement in either direction.
    expect(() => assertDeltaSign('delivery', '0')).not.toThrow();
  });

  it('derives one idempotency key per document, line and direction', () => {
    expect(movementKeyFor('DeliveryOrder', 'abc', 'delivery', 0)).toBe(
      'DeliveryOrder:abc:delivery:0',
    );
    expect(movementKeyFor('TransferOrder', 'abc', 'transferOut', 1)).toBe(
      'TransferOrder:abc:transferOut:1',
    );
    // The two sides of one transfer are different keys, so neither can suppress the other.
    expect(movementKeyFor('TransferOrder', 'abc', 'transferOut', 0)).not.toBe(
      movementKeyFor('TransferOrder', 'abc', 'transferIn', 0),
    );
  });
});

describe('inventory ledger — availability', () => {
  it('keeps on-hand, reserved, available and incoming apart', () => {
    const level = stockLevel('10', '3', '5');
    expect(level).toEqual({
      onHand: '10',
      reserved: '3',
      available: '7',
      incoming: '5',
    });
  });

  it('derives available-to-promise, allowing a soft over-reservation to show negative', () => {
    expect(availableToPromise('10', '4')).toBe('6');
    expect(availableToPromise('2', '5')).toBe('-3');
    expect(availableToPromise('0', '0')).toBe('0');
  });

  it('refuses an over-reservation only under the hard policy', () => {
    expect(
      reservationRefusal({ policy: 'hard', available: '3', quantity: '3' }),
    ).toBeNull();
    expect(
      reservationRefusal({ policy: 'hard', available: '3', quantity: '4' }),
    ).toMatch(/Only 3 .* available/);
    // A soft policy records the promise and reports the shortfall rather than refusing it.
    expect(
      reservationRefusal({ policy: 'soft', available: '0', quantity: '4' }),
    ).toBeNull();
    expect(
      reservationRefusal({ policy: 'none', available: '10', quantity: '1' }),
    ).toMatch(/disabled/);
  });

  it('refuses a non-positive reservation outright', () => {
    expect(() =>
      reservationRefusal({ policy: 'hard', available: '3', quantity: '0' }),
    ).toThrow(/positive quantity/);
    expect(() =>
      reservationRefusal({ policy: 'hard', available: '3', quantity: '-1' }),
    ).toThrow(/positive quantity/);
  });
});

describe('inventory ledger — the small state machines', () => {
  it('makes a transfer go draft → inTransit → received, and cancels only a draft', () => {
    expect(actionRefusal(TRANSFER_TRANSITIONS, 'transfer', 'confirm', 'draft')).toBeNull();
    expect(actionRefusal(TRANSFER_TRANSITIONS, 'transfer', 'confirm', 'inTransit')).toMatch(
      /not allowed from the "inTransit" state/,
    );
    expect(actionRefusal(TRANSFER_TRANSITIONS, 'transfer', 'receive', 'inTransit')).toBeNull();
    expect(actionRefusal(TRANSFER_TRANSITIONS, 'transfer', 'receive', 'draft')).toMatch(
      /not allowed/,
    );
    // Cancelling after dispatch is refused: the source half already moved, so the correction is a
    // reverse transfer, not a cancellation.
    expect(actionRefusal(TRANSFER_TRANSITIONS, 'transfer', 'cancel', 'inTransit')).toMatch(
      /not allowed/,
    );
    expect(findNamedAction(TRANSFER_TRANSITIONS, 'cancel')?.requiresReason).toBe(true);
  });

  it('makes an adjustment pending → applied or rejected', () => {
    expect(
      actionRefusal(
        ADJUSTMENT_TRANSITIONS,
        'inventory adjustment',
        'approve',
        'pending',
      ),
    ).toBeNull();
    expect(
      actionRefusal(
        ADJUSTMENT_TRANSITIONS,
        'inventory adjustment',
        'approve',
        'applied',
      ),
    ).toMatch(/not allowed/);
    expect(
      actionRefusal(
        ADJUSTMENT_TRANSITIONS,
        'inventory adjustment',
        'reject',
        'pending',
      ),
    ).toBeNull();
    expect(
      findNamedAction(ADJUSTMENT_TRANSITIONS, 'reject')?.requiresReason,
    ).toBe(true);
  });
});

describe('inventory ledger — reconciliation', () => {
  it('reports a projection that matches the ledger as reconciled', () => {
    const rows = reconcileStock(
      [{ productId: 'p1', warehouseId: 'w1', onHand: '7.5', reserved: '2' }],
      [{ productId: 'p1', warehouseId: 'w1', quantity: '7.5' }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productId: 'p1',
      warehouseId: 'w1',
      projected: '7.5',
      ledger: '7.5',
      difference: '0',
      ok: true,
    });
  });

  it('reports a difference rather than correcting it', () => {
    const rows = reconcileStock(
      [{ productId: 'p1', warehouseId: 'w1', onHand: '6', reserved: '0' }],
      [{ productId: 'p1', warehouseId: 'w1', quantity: '7.5' }],
    );
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.difference).toBe('-1.5');
  });

  it('flags a one-sided row on either side', () => {
    const rows = reconcileStock(
      [{ productId: 'p2', warehouseId: 'w1', onHand: '3', reserved: '0' }],
      [{ productId: 'p1', warehouseId: 'w1', quantity: '4' }],
    );
    expect(rows).toHaveLength(2);
    const p1 = rows.find((row) => row.productId === 'p1');
    const p2 = rows.find((row) => row.productId === 'p2');
    // Movements never projected, and a projection with no movement behind it, are both discrepancies.
    expect(p1).toMatchObject({ projected: '0', ledger: '4', ok: false });
    expect(p2).toMatchObject({ projected: '3', ledger: '0', ok: false });
  });

  it('cannot collide two different pairs into one key', () => {
    expect(levelKey('a', 'b:c')).not.toBe(levelKey('a:b', 'c'));
  });
});
