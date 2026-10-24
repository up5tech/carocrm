/**
 * The visual email designer: a GrapesJS editor configured for email production.
 *
 * GrapesJS is not a React component — it owns a DOM subtree and keeps its state in models —
 * so this wrapper is deliberately thin and imperative: it builds the editor once, feeds the
 * template HTML in, and publishes the email-safe export back out. The React page stays the
 * single source of truth for the record; nothing is persisted by GrapesJS itself
 * (`storageManager: false`).
 *
 * Two conversions bracket the editing session:
 *  - in:  the stored `bodyHtml` (inline styles) is parsed by GrapesJS into canvas rules;
 *  - out: `getHtml()` + `getCss()` are folded back into inline styles by `inlineEmailCss`,
 *    because that is the form email clients actually render.
 *
 * The placeholder palette (`{{fieldName}}` tokens) is React-rendered next to the editor and
 * reaches into the canvas through the imperative handle, so token insertion works in both
 * the visual and the source modes with the same chips.
 */
import 'grapesjs/dist/css/grapes.min.css';

import { Spin } from 'antd';
import grapesjs, { type Component, type ComponentDefinitionDefined, type Editor } from 'grapesjs';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { t } from '../../state/i18n.js';
import { EMAIL_BLOCKS } from './emailBlocks.js';
import { inlineEmailCss } from './inlineEmailCss.js';

/** What the page can ask of the mounted editor. */
export interface EmailVisualEditorHandle {
  /**
   * Inserts a `{{token}}` into the selected text component, or drops a new text component
   * with it into the selected container (or the root) when text is not selected. Returns
   * whether the token landed somewhere.
   */
  insertToken(token: string): boolean;
}

export interface EmailVisualEditorProps {
  /** The template HTML with inline styles (the stored `bodyHtml`, or a document body). */
  value: string;
  /** Called with the email-safe export whenever the design changes. */
  onChange: (html: string) => void;
  /** Palette blocks; defaults to the email set. */
  blocks?: readonly VisualBlockSpec[];
  /** i18n prefix the block labels live under (`<prefix>.<labelKey>`). */
  blockLabelPrefix?: string;
  /** i18n prefix for the desktop/mobile device names (`<prefix>.desktop`). */
  deviceLabelPrefix?: string;
}

/** The block shape the palette expects; email and document palettes share it. */
export interface VisualBlockSpec {
  id: string;
  labelKey: string;
  media: string;
  content: ComponentDefinitionDefined;
}

/** Debounce window for the export; typing in the RTE fires `change` on every keystroke. */
const EXPORT_DEBOUNCE_MS = 400;

/** `append` answers with a list; the first entry is what was dropped. */
function firstAppended(appended: Component[] | undefined): Component | undefined {
  return appended?.[0];
}

/** Email widths: the desktop frame matches the 600px convention, mobile a 375px phone. */
const DEVICES = [
  { id: 'desktop', name: '', width: '640' },
  { id: 'mobile', name: '', width: '375' },
];

/**
 * A loose text run (one that does not start with a tag) is not editable in GrapesJS as-is,
 * because it is parsed into `textnode`s. Wrapping it in a `<p>` makes the whole run a single
 * editable `text` component, so templates authored as plain text + `<br>` (including seeded
 * ones) can be edited by clicking in the canvas.
 */
function wrapLooseText(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('<')) return value;
  return `<p>${value}</p>`;
}

/**
 * GrapesJS discards text nodes that sit directly inside `<tbody>` — which is exactly where a
 * hand-written (or seeded) document template puts its `{{#each lines}}` markers. It moves them
 * before the table, so the loop no longer wraps the rows. Wrapping each marker in a hidden row
 * keeps the order and the loop intact; a document built from the palette already carries
 * `data-carocrm-loop` markers and is left alone.
 */
