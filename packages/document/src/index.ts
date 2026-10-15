/**
 * @carocrm/document — turning a record into a document.
 *
 * One kernel-owned way to render a template and to lay the result out, so no module invents its own
 * template syntax or its own notion of "a line item table". The commercial modules (Sales quotes,
 * orders and invoices today; Purchases and Inventory later) build blocks from their own **frozen
 * snapshot** and hand them here — which is also why this package has no database, no NestJS and no
 * knowledge of any entity: it is the part both the API process and the worker can share.
 *
 * Rendering a document is not the same as sending it. Sending is the mail module's job; this package
 * produces what gets sent.
 */

export {
  TEMPLATE_MAX_EACH_DEPTH,
  TEMPLATE_MAX_EACH_ITEMS,
  TEMPLATE_MAX_LENGTH,
  escapeHtml,
  renderTemplate,
  type TemplateData,
  type TemplateRenderOptions,
  type TemplateRenderResult,
} from './template.js';
export { blocksToText, tableWidths, type DocumentBlock } from './layout.js';
export {
  createPdfkitRenderer,
  pdfAvailable,
  type DocumentPdfOptions,
  type DocumentPdfRenderer,
  type PdfAvailableResult,
} from './pdf.js';
