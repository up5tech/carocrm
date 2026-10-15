import type { DocumentBlock } from './layout.js';

/**
 * @carocrm/document — the PDF renderer adapter.
 *
 * `pdfkit` is an **optional** dependency: it is declared in `optionalDependencies` and loaded with a
 * dynamic import, so the API process, the worker and the test suite all work without it. Installing it
 * (or nothing at all) is an operator's choice, and the rest of this package does not care.
 *
 * That is deliberate. A PDF renderer is exactly the kind of heavy, environment-shaped dependency a
 * kernel should not require: it pulls in font data, it costs memory per document, and it is only needed
 * for the "attach a PDF" path, never for "send the document".
 *
 * The renderer walks the block model — it does not interpret HTML, because there is no CSS engine here
 * and an HTML-in-name-only renderer would quietly produce wrong documents.
 */

export interface DocumentPdfOptions {
  /** Shown in the PDF's document properties; empty means "the module is rendering an untitled block". */
  readonly title?: string | undefined;
  /** Producer name recorded in the PDF metadata. */
  readonly producer?: string | undefined;
}

export interface DocumentPdfRenderer {
  render(blocks: readonly DocumentBlock[], options?: DocumentPdfOptions): Promise<Buffer>;
}

export interface PdfAvailableResult {
  readonly available: boolean;
  readonly reason: string | null;
}

/** Whether pdfkit can be loaded here. Never throws: an absent optional dependency is not an error. */
export async function pdfAvailable(): Promise<PdfAvailableResult> {
  try {
    await import('pdfkit');
    return { available: true, reason: null };
  } catch (error: unknown) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'pdfkit could not be loaded.',
    };
  }
}

/**
 * Build the pdfkit-backed renderer. Rejects with a clear message when the optional dependency is not
 * installed, so the caller can fall back to "send it as a document without a PDF attachment" instead of
 * failing the whole send.
 */
export async function createPdfkitRenderer(): Promise<DocumentPdfRenderer> {
  const module: unknown = await import('pdfkit').catch((error: unknown) => {
    throw new Error(
      'PDF rendering needs the optional "pdfkit" dependency. Install it (pnpm add pdfkit -F @carocrm/document) or send the document without a PDF attachment.',
      { cause: error },
    );
  });
  const pdfkit = module as { default?: unknown };
  const PDFDocument = (pdfkit.default ?? module) as new (options: Record<string, unknown>) => PdfDocument;

  return {
    async render(blocks, options = {}) {
      return await new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({ autoFirstPage: true, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        if (options.title !== undefined) doc.info.Title = options.title;
        doc.info.Producer = options.producer ?? 'CaroCRM document module';

        try {
          for (const block of blocks) {
            switch (block.kind) {
              case 'heading':
                doc.fontSize(16).text(block.text).moveDown();
                break;
              case 'paragraph':
                doc.fontSize(10).text(block.text).moveDown();
                break;
              case 'keyValue':
                for (const row of block.rows) doc.fontSize(10).text(`${row.key}: ${row.value}`);
                doc.moveDown();
                break;
              case 'table':
                drawTable(doc, block.columns, block.rows);
                break;
              case 'spacer':
                doc.moveDown();
                break;
              default: {
                const exhaustive: never = block;
                reject(new Error(`Unknown document block "${String((exhaustive as { kind?: unknown }).kind)}".`));
                return;
              }
            }
          }
          doc.end();
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}

/** Minimal table drawing: enough for line items and totals, and no layout engine to argue with. */
interface PdfDocument {
  fontSize(points: number): PdfDocument;
  font(value: string): PdfDocument;
  text(value: string, options?: Record<string, unknown>): PdfDocument;
  moveDown(lines?: number): PdfDocument;
  info: Record<string, unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  end(): void;
}

function drawTable(doc: PdfDocument, columns: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => (row[index] ?? '').length), 0),
  );
  const left = 40;
  const top = (doc as unknown as { y: number }).y;
  const rowHeight = 16;
  doc.font('Helvetica-Bold').fontSize(9);
  columns.forEach((column, index) => {
    doc.text(column, left + widths.slice(0, index).reduce((total, width) => total + width * 6, 0), top);
  });
  doc.font('Helvetica').fontSize(9);
  rows.forEach((row, rowIndex) => {
    const rowTop = top + rowHeight * (rowIndex + 1);
    row.forEach((cell, columnIndex) => {
      doc.text(cell, left + widths.slice(0, columnIndex).reduce((total, width) => total + width * 6, 0), rowTop);
    });
  });
  doc.moveDown(rows.length + 2);
}
