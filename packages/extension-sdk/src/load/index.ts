import { log } from '@carocrm/core/logger/index.js';
import type { MetadataSource } from '@carocrm/metadata/merger/index.js';

import { errorMessage,ExtensionError } from '../errors/index.js';
import type { ExtensionRuntime } from '../host/index.js';
import { ExtensionHost } from '../host/index.js';
import type { ExtensionPackage, LoadedExtensionPackage } from '../loader/index.js';
import { loadExtensionPackage, readMetadataSource, scanExtensionPackages } from '../loader/index.js';
import { resolveExtensions, toResolvable } from '../resolver/index.js';

/**
 * Assembles the {@link ExtensionHost} for a process (PLAN §38.3).
 *
 * Order of operations:
 *   1. scan the extension directory — every child with a `manifest.json` is a *package*;
 *   2. keep the packages an administrator installed **and** enabled (`installed_extensions`);
 *   3. resolve dependencies / module priority / platform compatibility, failing fast on a broken
 *      graph (PLAN §39);
 *   4. read metadata documents and import backend modules.
 *
 * A package present on disk but not installed is ignored — that is what makes "install" an explicit
 * administrative act. A package whose own version window excludes the running platform is skipped
 * with a warning. Anything structurally broken (duplicate id, dependency cycle, a manifest path
 * escaping the package) throws, because a half-loaded installation would silently change metadata
 * precedence. A package whose *own* files fail to load is reported in `host.errors` so one bad
 * package cannot take the whole process down.
 */

export interface LoadExtensionsOptions {
  /** Directory that holds extension packages (`EXTENSIONS_DIR`). */
  readonly directory: string;
  /** Platform version every manifest is checked against. Defaults to {@link PLATFORM_VERSION}. */
  readonly platformVersion?: string | undefined;
  /** Ids present in `installed_extensions` with `enabled = true`. */
  readonly enabledIds: ReadonlySet<string>;
  /** Ids present in `installed_extensions` with `enabled = false`. */
  readonly disabledIds?: ReadonlySet<string> | undefined;
  /** Import backend modules. The API and the worker both want this; read-only tooling may not. */
  readonly loadBackends?: boolean | undefined;
}

export async function loadExtensions(options: LoadExtensionsOptions): Promise<ExtensionHost> {
  const scan = scanExtensionPackages(options.directory);
  for (const error of scan.errors) {
    log.error({ dir: error.dir, error: error.message }, 'extension package could not be read');
  }

  const disabledIds = options.disabledIds ?? new Set<string>();
  const installed = scan.packages.filter((pkg) => options.enabledIds.has(pkg.id));
  for (const pkg of scan.packages) {
    if (!options.enabledIds.has(pkg.id) && !disabledIds.has(pkg.id)) {
      log.info({ id: pkg.id }, 'extension package present but not installed');
    }
  }

  const resolution = resolveExtensions(installed.map((pkg) => toResolvable(pkg.manifest)), {
    platformVersion: options.platformVersion,
    inactiveIds: disabledIds,
  });
  for (const skip of resolution.skipped) {
    log.warn({ id: skip.id, reason: skip.reason }, 'extension skipped');
  }

  const byId = new Map(installed.map((pkg) => [pkg.id, pkg]));
  const runtimes: ExtensionRuntime[] = [];
  const failures: { dir: string; message: string }[] = [];

  for (const id of resolution.order) {
    const pkg = byId.get(id);
    if (pkg === undefined) continue;
    try {
      runtimes.push(toRuntime(pkg, await loadPackage(pkg, options.loadBackends !== false)));
    } catch (error: unknown) {
      // A path escaping the package directory means the manifest itself is hostile: refuse to boot.
      if (error instanceof ExtensionError && error.code === 'EXTENSION_PATH_ESCAPE') throw error;
      failures.push({ dir: pkg.dir, message: errorMessage(error) });
      log.error({ id: pkg.id, error: errorMessage(error) }, 'extension failed to load');
    }
  }

  return new ExtensionHost(runtimes, resolution.skipped, failures);
}

async function loadPackage(pkg: ExtensionPackage, loadBackends: boolean): Promise<LoadedExtensionPackage> {
  if (loadBackends) return loadExtensionPackage(pkg);
  const metadata: MetadataSource = readMetadataSource(pkg);
  return { ...pkg, metadata, backend: undefined };
}

function toRuntime(pkg: ExtensionPackage, loaded: LoadedExtensionPackage): ExtensionRuntime {
  return {
    id: pkg.id,
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    dir: pkg.dir,
    order: pkg.manifest.order,
    description: pkg.manifest.description,
    permissions: pkg.manifest.permissions,
    dependencies: pkg.manifest.dependencies,
    package: loaded,
  };
}