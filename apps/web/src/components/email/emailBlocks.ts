/**
 * Email blocks for the visual designer.
 *
 * Every block is a table-based structure, because that is what survives Outlook's Word
 * rendering engine: no flexbox, no grid, no floats, `role="presentation"` on layout tables.
 * Styles are declared on the component definitions (GrapesJS turns them into canvas rules
 * while editing); `inlineEmailCss` folds them back into `style` attributes on export, which
 * is the form the template record stores.
 *
 * Icons are inline SVGs so the palette needs no network and no asset storage.
 */
import type { ComponentDefinitionDefined } from 'grapesjs';

export interface EmailBlockSpec {
  /** Stable id; also the grapesjs block id. */
  id: string;
  /** i18n key under `web.emailTemplate.blocks`. */
  labelKey: string;
  /** Inline SVG markup for the palette tile. */
  media: string;
  /** The component definition dropped onto the canvas. */
  content: ComponentDefinitionDefined;
}

/** Attributes every layout table carries; they are what email clients read, not CSS. */
const TABLE_ATTRIBUTES = { width: '100%', cellpadding: '0', cellspacing: '0', border: '0', role: 'presentation' } as const;

const TABLE_STYLE = { width: '100%', 'border-collapse': 'collapse' } as const;

/** A neutral placeholder image (inline SVG data URI) — never a network request. */
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='560' height='180'><rect width='100%' height='100%' fill='%23f5f5f5'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='%23a1a8b3' font-family='sans-serif' font-size='14'>560 &#215; 180</text></svg>";

function section(columns: 1 | 2 | 3): ComponentDefinitionDefined {
  const width = columns === 1 ? '100%' : `${Math.floor(100 / columns)}%`;
  return {
    tagName: 'table',
    attributes: { ...TABLE_ATTRIBUTES },
    style: { ...TABLE_STYLE },
    components: [
      {
        tagName: 'tr',
        components: Array.from({ length: columns }, () => ({
          tagName: 'td',
          attributes: { width, valign: 'top' },
          style: { padding: '12px' },
          components: [{ type: 'text', content: '' }],
        })),
      },
    ],
  };
}

function bar(inner: ComponentDefinitionDefined, style: Record<string, string>): ComponentDefinitionDefined {
  return {
    tagName: 'table',
    attributes: { ...TABLE_ATTRIBUTES },
    style: { ...TABLE_STYLE },
    components: [{ tagName: 'tr', components: [{ tagName: 'td', style, components: [inner] }] }],
  };
}

const icon = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const EMAIL_BLOCKS: EmailBlockSpec[] = [
  {
    id: 'etpl-section-1',
    labelKey: 'section1',
    media: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    content: section(1),
  },
  {
    id: 'etpl-section-2',
    labelKey: 'section2',
    media: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="12" y1="5" x2="12" y2="19"/>'),
    content: section(2),
  },
  {
    id: 'etpl-section-3',
    labelKey: 'section3',
    media: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="9.5" y1="5" x2="9.5" y2="19"/><line x1="14.5" y1="5" x2="14.5" y2="19"/>'),
    content: section(3),
  },
  {
    id: 'etpl-text',
    labelKey: 'text',
    media: icon('<path d="M4 6h16M4 10h16M4 14h10"/>'),
    content: {
      type: 'text',
      content: 'Write your message here. Double-click to edit this text.',
      style: { 'font-size': '14px', 'line-height': '1.6', color: '#31373d', margin: '0 0 12px' },
    },
  },
  {
    id: 'etpl-heading',
    labelKey: 'heading',
    media: icon('<path d="M6 5v14M18 5v14M6 12h12"/>'),
    content: {
      type: 'text',
      content: 'Section heading',
      style: { 'font-size': '20px', 'font-weight': '700', color: '#31373d', margin: '0 0 8px' },
    },
  },
  {
    id: 'etpl-button',
    labelKey: 'button',
    media: icon('<rect x="3" y="8" width="18" height="8" rx="4"/>'),
    content: {
      tagName: 'table',
      attributes: { ...TABLE_ATTRIBUTES },
      style: { ...TABLE_STYLE },
      components: [
        {
          tagName: 'tr',
          components: [
            {
              tagName: 'td',
              attributes: { align: 'center' },
              style: { 'border-radius': '6px', background: '#438eff' },
              components: [
                {
                  tagName: 'a',
                  attributes: { href: '#', target: '_blank' },
                  style: {
                    display: 'inline-block',
                    padding: '12px 28px',
                    color: '#ffffff',
                    'font-size': '14px',
                    'font-weight': '600',
                    'text-decoration': 'none',
                  },
                  components: [{ type: 'text', content: 'Click me' }],
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: 'etpl-image',
    labelKey: 'image',
    media: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M5 17l5-5 4 4 3-3 3 3"/>'),
    content: {
      tagName: 'img',
      attributes: { src: PLACEHOLDER_IMAGE, alt: '', width: '560' },
      style: { display: 'block', width: '100%', 'max-width': '560px', height: 'auto' },
      traits: ['src', 'alt', 'title'],
    },
  },
  {
    id: 'etpl-divider',
    labelKey: 'divider',
    media: icon('<line x1="3" y1="12" x2="21" y2="12"/>'),
    content: bar({ tagName: 'div', style: { height: '0' } }, { 'border-top': '1px solid #eff2f7', 'font-size': '0', 'line-height': '0' }),
  },
  {
    id: 'etpl-spacer',
    labelKey: 'spacer',
    media: icon('<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>'),
    content: bar({ tagName: 'div', style: { height: '0' } }, { height: '24px', 'font-size': '0', 'line-height': '0' }),
  },
];