function protectLoopMarkers(value: string): string {
  if (value.includes('data-carocrm-loop') || !value.includes('{{#each')) return value;
  const marker = (tag: string) =>
    `<tr data-carocrm-loop="${tag}" style="display:none"><td colspan="12" style="display:none;padding:0;border:0;font-size:0;line-height:0">${tag}</td></tr>`;
  return value.replace(/(<tbody[^>]*>)([\s\S]*?)(<\/tbody>)/gi, (_whole, open: string, inner: string, close: string) => {
    const protectedInner = inner
      .replace(/\{\{#each\s+[a-zA-Z0-9_.]+\}\}/g, (found: string) => marker(found))
      .replace(/\{\{\/each\}\}/g, (found: string) => marker(found));
    return `${open}${protectedInner}${close}`;
  });
}

/** Everything the editor needs done to a stored body before GrapesJS parses it. */
function prepareBody(value: string): string {
  return wrapLooseText(protectLoopMarkers(value));
}

export const EmailVisualEditor = forwardRef<EmailVisualEditorHandle, EmailVisualEditorProps>(({ value, onChange, blocks, blockLabelPrefix, deviceLabelPrefix }, ref) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const lastExportRef = useRef<string>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const firstSyncRef = useRef(true);
  const [ready, setReady] = useState(false);
  // The palette and its labels are fixed for the life of one editor; the ref keeps the
  // build-once effect independent of the props object each render creates.
  const configRef = useRef({
    blocks: blocks ?? EMAIL_BLOCKS,
    blockLabelPrefix: blockLabelPrefix ?? 'web.emailTemplate.blocks',
    deviceLabelPrefix: deviceLabelPrefix ?? 'web.emailTemplate',
  });
  configRef.current = {
    blocks: blocks ?? EMAIL_BLOCKS,
    blockLabelPrefix: blockLabelPrefix ?? 'web.emailTemplate.blocks',
    deviceLabelPrefix: deviceLabelPrefix ?? 'web.emailTemplate',
  };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const editor = grapesjs.init({
      container: host,
      height: '100%',
      width: 'auto',
      // The record is the storage; GrapesJS must not fetch or autosave anything.
      storageManager: false,
      noticeOnUnload: false,
      // Devices only resize the frame — no media rules are generated for the export.
      devicePreviewMode: true,
      // Treat <br> as inline text so a loose text run (text nodes + <br>) becomes an
      // editable `text` component instead of a pile of non-editable `textnode`s —
      // otherwise templates written as plain text + <br> (e.g. seeded ones) cannot be
      // edited by clicking in the canvas.
      parser: { textTags: ['br'] },
      components: prepareBody(value),
      style: '',
      styleManager: {
        sectors: [
          {
            id: 'etpl-dimension',
            name: t('web.emailTemplate.sectors.dimension'),
            open: true,
            properties: [
              { property: 'width', name: t('web.emailTemplate.props.width') },
              { property: 'height', name: t('web.emailTemplate.props.height') },
              { property: 'max-width', name: t('web.emailTemplate.props.maxWidth') },
              { property: 'min-height', name: t('web.emailTemplate.props.minHeight') },
              { property: 'padding', name: t('web.emailTemplate.props.padding') },
              { property: 'margin', name: t('web.emailTemplate.props.margin') },
            ],
          },
          {
            id: 'etpl-typography',
            name: t('web.emailTemplate.sectors.typography'),
            open: false,
            properties: [
              { property: 'font-family', name: t('web.emailTemplate.props.fontFamily') },
              { property: 'font-size', name: t('web.emailTemplate.props.fontSize') },
              { property: 'font-weight', name: t('web.emailTemplate.props.fontWeight') },
              { property: 'color', name: t('web.emailTemplate.props.color') },
              { property: 'line-height', name: t('web.emailTemplate.props.lineHeight') },
              { property: 'text-align', name: t('web.emailTemplate.props.textAlign') },
              { property: 'text-decoration', name: t('web.emailTemplate.props.textDecoration') },
              { property: 'letter-spacing', name: t('web.emailTemplate.props.letterSpacing') },
            ],
          },
          {
            id: 'etpl-background',
            name: t('web.emailTemplate.sectors.background'),
            open: false,
            properties: [{ property: 'background-color', name: t('web.emailTemplate.props.backgroundColor') }],
          },
          {
            id: 'etpl-border',
            name: t('web.emailTemplate.sectors.border'),
            open: false,
            properties: [
              { property: 'border-width', name: t('web.emailTemplate.props.borderWidth') },
              { property: 'border-style', name: t('web.emailTemplate.props.borderStyle') },
              { property: 'border-color', name: t('web.emailTemplate.props.borderColor') },
              { property: 'border-radius', name: t('web.emailTemplate.props.borderRadius') },
            ],
          },
        ],
      },
      deviceManager: {
        default: 'desktop',
        devices: DEVICES.map((device) => ({ ...device, name: t(`${configRef.current.deviceLabelPrefix}.${device.id}`) })),
      },
    });
    editorRef.current = editor;
    setReady(true);

    for (const block of configRef.current.blocks) {
      editor.BlockManager.add(block.id, {
        label: t(`${configRef.current.blockLabelPrefix}.${block.labelKey}`),
        category: { id: 'etpl', label: t(`${configRef.current.blockLabelPrefix}.category`), open: true },
        media: block.media,
        content: block.content,
        // One click appends the block (drag also works): an email designer composes by
        // clicking sections into place, not by dragging every single one.
        onClick: (block, editor) => {
          const content = block.getContent();
          const resolved = typeof content === 'function' ? content() : content;
          if (resolved !== undefined) editor.getWrapper()?.append(resolved);
        },
      });
    }
    // The palette is the primary tool of an email designer, so it opens first; the style
    // manager and layers stay one click away in the same panel.
    editor.runCommand('open-blocks');

    // Text in an email is what the designer edits most, so a single click on a text block
    // drops straight into typing instead of requiring the non-obvious double-click that
    // GrapesJS defaults to (which made existing templates look uneditable).
    const tryEditText = (component: unknown) => {
      const target = Array.isArray(component) ? (component as unknown[])[0] : component;
      if (target === null || target === undefined) return;
      if (typeof (target as { get?: (k: string) => unknown }).get !== 'function') return;
      if ((target as { get: (k: string) => unknown }).get('type') !== 'text') return;
      const view = (target as { getView?: () => unknown }).getView?.();
      if (view !== undefined && view !== null) {
        const v = view as { onActive?: (ev?: unknown) => unknown };
        if (typeof v.onActive === 'function') v.onActive();
        editor.getModel().setEditing(view as never);
      }
    };
    editor.on('component:selected', tryEditText);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const html = inlineEmailCss(editor.getHtml(), editor.getCss() ?? '');
        if (html === lastExportRef.current) return;
        lastExportRef.current = html;
        onChangeRef.current(html);
      }, EXPORT_DEBOUNCE_MS);
    };
    editor.on('change', publish);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      editor.off('change', publish);
      editor.destroy();
      editorRef.current = null;
    };
    // The editor is built once per mount; later value changes are applied by the sync effect.
  }, []);

  // External edits (switching from the HTML mode after typing raw markup) reload the canvas.
  useEffect(() => {
    if (firstSyncRef.current) {
      firstSyncRef.current = false;
      return;
    }
    const editor = editorRef.current;
    if (editor === null) return;
    if (value !== lastExportRef.current) {
      lastExportRef.current = value;
      editor.setComponents(prepareBody(value));
    }
  }, [value]);

  const insertToken = useCallback((token: string): boolean => {
    const editor = editorRef.current;
    if (editor === null) return false;
    // `getSelected` returns undefined (not null) when nothing is selected.
    const selected = editor.getSelected();
    if (selected) {
      if (selected.get('type') === 'text') {
        const current = typeof selected.get('content') === 'string' ? String(selected.get('content')) : '';
        // `set` (not `append`): a text component serialises only its children once it has any,
        // which would silently drop the text that was already there.
        selected.set('content', `${current}${token}`);
        return true;
      }
      if (Array.isArray(selected.get('components'))) {
        const dropped = firstAppended(selected.append({ type: 'text', content: token }));
        if (dropped !== undefined) editor.select(dropped);
        return true;
      }
    }
    const wrapper = editor.getWrapper();
    if (wrapper === undefined) return false;
    const dropped = firstAppended(wrapper.append({ type: 'text', content: token }));
    if (dropped !== undefined) editor.select(dropped);
    return true;
  }, []);

  useImperativeHandle(ref, () => ({ insertToken }), [insertToken]);

  return (
    <div className="carocrm-gjs">
      <div className="carocrm-gjs-host" ref={hostRef} />
      {ready ? null : (
        <div className="carocrm-gjs-loading">
          <Spin size="large" />
        </div>
      )}
    </div>
  );
});
