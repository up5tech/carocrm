/**
 * Audit module barrel — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...AUDIT_CONTROLLERS]
 *   providers:   [...AUDIT_PROVIDERS]
 *
 * Kernel hook seam (docs/module-guide.md `KERNEL_HOOKS_TOKEN`):
 * the entity module owns the `AfterSaveHook[]` value; register audit
 * capture either via a factory —
 *   {
 *     provide: KERNEL_HOOKS_TOKEN,
 *     inject: [AuditHookService],
 *     useFactory: (audit: AuditHookService) => registerAuditHook([], audit),
 *   }
 * — or at bootstrap: `registerAuditHook(app.get(KERNEL_HOOKS_TOKEN), app.get(AuditHookService))`.
 *
 * Field-audit policy seam: replace the default AUDIT_METADATA_LOOKUP
 * provider (audit-all when the entity is unknown) with a lookup backed by
 * the metadata store, e.g.
 *   { provide: AUDIT_METADATA_LOOKUP, inject: [METADATA_STORE],
 *     useFactory: (store) => (entity: string) => store.registry.getEntity(entity)?.fields }
 *
 * Delete-audit seam: call `AuditSinkService.recordDelete(...)` from the
 * entity delete flow (AfterSaveHook only covers create/update).
 */
import type { Provider, Type } from '@nestjs/common';

import { AuditController } from './audit.controller.js';
import type { AuditEntityMetadataLookup } from './audit-hooks.js';
import { AUDIT_METADATA_LOOKUP, AuditHookService, AuditSinkService } from './audit-hooks.js';
import { AuditReadService } from './audit-read.service.js';

export { AuditController } from './audit.controller.js';
export type {
  AfterSaveHookLike,
  AuditableRecord,
  AuditEntityMetadataLookup,
  AuditHookArgs,
  RecordChangesArgs,
  RecordDeleteArgs,
} from './audit-hooks.js';
export {
  AUDIT_METADATA_LOOKUP,
  AuditHookService,
  AuditSinkService,
  registerAuditHook,
} from './audit-hooks.js';
export type { AuditListQuery, AuditListResult, AuditLogEntryDto } from './audit-read.service.js';
export { AUDIT_MAX_LIMIT,AuditReadService } from './audit-read.service.js';

export const AUDIT_SINK_TOKEN = Symbol('AUDIT_SINK');
export const AUDIT_HOOK_SERVICE_TOKEN = Symbol('AUDIT_HOOK_SERVICE');

export const AUDIT_PROVIDERS: Provider[] = [
  // Default: unknown entity metadata ⇒ audit every differing attrs key.
  { provide: AUDIT_METADATA_LOOKUP, useFactory: (): AuditEntityMetadataLookup => () => undefined },
  AuditSinkService,
  { provide: AUDIT_SINK_TOKEN, useExisting: AuditSinkService },
  AuditHookService,
  { provide: AUDIT_HOOK_SERVICE_TOKEN, useExisting: AuditHookService },
  AuditReadService,
];

export const AUDIT_CONTROLLERS: Type<unknown>[] = [AuditController];
