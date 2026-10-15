import { describe, expect, it } from 'vitest';

import { createPdfkitRenderer, pdfAvailable } from './pdf.js';

/**
 * The pdfkit adapter.
 *
 * `pdfkit` is an **optional** dependency, so these tests cover both worlds: where it is installed the
 * renderer must produce a real PDF from blocks, and where it is not the failure must be a clear
 * message rather than a module-resolution stack trace. What is asserted in both worlds is that asking
 * never throws by surprise — `pdfAvailable()` is a question, not an error.
 */
describe('pdfkit availability', () => {
  it('answers whether pdfkit can be loaded, without throwing either way', async () => {
    const result = await pdfAvailable();
    expect(typeof result.available).toBe('boolean');
    if (result.available) {
      expect(result.reason).toBeNull();
    } else {
      expect(typeof result.reason).toBe('string');
      expect((result.reason ?? '').length).toBeGreaterThan(0);
    }
  });
});

describe('pdfkit renderer', () => {
  it('renders a real PDF from the block model when the dependency is installed', async () => {
    const availability = await pdfAvailable();
    if (!availability.available) return; // Optional dependency absent: nothing to assert here.

    const renderer = await createPdfkitRenderer();
    const buffer = await renderer.render(
      [
        { kind: 'heading', text: 'Quote Q-0001' },
        { kind: 'paragraph', text: 'Prepared for Acme.' },
        { kind: 'keyValue', rows: [{ key: 'Total', value: '100.00' }] },
        { kind: 'table', columns: ['Item', 'Qty'], rows: [['Widget', '2']] },
        { kind: 'spacer' },
      ],
      { title: 'Quote Q-0001', producer: 'document-module-test' },
    );

    expect(Buffer.isBuffer(buffer)).toBe(true);
    // Every PDF starts with the `%PDF-` magic; a buffer without it is not a document.
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('refuses with the operator-facing message when the dependency is absent', async () => {
    const availability = await pdfAvailable();
    if (availability.available) return; // Installed: the refusal path cannot run.

    await expect(createPdfkitRenderer()).rejects.toThrow(/optional "pdfkit" dependency/);
  });
});
