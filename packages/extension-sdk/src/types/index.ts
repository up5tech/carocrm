import type { Logger } from '@carocrm/core/logger/index.js';
import type { HookHandler, HookPhase } from '@carocrm/entity-engine/types/index.js';
import type { JobHandler } from '@carocrm/jobs';
import type { MetadataSource } from '@carocrm/metadata/merger/index.js';

import type { ExtensionManifest } from '../manifest/index.js';

/**
 * The extension backend contract (PLAN §38.1).
 *
 * An extension is a self-contained package: a `manifest.json`, optional metadata documents,
 * optional SQL migrations and one backend module. The backend module is the only executable part
 * and it is loaded by the host (API process, worker process) — never by a browser and never
 * straight from user input.
 *
 * Everything here is data, never a string of code the platform evaluates: providers are Nest
 * providers, controllers are Nest controllers, jobs are named handlers, and metadata is JSON that
 * the metadata engine validates (PLAN §12.4). `providers`/`controllers` are typed as `unknown`
 * so this package stays framework-neutral and an extension author imports the Nest types from
 * `@nestjs/common` themselves.
 */

export interface ExtensionHookRegistration {
  /** Unique within the installation; shown by `GET /api/v1/Hook`. */
  readonly name: string;
  readonly phase: HookPhase;
  /** Restrict the hook to one entity type; omit to run for every entity. */
  readonly entity?: string | undefined;
  readonly handler: HookHandler;
}

export interface ExtensionJobRegistration {
  /** `<module>.<action>`; must be unique in the worker registry. */
  readonly name: string;
  readonly handler: JobHandler;
  /** Optional cron that the installer registers in `scheduled_jobs` on install. */
  readonly scheduling?: string | undefined;
}

export interface ExtensionDomainEventSubscription {
  /** Event type, or `'*'` for every event (see `DomainEventBus.subscribe`). */
  readonly eventType: string;
  readonly name: string;
  readonly handler: (event: { id: string; eventType: string; payload: Record<string, unknown> }) => Promise<void>;
}

/**
 * Facade handed to `setup()`. It is deliberately narrow: extensions get the database handle, the
 * job queue, a scoped configuration reader and the logger — not the Nest container, so an
 * extension cannot reach into kernel internals and accidentally bypass ACL.
 */
export interface ExtensionApi {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly log: Logger;
  readonly db: ExtensionDb;
  /** Submit a background job through the normal §24 queue (visible and cancellable in the admin UI). */
  readonly enqueue: (job: string, data?: Record<string, unknown>) => Promise<string>;
  /** Read the extension's own configuration from `app_settings` (scope `extension:<id>`). */
  readonly getConfig: <T = unknown>(key: string, fallback: T) => T;
  /** Read a value the extension stored earlier with the private `saveConfig` helper on the API side. */
  readonly setConfig: (key: string, value: unknown) => Promise<void>;
  /** The merged metadata snapshot, available once the platform has finished loading metadata. */
  readonly metadata: () => Record<string, unknown>;
}

/**
 * Parameterised SQL escape hatch for extension-owned tables.
 *
 * Extension packages are trusted code in a self-hosted installation (PLAN §38.4): they are
 * installed from disk by an administrator, they run in-process, and they already own their
 * migrations. Within that model a raw handle is honest — but it is *only* for extension-owned
 * tables. Anything touching CRM data must go through the metadata/entity API so ACL, validation,
 * audit and hooks stay in force.
 */
export interface ExtensionDb {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

/** Default-exported object of an extension backend module. */
export interface ExtensionBackend {
  /** Metadata contributed by the package; merged in `order` sequence (PLAN §12.2, §39). */
  readonly metadata?: MetadataSource;
  /** Nest providers registered in the host module. */
  readonly providers?: readonly unknown[];
  /** Nest controllers registered in the host module. */
  readonly controllers?: readonly unknown[];
  readonly hooks?: readonly ExtensionHookRegistration[];
  readonly jobs?: readonly ExtensionJobRegistration[];
  readonly domainEvents?: readonly ExtensionDomainEventSubscription[];
  /** Called once at boot, after metadata is loaded, with the extension facade. */
  readonly setup?: (api: ExtensionApi) => void | Promise<void>;
}

/**
 * Injected tokens an extension may depend on.
 *
 * They exist so an extension does **not** have to import the API application: everything the host
 * offers is behind a token declared here, in a package an extension already depends on. Nest's
 * `emitDecoratorMetadata` is off under `tsx` (docs/module-guide.md), so constructor injection must
 * use these symbols explicitly anyway.
 */
export const EXTENSION_DATABASE = Symbol('EXTENSION_DATABASE');
export const EXTENSION_ACL = Symbol('EXTENSION_ACL');
export const EXTENSION_METADATA = Symbol('EXTENSION_METADATA');
export const EXTENSION_JOB_ENQUEUER = Symbol('EXTENSION_JOB_ENQUEUER');
export const EXTENSION_PRINCIPAL = Symbol('EXTENSION_PRINCIPAL');

/** The signed-in user, as far as an extension needs to know (PLAN §9.2). */
export interface ExtensionPrincipal {
  readonly userId: string | undefined;
  readonly userName: string | undefined;
  readonly userType: string | undefined;
  readonly isAdmin: boolean;
  readonly roles: readonly string[];
  readonly teams: readonly string[];
}

export type ExtensionAclAction = 'create' | 'read' | 'edit' | 'delete' | 'stream';

/**
 * Record-level access check (PLAN §18.4).
 *
 * An extension endpoint is an API surface like any other: it must ask before it reads or writes a
 * CRM record. `recordId` may be omitted for `create`, where no record exists yet.
 */
export interface ExtensionAcl {
  /** Entity-level decision (may a user of this role touch the entity at all). */
  canAccess(entityType: string, action: ExtensionAclAction): Promise<boolean>;
  /** Record-level decision; `false` when the record does not exist. */
  canAccessRecord(entityType: string, action: ExtensionAclAction, recordId: string): Promise<boolean>;
}

/** Submit a job through the normal §24 queue. Returns the `jobs` row id. */
export type ExtensionJobEnqueuer = (job: string, data?: Record<string, unknown>) => Promise<string>;

/** The merged metadata snapshot (PLAN §7.3), the same document `GET /api/v1/Metadata` serves. */
export type ExtensionMetadataLookup = () => Record<string, unknown>;

/** An extension package as the host sees it: manifest, location and (once imported) backend. */
export interface LoadedExtension {
  readonly id: string;
  readonly dir: string;
  readonly manifest: ExtensionManifest;
  /** Metadata documents parsed from `metadata/`, already validated against the metadata schemas. */
  readonly metadata: MetadataSource;
  readonly backend: ExtensionBackend | undefined;
}

export function emptyMetadataSource(): MetadataSource {
  return { entities: {} };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}