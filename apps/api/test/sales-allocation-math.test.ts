import { describe, expect, it } from 'vitest';

import {
  assertAllocatable,
  assertCreditAllocatable,
  assertDirectionAllows,
  assertSameCurrency,
  assertWriteOffAmount,
  creditNoteOutstanding,
  documentOutstanding,
  invoicePaymentStatus,
  paymentBalance,
} from '../src/sales/payments/allocation-math.js';

/**
 * Phase 19-S.10 — the four rules the phase is judged on, without a database, a gateway or a clock.
 *
 * Over-allocation, negative balances, cross-currency allocation and derived payment status are all
 * decided here, so they are all testable here. The integration suite then only has to prove that the
 * service actually calls this.
 */
describe('paymentBalance', () => {
  it('reports what is still available to allocate', () => {
    expect(paymentBalance('100.00', ['30.00'])).toEqual({
      amount: '100.00',
      allocated: '30.00',
      unallocated: '70.00',
      status: 'partiallyAllocated',
    });
  });

  it('distinguishes untouched from fully applied', () => {
    expect(paymentBalance('100.00', []).status).toBe('unallocated');
    expect(paymentBalance('100.00', []).unallocated).toBe('100.00');
    expect(paymentBalance('100.00', ['60.00', '40.00']).status).toBe('allocated');
    expect(paymentBalance('100.00', ['60.00', '40.00']).unallocated).toBe('0.00');
  });

  it('refuses allocations that exceed the payment itself', () => {
    // An over-allocated payment is not a state this module represents; an overpayment is an unapplied
    // amount on the payment instead.
    expect(() => paymentBalance('100.00', ['120.00'])).toThrow(/exceed the payment amount/);
  });

  it('refuses a negative allocation or a negative amount', () => {
    expect(() => paymentBalance('-1.00', [])).toThrow(/must not be negative/);
    expect(() => paymentBalance('100.00', ['-5.00'])).toThrow(/must not be negative/);
  });
});

describe('documentOutstanding', () => {
  it('subtracts payments, credits and write-offs from the payable total', () => {
    expect(documentOutstanding('100.00', ['40.00'])).toBe('60.00');
    expect(documentOutstanding('100.00', ['40.00'], ['10.00'])).toBe('50.00');
    expect(documentOutstanding('100.00', ['40.00'], ['10.00'], ['50.00'])).toBe('0.00');
  });

  it('never goes negative — an over-settled document owes nothing', () => {
    expect(documentOutstanding('100.00', ['80.00'], ['30.00'])).toBe('0.00');
  });

  it('treats a document with nothing against it as fully outstanding', () => {
    expect(documentOutstanding('250.50', [])).toBe('250.50');
  });
});

describe('assertAllocatable', () => {
  const base = { amount: '10.00', paymentRemaining: '100.00', documentRemaining: '100.00', paymentId: 'p1', documentId: 'd1' };

  it('allows an allocation that fits both sides', () => {
    expect(() => assertAllocatable(base)).not.toThrow();
    expect(() => assertAllocatable({ ...base, amount: '100.00' })).not.toThrow();
  });

  it('refuses an allocation larger than the payment has left, naming the remainder', () => {
    expect(() => assertAllocatable({ ...base, paymentRemaining: '5.00' })).toThrow(/still unallocated on payment "p1"/);
  });

  it('refuses an allocation larger than the document owes, naming the remainder', () => {
    expect(() => assertAllocatable({ ...base, documentRemaining: '5.00' })).toThrow(/still outstanding on "d1"/);
  });

  it('refuses a zero or negative allocation', () => {
    expect(() => assertAllocatable({ ...base, amount: '0.00' })).toThrow(/greater than zero/);
    expect(() => assertAllocatable({ ...base, amount: '-1.00' })).toThrow(/greater than zero/);
  });
});

describe('assertSameCurrency', () => {
  it('allows a same-currency allocation', () => {
    expect(() =>
      assertSameCurrency({ paymentCurrency: 'USD', documentCurrency: 'USD', allocationCurrency: 'USD', hasConversion: false }),
    ).not.toThrow();
  });

  it('refuses an allocation whose currency is not the payment currency', () => {
    expect(() =>
      assertSameCurrency({ paymentCurrency: 'USD', documentCurrency: 'USD', allocationCurrency: 'EUR', hasConversion: true }),
    ).toThrow(/cannot carry an allocation in EUR/);
  });

  it('needs an exchange-rate snapshot before crossing currencies', () => {
    expect(() =>
      assertSameCurrency({ paymentCurrency: 'USD', documentCurrency: 'EUR', allocationCurrency: 'USD', hasConversion: false }),
    ).toThrow(/exchange-rate snapshot/);
    expect(() =>
      assertSameCurrency({ paymentCurrency: 'USD', documentCurrency: 'EUR', allocationCurrency: 'USD', hasConversion: true }),
    ).not.toThrow();
  });
});

