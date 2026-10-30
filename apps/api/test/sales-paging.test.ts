import { describe, expect, it } from 'vitest';

import { decodePageCursor, encodePageCursor } from '../src/sales/paging.js';

/**
 * The page cursor — the token a reader carries from one page to the next.
 *
 * It is opaque to the caller, so the only things worth pinning are that a cursor this module wrote
 * comes back exactly as it went out, and that a token it did not write is refused rather than
 * quietly treated as "the first page": a reader that mangles its cursor must be told, not handed a
 * page it believes it has already read.
 */

describe('the page cursor', () => {
  it('round-trips the position of the last row of a page', () => {
    const cursor = {
      createdAt: '2026-10-30T09:00:00.123456Z',
      id: '0f4c1a2e-7c3a-4b1e-9f0a-5d2b8c6e1a11',
    };
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor);
  });

  it('is a token, not a query a caller may assemble', () => {
    const encoded = encodePageCursor({
      createdAt: '2026-10-30T09:00:00.123456Z',
      id: 'row-1',
    });
    expect(encoded).not.toContain('|');
    expect(encoded).not.toContain('2026-10-30');
  });

  it('refuses a token it did not issue', () => {
    expect(() => decodePageCursor('not-a-cursor')).toThrow(/cursor/i);
    expect(() => decodePageCursor('')).toThrow(/cursor/i);
    expect(() =>
      decodePageCursor(
        Buffer.from('2026-10-30T09:00:00.123456Z', 'utf8').toString('base64url'),
      ),
    ).toThrow(/cursor/i);
  });

  it('refuses a moment that does not exist', () => {
    const encoded = Buffer.from('2026-02-30T00:00:00.000000Z|row-1', 'utf8').toString(
      'base64url',
    );
    expect(() => decodePageCursor(encoded)).toThrow(/cursor/i);
  });

  it('keeps the microseconds, which is what makes the boundary exact', () => {
    const cursor = {
      createdAt: '2026-10-30T09:00:00.000001Z',
      id: 'row-1',
    };
    expect(decodePageCursor(encodePageCursor(cursor)).createdAt).toBe(
      '2026-10-30T09:00:00.000001Z',
    );
  });
});
