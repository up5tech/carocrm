import { describe, expect, it } from 'vitest';

import { renderTemplate, renderTemplateParts } from './index.js';

describe('renderTemplate', () => {
  it('substitutes known variables and drops unknown ones', () => {
    const out = renderTemplate('Hello {{ name }}, order {{orderId}} total {{missing}}.', {
      name: 'Ada',
      orderId: 42,
    });
    expect(out).toBe('Hello Ada, order 42 total .');
  });

  it('renders null/undefined variables as empty strings and booleans as text', () => {
    expect(renderTemplate('a{{x}}b', { x: null })).toBe('ab');
    expect(renderTemplate('a{{x}}b', { x: undefined })).toBe('ab');
    expect(renderTemplate('a{{x}}b', { x: false })).toBe('afalseb');
  });

  it('leaves text without placeholders untouched', () => {
    expect(renderTemplate('no placeholders here', {})).toBe('no placeholders here');
  });
});

describe('renderTemplateParts', () => {
  it('renders each part independently and keeps missing parts null', () => {
    const parts = renderTemplateParts({ subject: 'Hi {{who}}', body: 'Body' }, { who: 'there' });
    expect(parts).toEqual({ subject: 'Hi there', body: 'Body', bodyHtml: null });
  });
});