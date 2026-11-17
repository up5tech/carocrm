import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FieldDefinition } from '../api/types.js';
import { FieldValue } from './fields.js';

/**
 * 24.10.7 — the SPA has no rich-text field type and no `dangerouslySetInnerHTML` path, so the
 * sanitisation contract is simpler than a sanitizer: every stored string renders as text. These
 * cases pin that contract — markup a user (or an import) stored in a `text` field must come out
 * escaped, never as live HTML.
 */
const textField: FieldDefinition = { type: 'text', label: 'Notes' };

describe('FieldValue text rendering (no HTML injection surface)', () => {
  it('escapes script markup stored in a text field', () => {
    const html = renderToStaticMarkup(
      <FieldValue field={textField} value={'<script>alert("x")</script>'} />,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an image-onerror payload', () => {
    const html = renderToStaticMarkup(
      <FieldValue field={textField} value={'<img src=x onerror=alert(1)>'} />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes anchor markup with a javascript: href', () => {
    const html = renderToStaticMarkup(
      <FieldValue field={textField} value={'<a href="javascript:alert(1)">x</a>'} />,
    );
    // The payload survives only as visible text — the `javascript:` URL is never a live href.
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;a');
  });

  it('keeps plain multi-line text readable (pre-wrap preserved)', () => {
    const html = renderToStaticMarkup(<FieldValue field={textField} value={'line one\nline two'} />);
    expect(html).toContain('line one');
    expect(html).toContain('line two');
    expect(html).toContain('pre-wrap');
  });
});
