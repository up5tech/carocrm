import { describe, expect, it } from 'vitest';

import { formulaContextOf, interpolate, interpolateString, resolvePath } from './index.js';

const context = {
  name: 'ACME',
  emailAddress: 'owner@acme.test',
  count: 3,
  nested: { tier: 'Gold' },
  empty: null,
};

describe('interpolate', () => {
  it('replaces a whole-string placeholder with the raw value, keeping its type', () => {
    expect(interpolate('{{count}}', context)).toBe(3);
    expect(interpolate('{{emailAddress}}', context)).toBe('owner@acme.test');
    expect(interpolate('{{empty}}', context)).toBeNull();
  });

  it('stringifies placeholders embedded in a longer string', () => {
    expect(interpolate('Hello {{name}} ({{count}})', context)).toBe('Hello ACME (3)');
    expect(interpolate('Missing: {{nope.here}}', context)).toBe('Missing: ');
    expect(interpolate('Null: [{{empty}}]', context)).toBe('Null: []');
  });

  it('walks arrays and nested objects', () => {
    expect(interpolate(['{{name}}', { who: '{{emailAddress}}' }], context)).toEqual(['ACME', { who: 'owner@acme.test' }]);
  });

  it('passes other value types through untouched', () => {
    expect(interpolate(42, context)).toBe(42);
    expect(interpolate(true, context)).toBe(true);
    expect(interpolate(null, context)).toBeNull();
  });

  it('tolerates whitespace inside the braces', () => {
    expect(interpolateString('{{  name  }}', context)).toBe('ACME');
  });

  it('resolves dotted paths and returns undefined for a broken path', () => {
    expect(resolvePath('nested.tier', context)).toBe('Gold');
    expect(resolvePath('nested.tier.deeper', context)).toBeUndefined();
    expect(resolvePath('count.length', context)).toBeUndefined();
  });

  it('builds the formula record with the run identifiers', () => {
    const record = formulaContextOf({ record: { name: 'ACME' }, entityType: 'Account', entityId: 'a1', userId: 'u1' });
    expect(record).toMatchObject({ name: 'ACME', id: 'a1', entityType: 'Account', entityId: 'a1', userId: 'u1' });
    expect(formulaContextOf({ record: {}, entityType: 'Account', entityId: 'a1' })['userId']).toBeNull();
  });
});