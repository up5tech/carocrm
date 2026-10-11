import { ExtensionError } from '@carocrm/extension-sdk';
import { describe, expect, it } from 'vitest';

import type { Queryable,QueryResultLike } from './db.js';
import { describeExtensionFailure, loadExtensionConfig } from './extensions.js';

/** Minimal `Queryable` double: returns the rows the test decides on. */
function fakeDb(row: Record<string, unknown> | undefined): Queryable {
  return {
    query: async (): Promise<QueryResultLike> => ({ rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 }),
  };
}

describe('loadExtensionConfig', () => {
  it('returns an empty configuration when the extension has never saved one', async () => {
    expect(await loadExtensionConfig(fakeDb(undefined), 'demo')).toEqual({});
  });

  it('accepts a JSONB object row', async () => {
    expect(await loadExtensionConfig(fakeDb({ data: { endpoint: 'https://example.com' } }), 'demo')).toEqual({
      endpoint: 'https://example.com',
    });
  });

  it('accepts a JSON string row and ignores a corrupt one', async () => {
    expect(await loadExtensionConfig(fakeDb({ data: '{"a":1}' }), 'demo')).toEqual({ a: 1 });
    expect(await loadExtensionConfig(fakeDb({ data: 'not json' }), 'demo')).toEqual({});
    expect(await loadExtensionConfig(fakeDb({ data: '"a string"' }), 'demo')).toEqual({});
  });
});

describe('describeExtensionFailure', () => {
  it('prefixes a coded extension error with its code', () => {
    const error = new ExtensionError('EXTENSION_DEPENDENCY_MISSING', '"a" depends on "b".', { id: 'a' });
    expect(describeExtensionFailure(error)).toBe('EXTENSION_DEPENDENCY_MISSING: "a" depends on "b".');
  });

  it('falls back to the message for anything else', () => {
    expect(describeExtensionFailure(new Error('boom'))).toBe('boom');
    expect(describeExtensionFailure('plain')).toBe('plain');
  });
});