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
import grapesjs, { type Component, type Editor } from 'grapesjs';
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
  /** The template HTML with inline styles (the stored `bodyHtml`). */
  value: string;
  /** Called with the email-safe export whenever the design changes. */
  onChange: (html: string) => void;
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

export const EmailVisualEditor = forwardRef<EmailVisualEditorHandle, EmailVisualEditorProps>(({ value, onChange }, ref) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const lastExportRef = useRef<string>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const firstSyncRef = useRef(true);
  const [ready, setReady] = useState(false);

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
      components: value,
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
        devices: DEVICES.map((device) => ({ ...device, name: t(`web.emailTemplate.${device.id}`) })),
      },
    });
    editorRef.current = editor;
    setReady(true);

    for (const block of EMAIL_BLOCKS) {
      editor.BlockManager.add(block.id, {
        label: t(`web.emailTemplate.blocks.${block.labelKey}`),
        category: { id: 'etpl', label: t('web.emailTemplate.blocks.category'), open: true },
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
      editor.setComponents(value);
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
