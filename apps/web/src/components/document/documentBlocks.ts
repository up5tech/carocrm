/**
 * Blocks for the document designer.
 *
 * A document is printed and mailed, so the layout is table-based and the styles are plain CSS that
 * survives both an HTML mail and a PDF print. The blocks carry real document tokens, which means a
 * dropped block already shows where the number, the party and the line items go instead of being an
 * empty placeholder the author has to fill by hand.
 *
 * `{{#each lines}}` has to stay in the markup: the renderer repeats everything between the two
 * markers once per line. The markers live in hidden rows so the designer can still edit the visible
 * line row, and the exported body keeps the loop intact for the server.
 */
import type { ComponentDefinitionDefined } from 'grapesjs';

import type { VisualBlockSpec } from '../email/EmailVisualEditor.js';

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
const INK = '#31373d';
const MUTED = '#737b85';
const BORDER = '#e6ebf1';

const TABLE_ATTRIBUTES = { width: '100%', cellpadding: '0', cellspacing: '0', border: '0', role: 'presentation' } as const;
const TABLE_STYLE = { width: '100%', 'border-collapse': 'collapse', 'font-family': FONT, 'font-size': '13px' } as const;

function text(content: string, style: Record<string, string> = {}): ComponentDefinitionDefined {
  return {
    type: 'text',
    content,
    style: { 'font-family': FONT, 'font-size': '13px', color: INK, 'line-height': '1.6', margin: '0 0 10px', ...style },
  };
}

function cell(
  content: string,
  style: Record<string, string> = {},
  attributes: Record<string, string> = {},
): ComponentDefinitionDefined {
  // Colour and weight belong on the text component: GrapesJS keeps the cell's style on the
  // `<td>`, but the text child already declares its own, so inheritance would not reach it.
  const { color, 'font-weight': fontWeight, ...cellStyle } = style;
  return {
    tagName: 'td',
    attributes: { valign: 'top', ...attributes },
    style: { padding: '8px 10px', border: `1px solid ${BORDER}`, ...cellStyle },
    components: [
      text(content, {
        margin: '0',
        'font-size': '12.5px',
        ...(color === undefined ? {} : { color }),
        ...(fontWeight === undefined ? {} : { 'font-weight': fontWeight }),
      }),
    ],
  };
}

function row(cells: ComponentDefinitionDefined[], header = false): ComponentDefinitionDefined {
  return {
    tagName: 'tr',
    components: header
      ? cells.map((entry) => ({ ...entry, style: { ...(entry.style ?? {}), background: '#f7f9fb' } }))
      : cells,
  };
}

function table(rows: ComponentDefinitionDefined[]): ComponentDefinitionDefined {
  return {
    tagName: 'table',
    attributes: { ...TABLE_ATTRIBUTES },
    style: { ...TABLE_STYLE, margin: '0 0 14px' },
    components: [{ tagName: 'tbody', components: rows }],
  };
}

/** A loop marker row: present in the markup, invisible on the canvas and in the printed page. */
function eachMarker(marker: string): ComponentDefinitionDefined {
  return {
    tagName: 'tr',
    attributes: { 'data-carocrm-loop': marker },
    style: { display: 'none' },
    components: [
      {
        tagName: 'td',
        attributes: { colspan: '5' },
        style: { display: 'none', padding: '0', border: '0', 'font-size': '0', 'line-height': '0' },
        components: [{ type: 'text', content: marker }],
      },
    ],
  };
}

