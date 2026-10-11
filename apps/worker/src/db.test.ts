import { describe, expect, it } from 'vitest';

import {
  asRecord,
  errorMessage,
  isRecord,
  rowDate,
  rowNumber,
  rowRecord,
  rowString,
  truncate,
} from './db.js';

describe('row helpers', () => {
  it('reads typed values out of untyped rows', () => {
    const row = {
      id: 'abc',
      attempts: 3,
      total: '7',
      created_at: new Date('2026-01-02T03:04:05.000Z'),
      iso: '2026-01-02T03:04:05.000Z',
      payload: { a: 1 },
      json: '{"b":2}',
      enabled: true,
      nothing: null,
    };

    expect(rowString(row, 'id')).toBe('abc');
    expect(rowNumber(row, 'attempts')).toBe(3);
    expect(rowNumber(row, 'total')).toBe(7);
    expect(rowDate(row, 'created_at')?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(rowDate(row, 'iso')?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(rowDate(row, 'nothing')).toBeNull();
    expect(rowRecord(row, 'payload')).toEqual({ a: 1 });
    expect(rowRecord(row, 'json')).toEqual({ b: 2 });
    expect(rowRecord(row, 'nothing')).toEqual({});
    expect(rowRecord(row, 'missing')).toEqual({});
  });

  it('throws a readable error when a required column is missing', () => {
    expect(() => rowString({ id: 1 }, 'missing')).toThrow('Column "missing" is missing');
    expect(() => rowNumber({ x: 'y' }, 'x')).toThrow('Column "x" is not a number');
  });

  it('coerces unknown values into records', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord('nope')).toEqual({});
  });

  it('normalises errors and long messages', () => {
    expect(errorMessage(new Error('boom'))).toContain('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(truncate('abc', 2000)).toBe('abc');
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
});
