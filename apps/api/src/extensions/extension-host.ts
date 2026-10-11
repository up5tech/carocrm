/**
 * Extension host wiring for the API process.
 *
 * The host itself is SDK code (`@carocrm/extension-sdk`) so the API and the worker load exactly the
 * same packages in exactly the same order. This module only adds the Nest-facing half: the DI token
 * that carries the host into the container, and the small bootstrap seam that parks it before Nest
 * reads it (`ExtensionHost` is assembled by `loadExtensionHost()` in `bootstrap.ts`).
 */
import type { ExtensionHost as ExtensionHostType } from '@carocrm/extension-sdk';
import { ExtensionHost } from '@carocrm/extension-sdk';

export type { ExtensionRuntime, FrontendNavContribution, SkippedExtension } from '@carocrm/extension-sdk';
export { ExtensionHost } from '@carocrm/extension-sdk';
export { loadExtensions } from '@carocrm/extension-sdk';

export const EXTENSION_HOST = Symbol('EXTENSION_HOST');

let currentHost: ExtensionHostType = ExtensionHost.empty();

/**
 * Bootstrap seam. The loader runs before Nest is created, so the host is parked here and injected
 * through {@link EXTENSION_HOST}; application code always reads it through DI.
 */
export function setExtensionHost(host: ExtensionHostType): void {
  currentHost = host;
}

export function extensionHost(): ExtensionHostType {
  return currentHost;
}