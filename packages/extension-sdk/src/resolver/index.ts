import { ExtensionError } from '../errors/index.js';
import type { ExtensionManifest } from '../manifest/index.js';
import { PLATFORM_VERSION } from '../manifest/index.js';
import { compareVersions, satisfiesMinimum } from '../semver/index.js';

/**
 * Dependency resolution and module priority (PLAN §38.3, §39).
 *
 * Two rules decide the order in which packages contribute metadata:
 *
 *  1. **Dependencies first.** An extension that declares `dependencies: [{ id: 'core-ext' }]` must
 *     load after the package it builds on, whatever their `order` values say.
 *  2. **`order` decides the rest.** Lower `order` loads first, higher overrides (PLAN §39).
 *
 * Anything ambiguous fails fast instead of silently picking a winner: a missing dependency, a
 * version range that the installed dependency does not satisfy, a dependency cycle, a duplicate
 * package id or a platform version outside the manifest's window.
 */

export interface ResolvableExtension {
  readonly id: string;
  readonly version: string;
  readonly order: number;
  readonly dependencies: readonly { readonly id: string; readonly version?: string | undefined }[];
  readonly minPlatformVersion?: string | undefined;
  readonly maxPlatformVersion?: string | undefined;
}

export interface ResolveOptions {
  /** Platform version the installation runs; defaults to the SDK's {@link PLATFORM_VERSION}. */
  readonly platformVersion?: string | undefined;
  /**
   * Ids that are present on disk but switched off. They are skipped, and an extension depending on
   * one is refused with a clear "not enabled" error instead of "missing".
   */
  readonly inactiveIds?: ReadonlySet<string> | undefined;
}

export interface ResolutionReport {
  /** Ids in load order: dependencies first, then ascending `order`, then id. */
  readonly order: readonly string[];
  /** Entries that were refused, with the reason; they are skipped, not fatal. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Orders the given extensions, throwing on the first structural problem (PLAN §39: "ambiguous
 * overrides fail fast when safety cannot be guaranteed").
 *
 * An extension that cannot be loaded is reported in `skipped` when the failure is *its own*
 * (incompatible platform version); a broken dependency graph throws, because loading a partial
 * graph would produce a half-configured installation.
 */
export function resolveExtensions(extensions: readonly ResolvableExtension[], options: ResolveOptions = {}): ResolutionReport {
  const platformVersion = options.platformVersion ?? PLATFORM_VERSION;
  const inactive = options.inactiveIds ?? new Set<string>();
  const byId = new Map<string, ResolvableExtension>();
  for (const extension of extensions) {
    if (byId.has(extension.id)) {
      throw new ExtensionError('EXTENSION_MANIFEST_INVALID', `Two extension packages declare the id "${extension.id}".`, {
        id: extension.id,
      });
    }
    byId.set(extension.id, extension);
  }

  const skipped: { id: string; reason: string }[] = [];
  const active = new Map<string, ResolvableExtension>();
  for (const extension of extensions) {
    if (inactive.has(extension.id)) {
      skipped.push({ id: extension.id, reason: 'disabled' });
      continue;
    }
    const problem = platformProblem(extension, platformVersion);
    if (problem !== undefined) {
      skipped.push({ id: extension.id, reason: problem });
      continue;
    }
    active.set(extension.id, extension);
  }

  const sorted = [...active.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (extension: ResolvableExtension): void => {
    const current = state.get(extension.id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(extension.id)), extension.id].join(' -> ');
      throw new ExtensionError('EXTENSION_DEPENDENCY_CYCLE', `Extension dependencies form a cycle: ${cycle}.`, { cycle });
    }
    state.set(extension.id, 'visiting');
    stack.push(extension.id);

    for (const dependency of extension.dependencies) {
      const target = byId.get(dependency.id);
      if (target === undefined) {
        throw new ExtensionError('EXTENSION_DEPENDENCY_MISSING', `"${extension.id}" depends on "${dependency.id}", which is not installed.`, {
          id: extension.id,
          dependency: dependency.id,
        });
      }
      if (!active.has(dependency.id)) {
        const reason = inactive.has(dependency.id) ? 'not enabled' : 'incompatible';
        throw new ExtensionError(
          'EXTENSION_DEPENDENCY_MISSING',
          `"${extension.id}" depends on "${dependency.id}", which is ${reason}. Enable it first.`,
          { id: extension.id, dependency: dependency.id, reason },
        );
      }
      if (dependency.version !== undefined && !satisfiesMinimum(target.version, dependency.version)) {
        throw new ExtensionError(
          'EXTENSION_VERSION_INCOMPATIBLE',
          `"${extension.id}" requires "${dependency.id}" ${dependency.version} or newer, but ${target.version} is installed.`,
          { id: extension.id, dependency: dependency.id, required: dependency.version, installed: target.version },
        );
      }
      visit(target);
    }

    stack.pop();
    state.set(extension.id, 'done');
    order.push(extension.id);
  };

  for (const extension of sorted) visit(extension);
  return { order, skipped };
}

/** `undefined` when the manifest is compatible with the running platform. */
export function platformProblem(manifest: ResolvableExtension, platformVersion: string): string | undefined {
  if (manifest.minPlatformVersion !== undefined && !satisfiesMinimum(platformVersion, manifest.minPlatformVersion)) {
    return `requires platform ${manifest.minPlatformVersion} or newer, running ${platformVersion}`;
  }
  if (manifest.maxPlatformVersion !== undefined && compareVersions(platformVersion, manifest.maxPlatformVersion) > 0) {
    return `supports platform up to ${manifest.maxPlatformVersion}, running ${platformVersion}`;
  }
  return undefined;
}

/** Adapts a parsed manifest to the resolver's structural view. */
export function toResolvable(manifest: ExtensionManifest): ResolvableExtension {
  return {
    id: manifest.id,
    version: manifest.version,
    order: manifest.order,
    dependencies: manifest.dependencies,
    ...(manifest.minPlatformVersion === undefined ? {} : { minPlatformVersion: manifest.minPlatformVersion }),
    ...(manifest.maxPlatformVersion === undefined ? {} : { maxPlatformVersion: manifest.maxPlatformVersion }),
  };
}