import type { MetadataSource } from '@carocrm/metadata/merger/index.js';

import type { LoadedExtensionPackage } from '../loader/index.js';
import type { ExtensionNavItem } from '../manifest/index.js';
import { mergeMetadataSources } from '../metadata/index.js';
import type {
  ExtensionBackend,
  ExtensionDomainEventSubscription,
  ExtensionHookRegistration,
  ExtensionJobRegistration,
} from '../types/index.js';

/**
 * The extension host (PLAN §38.3).
 *
 * One host per process, assembled **before** the runtime exists: Nest providers/controllers are
 * fixed when the container is built, and the worker needs the same set without Nest at all. The
 * host therefore lives in the SDK and is passed to each runtime as a plain value.
 *
 * It owns the load order. Everything downstream — metadata merge, provider/controller registration,
 * job handlers, domain-event subscribers, SPA navigation — reads from here, so there is exactly one
 * answer to "which extensions are running and in what precedence".
 */

export interface ExtensionRuntime {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  /** Metadata merge priority (PLAN §39): lower loads first, higher overrides. */
  readonly order: number;
  readonly description: string | undefined;
  readonly permissions: readonly string[];
  readonly dependencies: readonly { readonly id: string; readonly version?: string | undefined }[];
  readonly package: LoadedExtensionPackage;
}

export interface SkippedExtension {
  readonly id: string;
  readonly reason: string;
}

export interface ExtensionLoadFailure {
  readonly dir: string;
  readonly message: string;
}

export interface FrontendNavContribution extends ExtensionNavItem {
  readonly extension: string;
  /** The contributing package's `order`, so nav groups follow metadata priority. */
  readonly extensionOrder: number;
}

export class ExtensionHost {
  constructor(
    readonly extensions: readonly ExtensionRuntime[] = [],
    readonly skipped: readonly SkippedExtension[] = [],
    readonly errors: readonly ExtensionLoadFailure[] = [],
  ) {}

  static empty(): ExtensionHost {
    return new ExtensionHost();
  }

  get size(): number {
    return this.extensions.length;
  }

  ids(): string[] {
    return this.extensions.map((extension) => extension.id);
  }

  get(id: string): ExtensionRuntime | undefined {
    return this.extensions.find((extension) => extension.id === id);
  }

  backend(id: string): ExtensionBackend | undefined {
    return this.get(id)?.package.backend;
  }

  /** Metadata sources in load order: dependencies first, then ascending `order` (PLAN §39). */
  metadataSources(): MetadataSource[] {
    return this.extensions.map((extension) => extension.package.metadata);
  }

  /** The single merged contribution, for introspection, tests and the metadata store. */
  mergedMetadata(): MetadataSource {
    return mergeMetadataSources(this.metadataSources());
  }

  providers(): unknown[] {
    return this.extensions.flatMap((extension) => [...(extension.package.backend?.providers ?? [])]);
  }

  controllers(): unknown[] {
    return this.extensions.flatMap((extension) => [...(extension.package.backend?.controllers ?? [])]);
  }

  hooks(): { extension: string; hook: ExtensionHookRegistration }[] {
    return this.extensions.flatMap((extension) =>
      (extension.package.backend?.hooks ?? []).map((hook) => ({ extension: extension.id, hook })),
    );
  }

  jobs(): { extension: string; job: ExtensionJobRegistration }[] {
    return this.extensions.flatMap((extension) =>
      (extension.package.backend?.jobs ?? []).map((job) => ({ extension: extension.id, job })),
    );
  }

  domainEvents(): { extension: string; subscription: ExtensionDomainEventSubscription }[] {
    return this.extensions.flatMap((extension) =>
      (extension.package.backend?.domainEvents ?? []).map((subscription) => ({ extension: extension.id, subscription })),
    );
  }

  /** `{ id, setup }` pairs, in load order, for the post-bootstrap `setup()` pass. */
  setups(): { id: string; setup: NonNullable<ExtensionBackend['setup']> }[] {
    return this.extensions.flatMap((extension) =>
      extension.package.backend?.setup === undefined ? [] : [{ id: extension.id, setup: extension.package.backend.setup }],
    );
  }

  /** SPA navigation contributions, sorted by package order then the item's own order. */
  frontendNav(): FrontendNavContribution[] {
    return this.extensions
      .flatMap((extension) =>
        (extension.package.manifest.frontend?.nav ?? []).map((item) => ({
          ...item,
          extension: extension.id,
          extensionOrder: extension.order,
        })),
      )
      .sort((left, right) => left.extensionOrder - right.extensionOrder || left.order - right.order || left.route.localeCompare(right.route));
  }
}