const icon = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const DOCUMENT_BLOCKS: VisualBlockSpec[] = [
  {
    id: 'dtpl-heading',
    labelKey: 'heading',
    media: icon('<path d="M6 5v14M18 5v14M6 12h12"/>'),
    content: text('Invoice {{number}}', { 'font-size': '22px', 'font-weight': '700', margin: '0 0 4px' }),
  },
  {
    id: 'dtpl-meta',
    labelKey: 'meta',
    media: icon('<path d="M4 7h16M4 12h16M4 17h10"/>'),
    content: table([
      row([
        cell('Date', { color: MUTED, width: '22%' }),
        cell('{{date}}', { 'font-weight': '600' }),
        cell('Status', { color: MUTED, width: '22%' }),
        cell('{{status}}', { 'font-weight': '600' }),
      ]),
      row([
        cell('Account', { color: MUTED }),
        cell('{{accountName}}'),
        cell('Contact', { color: MUTED }),
        cell('{{contactName}}'),
      ]),
    ]),
  },
  {
    id: 'dtpl-text',
    labelKey: 'text',
    media: icon('<path d="M4 6h16M4 10h16M4 14h10"/>'),
    content: text('Write the cover text here. Tokens such as {{accountName}} and {{number}} resolve when the document is rendered.'),
  },
  {
    id: 'dtpl-parties',
    labelKey: 'parties',
    media: icon('<circle cx="12" cy="8" r="3"/><path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/>'),
    content: table([
      row([
        cell('Billing address', { color: MUTED, width: '50%' }),
        cell('Shipping address', { color: MUTED }),
      ], true),
      row([cell('{{billingAddress}}'), cell('{{shippingAddress}}')]),
    ]),
  },
  {
    id: 'dtpl-lines',
    labelKey: 'lines',
    media: icon('<rect x="3" y="5" width="18" height="14" rx="1"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="10" y1="5" x2="10" y2="19"/>'),
    content: table([
      row(
        [
          cell('Product', { width: '34%' }),
          cell('SKU', { width: '16%' }),
          cell('Quantity', { width: '12%' }),
          cell('Unit price', { width: '18%' }),
          cell('Line total', { width: '20%' }),
        ],
        true,
      ),
      eachMarker('{{#each lines}}'),
      row([cell('{{name}}'), cell('{{sku}}'), cell('{{quantity}}'), cell('{{unitPrice}}'), cell('{{lineTotal}}')]),
      eachMarker('{{/each}}'),
    ]),
  },
  {
    id: 'dtpl-totals',
    labelKey: 'totals',
    media: icon('<path d="M5 5h14v14H5zM9 9h6M9 13h6M9 17h3"/>'),
    content: table([
      row([cell('Subtotal', { color: MUTED, width: '70%' }), cell('{{totals.subtotal}} {{currency}}')]),
      row([cell('Discount', { color: MUTED }), cell('{{totals.discountTotal}} {{currency}}')]),
      row([cell('Shipping', { color: MUTED }), cell('{{totals.shippingAmount}} {{currency}}')]),
      row([cell('Tax', { color: MUTED }), cell('{{totals.taxTotal}} {{currency}}')]),
      row([
        cell('Gross total', { 'font-weight': '700' }),
        cell('{{totals.grossTotal}} {{currency}}', { 'font-weight': '700' }),
      ]),
    ]),
  },
  {
    id: 'dtpl-notes',
    labelKey: 'notes',
    media: icon('<path d="M6 4h12v16l-6-4-6 4z"/>'),
    content: text('Notes: {{description}}', { 'font-size': '12.5px', color: MUTED }),
  },
  {
    id: 'dtpl-divider',
    labelKey: 'divider',
    media: icon('<line x1="3" y1="12" x2="21" y2="12"/>'),
    content: {
      tagName: 'table',
      attributes: { ...TABLE_ATTRIBUTES },
      style: { ...TABLE_STYLE, margin: '0 0 14px' },
      components: [
        {
          tagName: 'tbody',
          components: [
            {
              tagName: 'tr',
              components: [
                {
                  tagName: 'td',
                  style: { 'border-top': `1px solid ${BORDER}`, 'font-size': '0', 'line-height': '0', padding: '0' },
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: 'dtpl-spacer',
    labelKey: 'spacer',
    media: icon('<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>'),
    content: {
      tagName: 'table',
      attributes: { ...TABLE_ATTRIBUTES },
      style: TABLE_STYLE,
      components: [
        {
          tagName: 'tbody',
          components: [
            {
              tagName: 'tr',
              components: [
                {
                  tagName: 'td',
                  style: { height: '18px', 'font-size': '0', 'line-height': '0', padding: '0' },
                },
              ],
            },
          ],
        },
      ],
    },
  },
];
