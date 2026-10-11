import type { Provider, Type } from '@nestjs/common';

import { MetadataController } from '../metadata/metadata.controller.js';
import { EntityController } from './entity.controller.js';
import { EntityCrudService } from './entity.service.js';
import { ENTITY_STORE, PostgresRecordStore } from './entity-record.store.js';
import type { AfterSaveHook } from './hooks.js';
import { KERNEL_HOOKS_TOKEN } from './hooks.js';

/**
 * Static-prefix metadata routes. Registered before the generic record controller so
 * `/api/v1/Metadata...` never falls through the `:entity` wildcard.
 */
export const METADATA_CONTROLLERS: Type<unknown>[] = [MetadataController];

/**
 * Generic record module barrel.
 *
 * Integration contract (docs/module-guide.md): the integrator spreads these into
 * `AppModule`. `ENTITY_CONTROLLERS` MUST be appended AFTER every other controller
 * (AppUser, Metadata, User, Role, Team, Attachment, AuditLog, Authentication, …)
 * because `EntityController` only declares parametrised `/api/v1/:entity...` routes —
 * keeping it last means static routes always win route matching and the OpenAPI
 * listing stays stable.
 *
 * `EntityCrudService` injects `AclApiService`, so `ACL_PROVIDERS`
 * (apps/api/src/acl/acl.module.ts) must be spread into the same module.
 */
export const ENTITY_CONTROLLERS: Type<unknown>[] = [...METADATA_CONTROLLERS, EntityController];

export const ENTITY_PROVIDERS: Provider[] = [
  /**
   * Shared, mutable kernel hook registry. `useValue: []` is a single instance the
   * audit module pushes its `AfterSaveHook` into while being constructed; the record
   * store reads the very same array, so hook registration order does not matter.
   */
  { provide: KERNEL_HOOKS_TOKEN, useValue: [] as AfterSaveHook[] },
  { provide: ENTITY_STORE, useClass: PostgresRecordStore },
  EntityCrudService,
];
