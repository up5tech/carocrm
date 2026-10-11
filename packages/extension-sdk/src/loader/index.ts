import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MetadataSource } from '@carocrm/metadata/merger/index.js';

import { errorMessage,ExtensionError } from '../errors/index.js';
import type { ExtensionManifest } from '../manifest/index.js';
import { parseManifestJson } from '../manifest/index.js';
import { mergeMetadataSources, readMetadataDocument } from '../metadata/index.js';
import type { ExtensionBackend, ExtensionDomainEventSubscription, ExtensionHookRegistration, ExtensionJobRegistration } from '../types/index.js';
import { isRecord } from '../types/index.js';

/**
 * Filesystem loader for extension packages (PLAN §38.3).
 *
 * A package is a directory with a `manifest.json` at its root, an optional `metadata/` directory
 * of JSON documents, an optional `migrations/` directory of ordered `*.sql` files and an optional
 * backend module. Packages live under one configured directory (`EXTENSIONS_DIR`), so installing
 * one is copying a directory — there is no upload endpoint and therefore no path an attacker can
 * choose at runtime.
 *
 * Every path taken from a manifest is resolved *inside* the package directory; a manifest that
 * points at `../..` is refused rather than followed.
 */

export interface ExtensionPackage {
  /** Package id, taken from the manifest. */
  readonly id: string;
  /** Absolute path of the package directory. */
  readonly dir: string;
  readonly manifest: ExtensionManifest;
  /** Absolute paths of the metadata documents, in a deterministic order. */
  readonly metadataFiles: readonly string[];
  /** Absolute paths of the migration files, sorted by filename. */
  readonly migrationFiles: readonly string[];
}

export interface ScanResult {
  readonly packages: readonly ExtensionPackage[];
  /** Directories that could not be read as a package; the scan continues without them. */
  readonly errors: readonly { readonly dir: string; readonly message: string }[];
}

export interface LoadedExtensionPackage extends ExtensionPackage {
  readonly metadata: MetadataSource;
  readonly backend: ExtensionBackend | undefined;
}

const MANIFEST_FILE = 'manifest.json';

/** Reads every extension directory below `directory`. A missing directory is simply empty. */
export function scanExtensionPackages(directory: string): ScanResult {
  const root = resolve(directory);
  if (!existsSync(root)) return { packages: [], errors: [] };

  const packages: ExtensionPackage[] = [];
  const errors: { dir: string; message: string }[] = [];

  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = parseManifestJson(readFileSync(manifestPath, 'utf8'), { id: entry, dir });
      const packageDir = resolve(dir);
      packages.push({
        id: manifest.id,
        dir: packageDir,
        manifest,
        metadataFiles: listFiles(packageDir, manifest.metadata ?? 'metadata', '.json'),
        migrationFiles: listFiles(packageDir, manifest.migrations ?? 'migrations', '.sql'),
      });
    } catch (error: unknown) {
      errors.push({ dir, message: errorMessage(error) });
    }
  }
  return { packages, errors };
}

/** Reads and validates the metadata documents of a package. */
export function readMetadataSource(pkg: ExtensionPackage): MetadataSource {
  const documents: MetadataSource[] = [];
  for (const file of pkg.metadataFiles) {
    const text = readFileSync(file, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error: unknown) {
      throw new ExtensionError('EXTENSION_METADATA_INVALID', `Metadata document "${file}" is not valid JSON: ${errorMessage(error)}`, {
        id: pkg.id,
        file,
      });
    }
    documents.push(readMetadataDocument(value, { id: pkg.id, file }));
  }
  return mergeMetadataSources(documents);
}

/** Reads the ordered SQL migrations of a package. */
export function readMigrations(pkg: ExtensionPackage): { name: string; sql: string }[] {
  return pkg.migrationFiles.map((file) => ({ name: file.slice(file.lastIndexOf(sep) + 1), sql: readFileSync(file, 'utf8') }));
}

/**
 * Imports the backend module. Only the API process and the worker call this, both from a package
 * directory an administrator placed on disk; nothing here evaluates user input.
 */
