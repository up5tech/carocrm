import { describe, expect, it } from 'vitest';

import { ExtensionError } from '../errors/index.js';
import { mergeMetadataSources, readMetadataDocument } from './index.js';

const entity = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Account',
  label: 'Account',
  fields,
  relations: {},
  ...extra,
});

describe('mergeMetadataSources', () => {
  it('merges fields and relations of the same entity from several packages', () => {
    const merged = mergeMetadataSources([
      readMetadataDocument({ entities: { Account: entity({ id: { type: 'varchar' }, tier: { type: 'varchar' } }) } }, {}),
      readMetadataDocument(
        { entities: { Account: entity({ score: { type: 'int' } }, { relations: { tickets: { type: 'oneToMany', target: 'Ticket' } } }) } },
        {},
      ),
    ]);
    const account = merged.entities?.['Account'] as { fields: Record<string, unknown>; relations: Record<string, unknown> };
    expect(Object.keys(account.fields).sort()).toEqual(['id', 'score', 'tier']);
    expect(Object.keys(account.relations)).toEqual(['tickets']);
  });

  it('concatenates index declarations instead of dropping earlier ones', () => {
    const merged = mergeMetadataSources([
      readMetadataDocument({ entities: { Account: entity({ tier: { type: 'varchar' } }, { indexes: [{ name: 'i1', fields: ['tier'] }] }) } }, {}),
      readMetadataDocument({ entities: { Account: entity({}, { indexes: [{ name: 'i2', fields: ['score'] }] }) } }, {}),
    ]);
    const account = merged.entities?.['Account'] as { indexes: { name: string }[] };
    expect(account.indexes.map((index) => index.name)).toEqual(['i1', 'i2']);
  });

  it('lets the later package override a scalar value', () => {
    const merged = mergeMetadataSources([
      readMetadataDocument({ entities: { Account: entity({}, { label: 'Company' }) } }, {}),
      readMetadataDocument({ entities: { Account: entity({}, { label: 'Customer' }) } }, {}),
    ]);
    expect((merged.entities?.['Account'] as { label: string }).label).toBe('Customer');
  });

  it('merges layouts per view and carries the non-entity sections forward', () => {
    const merged = mergeMetadataSources([
      readMetadataDocument({ entities: {}, layouts: { Account: { list: { entity: 'Account', type: 'list', panels: [{ name: 'main', fields: ['name'] }] } } }, jobs: { 'demo.run': { name: 'demo.run', handler: 'demo' } } }, {}),
      readMetadataDocument({ entities: {}, layouts: { Account: { detail: { entity: 'Account', type: 'detail', panels: [{ name: 'main', fields: ['name'] }] } } } }, {}),
    ]);
    expect(Object.keys(merged.layouts?.['Account'] ?? {})).toEqual(['list', 'detail']);
    expect(Object.keys(merged.jobs ?? {})).toEqual(['demo.run']);
  });

  it('rejects a document whose entities section is not an object', () => {
    expect(() => readMetadataDocument({ entities: [] }, { id: 'demo' })).toThrowError(/entities|object/);
  });

  it('accepts a partial entity contribution (only the parts the package extends)', () => {
    const source = readMetadataDocument({ entities: { Account: { fields: { tier: { type: 'enum', values: ['A'] } } } } }, { id: 'demo-ext' });
    expect(Object.keys((source.entities?.['Account'] as { fields: Record<string, unknown> }).fields)).toEqual(['tier']);
  });

  it('names the offending extension in the error', () => {
    try {
      readMetadataDocument({ entities: { Account: { name: 'Account', label: 'A', fields: { id: { type: 42 } } } } }, { id: 'demo-ext' });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ExtensionError);
      expect((error as ExtensionError).code).toBe('EXTENSION_METADATA_INVALID');
      expect((error as ExtensionError).message).toContain('demo-ext');
      expect((error as ExtensionError).message).toContain('Account');
    }
  });
});