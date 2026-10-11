import { describe, expect, it } from 'vitest';

import { ExtensionError } from '../errors/index.js';
import { parseManifest, parseManifestJson } from './index.js';

const base = {
  id: 'crm-health',
  name: 'Health Score',
  version: '1.0.0',
};

describe('extension manifest', () => {
  it('applies defaults for every optional section', () => {
    const manifest = parseManifest(base);
    expect(manifest.dependencies).toEqual([]);
    expect(manifest.permissions).toEqual([]);
    expect(manifest.order).toBe(100);
    expect(manifest.backend).toBeUndefined();
  });

  it('accepts both dependency spellings and keeps the version constraint', () => {
    const manifest = parseManifest({ ...base, dependencies: ['core-ext', { id: 'other', version: '2.1.0' }] });
    expect(manifest.dependencies).toEqual([{ id: 'core-ext' }, { id: 'other', version: '2.1.0' }]);
  });

  it('normalises the backend shorthand and the object form', () => {
    expect(parseManifest({ ...base, backend: 'src/index.ts' }).backend).toBe('src/index.ts');
    expect(parseManifest({ ...base, backend: { entry: 'src/index.ts', worker: false } }).backend).toEqual({
      entry: 'src/index.ts',
      worker: false,
    });
    expect(parseManifest({ ...base, backend: { entry: 'src/index.ts' } }).backend).toEqual({ entry: 'src/index.ts', worker: true });
  });

  it('fills the frontend nav defaults', () => {
    const manifest = parseManifest({ ...base, frontend: { nav: [{ route: '/Health', label: 'Health' }] } });
    expect(manifest.frontend?.nav[0]).toEqual({ route: '/Health', label: 'Health', adminOnly: false, order: 100 });
  });

  it('rejects a malformed manifest with every issue listed', () => {
    try {
      parseManifest({ ...base, id: 'Not Kebab', version: 'one' }, { id: 'crm-health' });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ExtensionError);
      expect((error as ExtensionError).code).toBe('EXTENSION_MANIFEST_INVALID');
      expect((error as ExtensionError).message).toContain('crm-health');
      expect((error as ExtensionError).details['issues']).toEqual(expect.arrayContaining([expect.stringContaining('id:')]));
    }
  });

  it('refuses unknown keys instead of ignoring a typo', () => {
    expect(() => parseManifest({ ...base, dependancies: [] })).toThrowError(/dependancies/);
  });

  it('reports invalid JSON without a stack of zod issues', () => {
    try {
      parseManifestJson('{ not json', { id: 'crm-health' });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect((error as ExtensionError).code).toBe('EXTENSION_MANIFEST_INVALID');
      expect((error as ExtensionError).message).toContain('not valid JSON');
    }
  });

  it('keeps the free-form package block without interpreting it', () => {
    const manifest = parseManifest({ ...base, package: { vendor: 'ACME', homepage: 'https://example.com' } });
    expect(manifest.package).toEqual({ vendor: 'ACME', homepage: 'https://example.com' });
  });
});