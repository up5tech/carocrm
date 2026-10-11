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
import { HealthController } from './health/health.controller.js';
import type { MetadataStoreService as MetadataStoreType } from './metadata/metadata-store.service.js';
import { METADATA_STORE,MetadataStoreService } from './metadata/metadata-store.service.js';

@Module({
  controllers: [
    HealthController,
    AuthController,
    IdentityController,
    ...ATTACHMENT_CONTROLLERS,
    ...AUDIT_CONTROLLERS,
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
    ...ENTITY_PROVIDERS,
    ...ATTACHMENT_PROVIDERS,
    ...AUDIT_PROVIDERS,
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
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }

  async onApplicationBootstrap(): Promise<void> {
    registerAuditHook(this.hooks, this.auditHook);
    await this.metadataStore.load();
  }
}