describe('invoicePaymentStatus', () => {
  const today = '2026-10-15';

  it('is `paid` only when nothing is outstanding', () => {
    expect(invoicePaymentStatus({ grossTotal: '100.00', amountDue: '0.00', dueDate: '2026-10-01', today })).toBe('paid');
  });

  it('is `overdue` once the due date has passed with something outstanding', () => {
    expect(invoicePaymentStatus({ grossTotal: '100.00', amountDue: '60.00', dueDate: '2026-10-14', today })).toBe('overdue');
    // Not late on the day it falls due.
    expect(invoicePaymentStatus({ grossTotal: '100.00', amountDue: '60.00', dueDate: '2026-10-15', today })).toBe('partiallyPaid');
  });

  it('is `partiallyPaid` or `unpaid` while the due date has not passed', () => {
    expect(invoicePaymentStatus({ grossTotal: '100.00', amountDue: '60.00', dueDate: '2026-11-01', today })).toBe('partiallyPaid');
    expect(invoicePaymentStatus({ grossTotal: '100.00', amountDue: '100.00', dueDate: '2026-11-01', today })).toBe('unpaid');
    expect(invoicePaymentStatus({ grossTotal: '100.00', amountDue: '100.00', dueDate: null, today })).toBe('unpaid');
  });
});

describe('assertDirectionAllows', () => {
  it('settles a bill with an outgoing payment and an invoice with an incoming one (19-S.13)', () => {
    expect(() => assertDirectionAllows('incoming', 'Invoice')).not.toThrow();
    expect(() => assertDirectionAllows('outgoing', 'Bill')).not.toThrow();
  });

  it('refuses a document type the direction does not settle', () => {
    // The two halves of the ledger stay separate: a customer payment never settles a supplier bill
    // and a supplier payment never settles a customer invoice (§4.12).
    expect(() => assertDirectionAllows('incoming', 'Bill')).toThrow(/is not one of them/);
    expect(() => assertDirectionAllows('outgoing', 'Invoice')).toThrow(/is not one of them/);
  });
});

describe('creditNoteOutstanding (19-S.11)', () => {
  it('is the credit total minus its live allocations', () => {
    expect(creditNoteOutstanding('40.00', [])).toBe('40.00');
    expect(creditNoteOutstanding('40.00', ['15.00', '5.00'])).toBe('20.00');
    expect(creditNoteOutstanding('40.00', ['40.00'])).toBe('0.00');
  });

  it('never goes negative — an over-allocated credit note reads as fully used', () => {
    expect(creditNoteOutstanding('40.00', ['30.00', '30.00'])).toBe('0.00');
  });

  it('refuses a negative allocation amount', () => {
    expect(() => creditNoteOutstanding('40.00', ['-1.00'])).toThrow(/must not be negative/);
  });
});

describe('assertCreditAllocatable (19-S.11, 19-S.13)', () => {
  it('accepts an amount within both remainders', () => {
    expect(() =>
      assertCreditAllocatable({ amount: '30.00', creditRemaining: '40.00', documentRemaining: '70.00', creditId: 'cn1', documentId: 'inv1' }),
    ).not.toThrow();
  });

  it('refuses an amount beyond the credit note, naming the credit note (not a payment)', () => {
    expect(() =>
      assertCreditAllocatable({ amount: '50.00', creditRemaining: '40.00', documentRemaining: '70.00', creditId: 'cn1', documentId: 'inv1' }),
    ).toThrow(/still unallocated on credit note "cn1"/);
  });

  it('refuses an amount beyond what the invoice still owes', () => {
    expect(() =>
      assertCreditAllocatable({ amount: '80.00', creditRemaining: '100.00', documentRemaining: '70.00', creditId: 'cn1', documentId: 'inv1' }),
    ).toThrow(/still outstanding on invoice "inv1"/);
  });

  it('says "bill credit" and "bill" when that is the credit being applied (§4.12)', () => {
    expect(() =>
      assertCreditAllocatable({
        amount: '80.00',
        creditRemaining: '100.00',
        documentRemaining: '70.00',
        creditId: 'bc1',
        documentId: 'bill1',
        creditNoun: 'bill credit',
        documentNoun: 'bill',
      }),
    ).toThrow(/still outstanding on bill "bill1"/);
  });
});

describe('assertWriteOffAmount (19-S.11)', () => {
  it('accepts a positive amount within what the invoice still owes', () => {
    expect(() =>
      assertWriteOffAmount({ amount: '25.00', documentRemaining: '100.00', documentId: 'inv1' }),
    ).not.toThrow();
    expect(() =>
      assertWriteOffAmount({ amount: '100.00', documentRemaining: '100.00', documentId: 'inv1' }),
    ).not.toThrow();
  });

  it('refuses an amount beyond the remaining balance, naming it', () => {
    expect(() =>
      assertWriteOffAmount({ amount: '150.00', documentRemaining: '100.00', documentId: 'inv1' }),
    ).toThrow(/exceeds the 100\.00 still outstanding/);
  });

  it('refuses zero and negative amounts', () => {
    expect(() =>
      assertWriteOffAmount({ amount: '0.00', documentRemaining: '100.00', documentId: 'inv1' }),
    ).toThrow(/must be greater than zero/);
    expect(() =>
      assertWriteOffAmount({ amount: '-5.00', documentRemaining: '100.00', documentId: 'inv1' }),
    ).toThrow(/must be greater than zero/);
  });
});