export async function importExtensionBackend(pkg: ExtensionPackage): Promise<ExtensionBackend | undefined> {
  const pointer = backendEntry(pkg);
  if (pointer === undefined) return undefined;
  const entry = resolveInside(pkg.dir, pointer.entry, pkg.id);
  if (!existsSync(entry)) {
    throw new ExtensionError('EXTENSION_BACKEND_LOAD_FAILED', `Backend entry "${pointer.entry}" of extension "${pkg.id}" does not exist.`, {
      id: pkg.id,
      entry: pointer.entry,
    });
  }
  let module: unknown;
  try {
    module = (await import(pathToFileURL(entry).href)) as unknown;
  } catch (error: unknown) {
    throw new ExtensionError('EXTENSION_BACKEND_LOAD_FAILED', `Extension "${pkg.id}" backend failed to load: ${errorMessage(error)}`, {
      id: pkg.id,
      entry: pointer.entry,
    });
  }
  return normalizeBackend((isRecord(module) && module['default'] !== undefined ? module['default'] : module), pkg.id);
}

/** Loads a package completely: metadata documents plus the backend module. */
export async function loadExtensionPackage(pkg: ExtensionPackage): Promise<LoadedExtensionPackage> {
  const [metadata, backend] = [readMetadataSource(pkg), await importExtensionBackend(pkg)];
  return { ...pkg, metadata, backend };
}

/** `{ entry, worker }` for the backend module, or `undefined` for a metadata-only package. */
export function backendEntry(pkg: ExtensionPackage): { entry: string; worker: boolean } | undefined {
  const backend = pkg.manifest.backend;
  if (backend === undefined) return undefined;
  if (typeof backend === 'string') return { entry: backend, worker: true };
  return { entry: backend.entry, worker: backend.worker };
}

/** Validates the shape of a backend module so a malformed package fails with a clear error. */
export function normalizeBackend(value: unknown, id: string): ExtensionBackend {
  if (!isRecord(value)) {
    throw new ExtensionError('EXTENSION_BACKEND_INVALID', `Extension "${id}" must default-export an object describing its backend.`, { id });
  }
  const backend: ExtensionBackend = {
    ...(value['metadata'] === undefined ? {} : { metadata: value['metadata'] as MetadataSource }),
    ...(value['providers'] === undefined ? {} : { providers: asArray(value['providers'], id, 'providers') }),
    ...(value['controllers'] === undefined ? {} : { controllers: asArray(value['controllers'], id, 'controllers') }),
    ...(value['hooks'] === undefined
      ? {}
      : { hooks: asArray(value['hooks'], id, 'hooks') as readonly ExtensionHookRegistration[] }),
    ...(value['jobs'] === undefined ? {} : { jobs: asArray(value['jobs'], id, 'jobs') as readonly ExtensionJobRegistration[] }),
    ...(value['domainEvents'] === undefined
      ? {}
      : { domainEvents: asArray(value['domainEvents'], id, 'domainEvents') as readonly ExtensionDomainEventSubscription[] }),
    ...(typeof value['setup'] === 'function' ? { setup: value['setup'] as NonNullable<ExtensionBackend['setup']> } : {}),
  };
  return backend;
}

/** Resolves a package-relative path and refuses anything that escapes the package directory. */
export function resolveInside(dir: string, relativePath: string, id: string): string {
  if (isAbsolute(relativePath)) {
    throw new ExtensionError('EXTENSION_PATH_ESCAPE', `Extension "${id}" declares an absolute path ("${relativePath}"); paths must be relative to the package.`, {
      id,
      path: relativePath,
    });
  }
  const resolved = resolve(dir, relativePath);
  const rel = relative(resolve(dir), resolved);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new ExtensionError('EXTENSION_PATH_ESCAPE', `Extension "${id}" path "${relativePath}" escapes the package directory.`, {
      id,
      path: relativePath,
    });
  }
  return resolved;
}

function listFiles(dir: string, relativeDir: string, extension: string): string[] {
  let target: string;
  try {
    target = resolveInside(dir, relativeDir, relativeDir);
  } catch {
    return [];
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) return [];
  return readdirSync(target)
    .filter((file) => file.endsWith(extension))
    .sort()
    .map((file) => join(target, file));
}

function asArray(value: unknown, id: string, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ExtensionError('EXTENSION_BACKEND_INVALID', `Extension "${id}" declares "${field}", which must be an array.`, { id, field });
  }
  return value;
}