import { describe, expect, it } from 'vitest';

import { fulfilmentSummary, fulfilmentTransitionRefusal } from '../src/sales/document/fulfilment.js';

/**
 * Phase 19-S.8 — the fulfilment state is derived, and these are the derivations.
 *
 * The point of the module is that "partially fulfilled" cannot be typed by an operator, so the cases
 * that matter are the boundaries: nothing moved, everything moved, and a delivery that moved more than
 * was ordered (which is a data error, not "more fulfilled").
 */
describe('fulfilmentSummary', () => {
  it('reports `confirmed` while nothing has moved', () => {
    const summary = fulfilmentSummary([
      { orderedQuantity: '10.00', movedQuantities: [] },
      { orderedQuantity: '2.00', movedQuantities: [] },
    ]);
    expect(summary.state).toBe('confirmed');
    expect(summary.fullyMovedLines).toBe(0);
    expect(summary.totalLines).toBe(2);
    expect(summary.lines.map((line) => line.remaining)).toEqual(['10.00', '2.00']);
  });

  it('reports `partiallyFulfilled` as soon as one line has moved but not all', () => {
    const summary = fulfilmentSummary([
      { orderedQuantity: '10.00', movedQuantities: ['4.00'] },
      { orderedQuantity: '2.00', movedQuantities: [] },
    ]);
    expect(summary.state).toBe('partiallyFulfilled');
    expect(summary.fullyMovedLines).toBe(0);
    expect(summary.lines[0]?.moved).toBe('4.00');
  });

  it('reports `partiallyFulfilled` when one line is done and another is not', () => {
    const summary = fulfilmentSummary([
      { orderedQuantity: '10.00', movedQuantities: ['10.00'] },
      { orderedQuantity: '2.00', movedQuantities: ['1.00'] },
    ]);
    expect(summary.state).toBe('partiallyFulfilled');
    expect(summary.fullyMovedLines).toBe(1);
    expect(summary.lines[0]?.remaining).toBeNull();
    expect(summary.lines[1]?.remaining).toBe('1.00');
  });

  it('reports `fulfilled` only when every line is fully moved', () => {
    const summary = fulfilmentSummary([
      { orderedQuantity: '10.00', movedQuantities: ['6.00', '4.00'] },
      { orderedQuantity: '2.00', movedQuantities: ['2.00'] },
    ]);
    expect(summary.state).toBe('fulfilled');
    expect(summary.fullyMovedLines).toBe(2);
    expect(summary.lines.every((line) => line.remaining === null)).toBe(true);
  });

  it('refuses a line moved beyond its ordered quantity rather than clamping it', () => {
    // Clamping would hide a delivery that shipped the wrong quantity.
    expect(() => fulfilmentSummary([{ orderedQuantity: '10.00', movedQuantities: ['10.00', '1.00'] }]))
      .toThrow(/moved 11.00 against an ordered quantity of 10.00/);
  });

  it('refuses an order with no lines, which has no fulfilment state', () => {
    expect(() => fulfilmentSummary([])).toThrow(/no lines/);
  });
});

describe('fulfilmentTransitionRefusal', () => {
  it('allows the forward transitions and a no-op', () => {
    expect(fulfilmentTransitionRefusal('confirmed', 'confirmed')).toBeNull();
    expect(fulfilmentTransitionRefusal('confirmed', 'partiallyFulfilled')).toBeNull();
    expect(fulfilmentTransitionRefusal('confirmed', 'fulfilled')).toBeNull();
    expect(fulfilmentTransitionRefusal('partiallyFulfilled', 'fulfilled')).toBeNull();
  });

  it('never un-fulfils an order — a return is a new document', () => {
    expect(fulfilmentTransitionRefusal('fulfilled', 'partiallyFulfilled')).toMatch(/return order/);
  });

  it('refuses fulfilment before confirmation and after cancellation', () => {
    expect(fulfilmentTransitionRefusal('draft', 'fulfilled')).toMatch(/must be confirmed/);
    expect(fulfilmentTransitionRefusal('cancelled', 'fulfilled')).toMatch(/cancelled order/);
  });
});
