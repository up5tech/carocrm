import { describe, expect, it } from 'vitest';

import { blocksToText, type DocumentBlock,tableWidths } from './layout.js';

/**
 * The block model's text rendering.
 *
 * This is the function an email body is built from and the one a renderer test asserts on, so the
 * details that matter are the ones a hand-written join gets wrong: the blank line between blocks, the
 * single trailing newline, and column widths taken from the widest cell rather than the header.
 */
describe('blocksToText', () => {
  it('renders a heading uppercased with an underline at least three long', () => {
    expect(blocksToText([{ kind: 'heading', text: 'Invoice' }])).toBe('INVOICE\n=======\n');
    // A two-letter heading would produce a two-dash underline, so the minimum is three.
    expect(blocksToText([{ kind: 'heading', text: 'Hi' }])).toBe('HI\n===\n');
  });

  it('renders key/value rows one per line', () => {
    const blocks: readonly DocumentBlock[] = [
      {
        kind: 'keyValue',
        rows: [
          { key: 'Number', value: 'INV-0001' },
          { key: 'Total', value: '100.00' },
        ],
      },
    ];
    expect(blocksToText(blocks)).toBe('Number: INV-0001\nTotal: 100.00\n');
  });

  it('renders a table with columns padded to the widest cell and a dashed separator', () => {
    const blocks: readonly DocumentBlock[] = [
      {
        kind: 'table',
        columns: ['Item', 'Qty'],
        rows: [
          ['Widget', '2'],
          ['Sprocket', '10'],
        ],
      },
    ];
    // "Item" is the shortest string in its column, yet the header is padded to "Sprocket"'s width.
    expect(blocksToText(blocks)).toBe('Item      Qty\n--------  ---\nWidget    2\nSprocket  10\n');
  });

  it('renders a row with fewer cells than columns without padding for the missing cells', () => {
    const blocks: readonly DocumentBlock[] = [{ kind: 'table', columns: ['A', 'B'], rows: [['x']] }];
    expect(blocksToText(blocks)).toBe('A  B\n-  -\nx\n');
  });

  it('trims the trailing whitespace of a row whose last cell is empty', () => {
    const blocks: readonly DocumentBlock[] = [{ kind: 'table', columns: ['A', 'B'], rows: [['x', '']] }];
    expect(blocksToText(blocks)).toBe('A  B\n-  -\nx\n');
  });

  it('separates blocks with one blank line and ends with exactly one newline', () => {
    const blocks: readonly DocumentBlock[] = [{ kind: 'paragraph', text: 'Thank you.' }, { kind: 'spacer' }, { kind: 'paragraph', text: 'Goodbye.' }];
    expect(blocksToText(blocks)).toBe('Thank you.\n\n\n\nGoodbye.\n');
  });

  it('renders an empty document as a single newline', () => {
    expect(blocksToText([])).toBe('\n');
  });
});

describe('tableWidths', () => {
  it('takes each column width from the widest entry, header included', () => {
    expect(tableWidths(['Item', 'Qty'], [['Widget', '2'], ['Sprocket', '10']])).toEqual([8, 3]);
  });

  it('falls back to the header length when there are no rows', () => {
    expect(tableWidths(['Column'], [])).toEqual([6]);
  });

  it('returns no widths for a table with no columns', () => {
    expect(tableWidths([], [])).toEqual([]);
  });
});
