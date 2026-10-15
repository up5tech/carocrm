import { describe, expect, it } from 'vitest';

import { renderTemplate } from './template.js';

/**
 * @carocrm/document — the template engine.
 *
 * The cases that matter are the ones a hand-rolled placeholder substitution gets wrong: escaping,
 * unknown names, scoping inside a loop, and the difference between "no lines" and "no data".
 */
describe('placeholders', () => {
  it('substitutes a plain value and escapes it for HTML', () => {
    const result = renderTemplate('Hello <b>{{name}}</b>, total {{totals.grossTotal}}.', {
      name: 'Acme & Sons',
      totals: { grossTotal: '123.00' },
    });
    expect(result.body).toBe('Hello &lt;b&gt;Acme &amp; Sons&lt;/b&gt;, total 123.00.');
    expect(result.warnings).toEqual([]);
  });

  it('substitutes a triple-brace placeholder raw, for template-authored HTML', () => {
    const result = renderTemplate('<td>{{{cellHtml}}}</td>', { cellHtml: '<b>bold</b>' });
    expect(result.body).toBe('<td><b>bold</b></td>');
    expect(result.warnings).toEqual([]);
  });

  it('leaves an unresolved placeholder in place and reports it, rather than blanking it', () => {
    // A silently blanked `{{contactName}}` sends a document that does not say who it is for.
    const result = renderTemplate('Dear {{contactName}}, total {{totals.grossTotal}}.', { totals: { grossTotal: '1.00' } });
    expect(result.body).toBe('Dear {{contactName}}, total 1.00.');
    expect(result.warnings).toEqual(['"{{contactName}}" could not be resolved from the data.']);
  });

  it('reports an unterminated placeholder instead of dropping the rest of the document', () => {
    const result = renderTemplate('Total {{grossTotal. Nothing follows.', {});
    expect(result.body).toContain('Total {{grossTotal.');
    expect(result.warnings).toEqual(['Unterminated placeholder at offset 6.']);
  });

  it('refuses to stringify an array or an object into a single placeholder', () => {
    const result = renderTemplate('Items: {{items}}', { items: [{ name: 'a' }] });
    expect(result.warnings[0]).toMatch(/resolved to an array/);
    const object = renderTemplate('Total: {{totals}}', { totals: { grossTotal: '1.00' } });
    expect(object.warnings[0]).toMatch(/resolved to an object/);
  });

  it('renders dates and booleans, and refuses a non-finite number', () => {
    expect(renderTemplate('{{when}} / {{ok}}', { when: new Date(Date.UTC(2026, 9, 15)), ok: true }).body).toBe(
      '2026-10-15 / true',
    );
    expect(() => renderTemplate('{{value}}', { value: Number.NaN }).body).toBeTypeOf('string');
  });
});

describe('#each blocks', () => {
  const data = {
    document: { number: 'Q-000042' },
    items: [
      { name: 'Widget', quantity: '2', grossAmount: '20.00' },
      { name: 'Service', quantity: '1', grossAmount: '50.00' },
    ],
  };

  it('repeats a block per item and resolves names against the current element first', () => {
    const result = renderTemplate(
      '{{#each items}}- {{name}} x {{quantity}} = {{grossAmount}} ({{number}})\n{{/each}}',
      data,
    );
    expect(result.body).toBe('- Widget x 2 = 20.00 (Q-000042)\n- Service x 1 = 50.00 (Q-000042)\n');
    expect(result.warnings).toEqual([]);
  });

  it('falls back to the root scope for a name the element does not carry', () => {
    const result = renderTemplate('{{#each items}}{{number}}: {{name}}\n{{/each}}', data);
    expect(result.body).toBe('Q-000042: Widget\nQ-000042: Service\n');
  });

  it('renders nothing for an empty array and says nothing about it', () => {
    const result = renderTemplate('{{#each items}}x{{/each}}', { items: [] });
    expect(result.body).toBe('');
    expect(result.warnings).toEqual([]);
  });

  it('skips the block and warns when the array is missing entirely', () => {
    const result = renderTemplate('{{#each items}}x{{/each}}', {});
    expect(result.body).toBe('');
    expect(result.warnings).toEqual(['"{{#each items}}" names no array in the data, so the block was skipped.']);
  });

  it('skips the block and warns when the name is not an array', () => {
    const result = renderTemplate('{{#each items}}x{{/each}}', { items: 'nope' });
    expect(result.warnings).toEqual(['"{{#each items}}" does not name an array, so the block was skipped.']);
  });

  it('matches nested #each blocks by counting, and refuses runaway nesting', () => {
    const nested = renderTemplate('{{#each groups}}{{#each lines}}{{name}}; {{/each}}{{/each}}', {
      groups: [{ lines: [{ name: 'a' }] }, { lines: [{ name: 'b' }] }],
    });
    expect(nested.body).toBe('a; b;');
    expect(nested.warnings).toEqual([]);

    const runaway = renderTemplate('{{#each a}}{{#each b}}{{#each c}}{{{/each}}{{{/each}}}{{{/each}}}', {
      a: [],
      b: [],
      c: [],
    });
    expect(runaway.warnings).toContain('has no {{/each}}');
  });
});

describe('subjects', () => {
  it('renders the subject and drops any placeholder it could not resolve', () => {
    const result = renderTemplate('Body.', { number: 'Q-000042' }, { subject: 'Quote {{number}}' });
    expect(result.subject).toBe('Quote Q-000042');

    const unresolved = renderTemplate('Body.', {}, { subject: 'Quote {{number}}' });
    expect(unresolved.subject).toBe('Quote');
    expect(unresolved.warnings).toContain('The subject line still contains an unresolved placeholder.');
  });
});
