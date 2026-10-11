import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExtensionError } from '../errors/index.js';
import type { ExtensionPackage } from './index.js';
import { backendEntry, importExtensionBackend, normalizeBackend, readMetadataSource, readMigrations, resolveInside, scanExtensionPackages } from './index.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'carocrm-ext-'));
  roots.push(root);
  return root;
}

function package_(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(root, id);
  mkdirSync(join(dir, 'metadata'), { recursive: true });
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', ...manifest }, null, 2));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** The scan is expected to yield exactly one package in these fixtures. */
function missing(id: string): never {
  throw new Error(`expected package "${id}"`);
}

function only(packages: readonly ExtensionPackage[]): ExtensionPackage {
  const [pkg] = packages;
  if (pkg === undefined) throw new Error('expected exactly one scanned package');
  return pkg;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('scanExtensionPackages', () => {
  it('returns nothing when the directory does not exist', () => {
    expect(scanExtensionPackages(join(workspace(), 'absent'))).toEqual({ packages: [], errors: [] });
  });

  it('ignores directories without a manifest and collects the rest in id order', () => {
    const root = workspace();
    mkdirSync(join(root, 'not-an-extension'));
    package_(root, 'zeta', {});
    package_(root, 'alpha', { order: 50 });

    const result = scanExtensionPackages(root);
    expect(result.errors).toEqual([]);
    expect(result.packages.map((pkg) => pkg.id)).toEqual(['alpha', 'zeta']);
    expect(result.packages[0]?.manifest.order).toBe(50);
  });

  it('reports a broken manifest per package instead of failing the whole scan', () => {
    const root = workspace();
    package_(root, 'good', {});
    mkdirSync(join(root, 'broken'));
    writeFileSync(join(root, 'broken', 'manifest.json'), '{"id":"broken"}');

    const result = scanExtensionPackages(root);
    expect(result.packages.map((pkg) => pkg.id)).toEqual(['good']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.dir).toBe(join(root, 'broken'));
    expect(result.errors[0]?.message).toContain('broken');
  });

  it('honours custom metadata and migrations directories', () => {
    const root = workspace();
    const dir = package_(root, 'custom', { metadata: 'meta', migrations: 'sql' }, { 'meta/entities.json': '{"entities":{}}' });
    const pkg = scanExtensionPackages(root).packages[0];
    expect(pkg?.metadataFiles).toEqual([join(dir, 'meta', 'entities.json')]);
    expect(pkg?.migrationFiles).toEqual([]);
  });
});

describe('resolveInside', () => {
  it('accepts a package-relative path', () => {
    const root = workspace();
    expect(resolveInside(root, 'metadata/entities.json', 'demo')).toBe(join(root, 'metadata', 'entities.json'));
  });

  it('refuses a path that escapes the package directory', () => {
    const root = workspace();
    expect(() => resolveInside(root, '../../etc/passwd', 'demo')).toThrowError(ExtensionError);
    try {
      resolveInside(root, '../../etc/passwd', 'demo');
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect((error as ExtensionError).code).toBe('EXTENSION_PATH_ESCAPE');
    }
    expect(() => resolveInside(root, '/etc/passwd', 'demo')).toThrowError(/absolute/);
  });
});

describe('readMetadataSource', () => {
  it('validates contributed entities against the kernel schemas', () => {
    const root = workspace();
    package_(
      root,
      'meta-only',
      {},
      {
        'metadata/entities.json': JSON.stringify({
          entities: { Health: { name: 'Health', label: 'Health', fields: { id: { type: 'varchar' } }, relations: {} } },
        }),
      },
    );
    const source = readMetadataSource(only(scanExtensionPackages(root).packages));
    expect(Object.keys(source.entities ?? {})).toEqual(['Health']);
  });

  it('rejects a malformed field definition inside a contribution', () => {
    const root = workspace();
    package_(root, 'broken-meta', {}, {
      'metadata/entities.json': JSON.stringify({ entities: { Health: { fields: { score: { type: 42 } } } } }),
    });
    expect(() => readMetadataSource(only(scanExtensionPackages(root).packages))).toThrowError(/Health/);
  });

  it('rejects a metadata document that is not an object', () => {
    const root = workspace();
    package_(root, 'list-meta', {}, { 'metadata/entities.json': '[]' });
    expect(() => readMetadataSource(only(scanExtensionPackages(root).packages))).toThrowError(/must be a JSON object/);
  });
});

describe('readMigrations', () => {
  it('returns migrations sorted by file name', () => {
    const root = workspace();
    package_(root, 'sql', {}, { 'migrations/002_second.sql': 'SELECT 2', 'migrations/001_first.sql': 'SELECT 1', 'migrations/notes.txt': 'x' });
    expect(readMigrations(only(scanExtensionPackages(root).packages)).map((file) => file.name)).toEqual([
      '001_first.sql',
      '002_second.sql',
    ]);
  });
});

describe('backend modules', () => {
  it('reports the backend pointer of both manifest forms', () => {
    const root = workspace();
    package_(root, 'shorthand', { backend: 'backend/index.mjs' });
    package_(root, 'object', { backend: { entry: 'backend/index.mjs', worker: false } });
    package_(root, 'metadata-only', {});
    const byId = new Map(scanExtensionPackages(root).packages.map((pkg) => [pkg.id, pkg]));
    expect(backendEntry(byId.get('shorthand') ?? missing('shorthand'))).toEqual({ entry: 'backend/index.mjs', worker: true });
    expect(backendEntry(byId.get('object') ?? missing('object'))).toEqual({ entry: 'backend/index.mjs', worker: false });
    expect(backendEntry(byId.get('metadata-only') ?? missing('metadata-only'))).toBeUndefined();
  });

  // The dynamic `import()` of an absolute path is exercised end to end by
  // `apps/api/test/extensions.test.ts` with a real package; vitest's module runner resolves
  // relative specifiers only, so a tmpdir .mjs fixture cannot be imported here.

  it('fails with a clear error when the entry file is missing', async () => {
    const root = workspace();
    package_(root, 'missing-entry', { backend: 'backend/index.mjs' });
    await expect(importExtensionBackend(only(scanExtensionPackages(root).packages))).rejects.toThrowError(/does not exist/);
  });

  it('rejects a backend that is not an object and a non-array section', () => {
    expect(() => normalizeBackend('nope', 'demo')).toThrowError(/must default-export an object/);
    expect(() => normalizeBackend({ providers: 'nope' }, 'demo')).toThrowError(/must be an array/);
    expect(normalizeBackend({ setup: () => undefined }, 'demo').setup).toBeTypeOf('function');
  });
});