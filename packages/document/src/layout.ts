/**
 * @carocrm/document — the layout model a rendered document is built from.
 *
 * A block model rather than raw HTML is a deliberate trade-off. HTML needs a browser to become PDF,
 * and this repository has no Chromium in either the API or the worker, so a PDF renderer would have to
 * be a second thing to install and run. A block model is:
 *
 *  - renderable to plain text with no dependency at all, which is what email needs;
 *  - renderable to PDF by a renderer that walks blocks and places them — no CSS engine, no browser;
 *  - testable: the text rendering is a pure function, so a template's output can be asserted on
 *    without producing a binary.
 *
 * The kernel stays deliberately generic — it knows about headings, paragraphs, key/value pairs and
 * tables, and nothing about quotes or invoices. What a commercial document contains is decided by the
 * module that owns it, from its own frozen snapshot.
 */

export type DocumentBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'keyValue'; readonly rows: readonly { readonly key: string; readonly value: string }[] }
  | { readonly kind: 'table'; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'spacer' };

/** A plain-text rendering, suitable as an email body and stable enough to assert on. */
export function blocksToText(blocks: readonly DocumentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        parts.push(block.text.toUpperCase(), '='.repeat(Math.max(3, block.text.length)));
        break;
      case 'paragraph':
        parts.push(block.text);
        break;
      case 'keyValue':
        parts.push(...block.rows.map((row) => `${row.key}: ${row.value}`));
        break;
      case 'table': {
        const widths = block.columns.map((column, index) =>
          Math.max(column.length, ...block.rows.map((row) => (row[index] ?? '').length), 0),
        );
        parts.push(rowToString(block.columns, widths));
        parts.push(widths.map((width) => '-'.repeat(width)).join('  '));
        for (const row of block.rows) parts.push(rowToString(row, widths));
        break;
      }
      case 'spacer':
        parts.push('');
        break;
      default: {
        const exhaustive: never = block;
        throw new Error(`Unknown document block "${String((exhaustive as { kind?: unknown }).kind)}".`);
      }
    }
    parts.push('');
  }
  return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

function rowToString(row: readonly string[], widths: readonly number[]): string {
  return row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ').replace(/\s+$/, '');
}

/**
 * The column widths a table would use, so a renderer and a test can agree on shape without producing
 * a binary. Exported because "what did this table look like" is exactly the question a document
 * renderer test asks.
 */
export function tableWidths(columns: readonly string[], rows: readonly (readonly string[])[]): readonly number[] {
  return columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => (row[index] ?? '').length), 0),
  );
}
