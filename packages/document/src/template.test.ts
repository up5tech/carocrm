import { describe, expect, it } from 'vitest';

import { renderTemplate } from './template.js';

/**
 * @carocrm/document — the template engine.
 *
 * The cases that matter are the ones a hand-rolled placeholder substitution gets wrong: escaping,
 * unknown names, scoping inside a loop, and the difference between "no lines" and "no data".
 */
describe('placeholders', () => {
  it('substitutes a plain value and escapes it, while the template text stays markup', () => {
    // The template is authored by somebody who means the `<b>` they typed — escaping it would make
    // every template a wall of entities. What is escaped is the **value** that came from a record,
    // which is the only untrusted part of the output. `{{{…}}}` is how an author asks for raw HTML
    // from the data; the two rules are complementary, not contradictory.
    const result = renderTemplate('Hello <b>{{name}}</b>, total {{totals.grossTotal}}.', {
      name: 'Acme & Sons',
      totals: { grossTotal: '123.00' },
    });
    expect(result.body).toBe('Hello <b>Acme &amp; Sons</b>, total 123.00.');
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
    // A NaN or Infinity is not a number a document may print: the placeholder stays, with a warning
    // that names what it really was.
    const nonFinite = renderTemplate('{{value}}', { value: Number.NaN });
    expect(nonFinite.body).toBe('{{value}}');
    expect(nonFinite.warnings).toEqual([
      '"{{value}}" resolved to a non-finite number, which cannot be rendered in one placeholder.',
    ]);
  });
});

describe('#each blocks', () => {
  const data = {
    // The shape Sales hands in: scalars at the root, the lines as an array of records
    // (`quoteTemplateData`, `creditNoteTemplateData`), which is what `{{#each lines}}` walks.
    number: 'Q-000042',
    name: 'the document',
    items: [
      { name: 'Widget', quantity: '2', grossAmount: '20.00' },
      { name: 'Service', quantity: '1', grossAmount: '50.00' },
    ],
  };

  it('repeats a block per item and resolves names against the current element first', () => {
    // `name` exists on both the element and the root: inside the block the element's own value wins,
    // which is exactly why `{{name}}` means the product line here and the document outside it.
    const result = renderTemplate(
      '{{#each items}}- {{name}} x {{quantity}} = {{grossAmount}}\n{{/each}}| {{name}}',
      data,
    );
    expect(result.body).toBe('- Widget x 2 = 20.00\n- Service x 1 = 50.00\n| the document');
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

  it('matches nested #each blocks by counting, and reports the shapes that cannot be', () => {
    const nested = renderTemplate('{{#each groups}}{{#each lines}}{{name}}; {{/each}}{{/each}}', {
      groups: [{ lines: [{ name: 'a' }] }, { lines: [{ name: 'b' }] }],
    });
    // Each inner element emits its own `{{name}}; ` verbatim, including the separator's space.
    expect(nested.body).toBe('a; b; ');
    expect(nested.warnings).toEqual([]);

    // A block with no closing tag is reported, and nothing is invented for the rest of the document.
    expect(renderTemplate('{{#each items}}x', { items: [{ name: 'a' }] }).warnings).toEqual([
      '"{{#each items}}" has no {{/each}}.',
    ]);

    // A closer with no opener is not silently swallowed either — it reads as an unresolvable name.
    expect(renderTemplate('{{/each}}', {}).warnings).toEqual([
      '"{{/each}}" could not be resolved from the data.',
    ]);

    // Nesting is bounded, so a template cannot become a denial-of-service payload. The levels keep
    // finding `a` again through the root scope, so they really do render ten deep.
    const deep = '{{#each a}}'.repeat(10) + '{{name}}' + '{{/each}}'.repeat(10);
    expect(() => renderTemplate(deep, { a: [{ name: 'x' }] })).toThrow(/may not nest #each more than/);
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
