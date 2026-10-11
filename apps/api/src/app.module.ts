import type { MiddlewareConsumer, NestModule, OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { ACL_PROVIDERS } from './acl/acl.module.js';
import { AclApiService } from './acl/acl-api.service.js';
import type { ParentAclChecker } from './attachment/index.js';
import { ATTACHMENT_CONTROLLERS, ATTACHMENT_PROVIDERS, PARENT_ACL_CHECK_TOKEN } from './attachment/index.js';
import type { AuditEntityMetadataLookup } from './audit/index.js';
import { AUDIT_CONTROLLERS, AUDIT_METADATA_LOOKUP, AUDIT_PROVIDERS, AuditHookService, registerAuditHook } from './audit/index.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { IdentityController } from './auth/identity.controller.js';
import { IdentityService } from './auth/identity.service.js';
import { CALENDAR_CONTROLLERS, CALENDAR_PROVIDERS } from './calendar/index.js';
import { OutboxService } from './common/outbox.service.js';
import { RequestContextMiddleware } from './common/request-context.middleware.js';
import { REQUEST_SCOPE_TOKEN,RequestScope } from './common/request-scope.js';
import { buildConfig, CONFIG_TOKEN } from './config.js';
import { DatabaseService } from './database/database.service.js';
import { ENTITY_CONTROLLERS, ENTITY_PROVIDERS } from './entity/entity.module.js';
import type { PostgresRecordStore } from './entity/entity-record.store.js';
import { ENTITY_STORE } from './entity/entity-record.store.js';
import type { AfterSaveHook } from './entity/hooks.js';
import { KERNEL_HOOKS_TOKEN } from './entity/hooks.js';
import { DOMAIN_EVENT_CONTROLLERS, DOMAIN_EVENT_PROVIDERS, EntityEventHookService, registerEntityEventHook } from './events/index.js';
import { HealthController } from './health/health.controller.js';
import { HOOK_CONTROLLERS, HOOK_PROVIDERS } from './hooks/index.js';
import { JOB_CONTROLLERS, JOB_PROVIDERS } from './jobs/index.js';
import { LOGIC_CONTROLLERS, LOGIC_PROVIDERS } from './logic/index.js';
import type { MetadataStoreService as MetadataStoreType } from './metadata/metadata-store.service.js';
import { METADATA_STORE,MetadataStoreService } from './metadata/metadata-store.service.js';
import type { StreamEntityMetadataLookup } from './stream/index.js';
import { registerStreamUpdateHook, STREAM_CONTROLLERS, STREAM_METADATA_LOOKUP, STREAM_PROVIDERS, StreamUpdateHookService } from './stream/index.js';

@Module({
  controllers: [
    HealthController,
    AuthController,
    IdentityController,
    ...ATTACHMENT_CONTROLLERS,
    ...AUDIT_CONTROLLERS,
    // `/api/v1/:entityType/:entityId/{stream,subscription}` must be matched before the
    // generic record controller treats the third segment as a relation name.
    ...STREAM_CONTROLLERS,
    ...CALENDAR_CONTROLLERS,
    // `/api/v1/Formula/...`, `/api/v1/Hook` and `/api/v1/DomainEvent` are static prefixes and
    // must be matched before `:entity`.
    ...LOGIC_CONTROLLERS,
    ...HOOK_CONTROLLERS,
    ...DOMAIN_EVENT_CONTROLLERS,
    // `/api/v1/Job...` and `/api/v1/ScheduledJob...` are static prefixes too.
    ...JOB_CONTROLLERS,
    // Generic `/api/v1/:entity` wildcard routes stay last so static routes win.
    ...ENTITY_CONTROLLERS,
  ],
  providers: [
    { provide: CONFIG_TOKEN, useFactory: buildConfig },
    DatabaseService,
    { provide: METADATA_STORE, useClass: MetadataStoreService },
    { provide: REQUEST_SCOPE_TOKEN, useClass: RequestScope },
    AuthService,
    IdentityService,
    OutboxService,
    ...ACL_PROVIDERS,
    ...HOOK_PROVIDERS,
    ...DOMAIN_EVENT_PROVIDERS,
    ...JOB_PROVIDERS,
    ...LOGIC_PROVIDERS,
    ...ENTITY_PROVIDERS,
    ...ATTACHMENT_PROVIDERS,
    ...AUDIT_PROVIDERS,
    ...STREAM_PROVIDERS,
    ...CALENDAR_PROVIDERS,
    {
      provide: STREAM_METADATA_LOOKUP,
      inject: [METADATA_STORE],
      useFactory: (store: MetadataStoreType): StreamEntityMetadataLookup => (entity: string) =>
        store.registry.getEntity(entity)?.fields,
    },
    {
      provide: AUDIT_METADATA_LOOKUP,
      inject: [METADATA_STORE],
      useFactory: (store: MetadataStoreType): AuditEntityMetadataLookup => (entity: string) =>
        store.registry.getEntity(entity)?.fields,
    },
    {
      provide: PARENT_ACL_CHECK_TOKEN,
      inject: [AclApiService, ENTITY_STORE],
      useFactory: (acl: AclApiService, store: PostgresRecordStore): ParentAclChecker => ({
        canReadParent: async (entityType: string, recordId: string) => {
          const record = await store.findById(entityType, recordId);
          if (!record) return false;
          const teams = Array.isArray(record.data['teams']) ? (record.data['teams'] as string[]) : undefined;
          const decision = await acl.canAccessRecord(entityType, 'read', {
            assignedUserId: record.assignedUserId,
            createdById: record.createdById,
            ...(teams !== undefined ? { teams } : {}),
          });
          return decision.allowed;
        },
      }),
    },
    AuthGuard,
    {
      provide: APP_GUARD,
      useExisting: AuthGuard,
    },
  ],
  exports: [
    DatabaseService,
    AuthService,
    IdentityService,
    OutboxService,
    REQUEST_SCOPE_TOKEN,
    KERNEL_HOOKS_TOKEN,
    METADATA_STORE,
  ],
})
export class AppModule implements NestModule, OnApplicationBootstrap {
  constructor(
    @Inject(METADATA_STORE) private readonly metadataStore: MetadataStoreType,
    @Inject(KERNEL_HOOKS_TOKEN) private readonly hooks: AfterSaveHook[],
    @Inject(AuditHookService) private readonly auditHook: AuditHookService,
    @Inject(StreamUpdateHookService) private readonly streamHook: StreamUpdateHookService,
    @Inject(EntityEventHookService) private readonly eventHook: EntityEventHookService,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }

  async onApplicationBootstrap(): Promise<void> {
    registerAuditHook(this.hooks, this.auditHook);
    registerStreamUpdateHook(this.hooks, this.streamHook);
    // Domain events are written inside the mutation transaction, after audit and stream rows.
    registerEntityEventHook(this.hooks, this.eventHook);
    await this.metadataStore.load();
  }
}
