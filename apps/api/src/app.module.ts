import type { ExtensionAcl, ExtensionDb, ExtensionJobEnqueuer, ExtensionMetadataLookup, ExtensionPrincipal } from '@carocrm/extension-sdk';
import { EXTENSION_ACL, EXTENSION_DATABASE, EXTENSION_JOB_ENQUEUER, EXTENSION_METADATA, EXTENSION_PRINCIPAL } from '@carocrm/extension-sdk';
import type { MiddlewareConsumer, NestModule, OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';
import { APP_GUARD, ModuleRef } from '@nestjs/core';

import { ACL_PROVIDERS } from './acl/acl.module.js';
import { AclApiService } from './acl/acl-api.service.js';
import type { NavigationFeatureGate } from './admin-panel/index.js';
import { ADMIN_PANEL_CONTROLLERS, ADMIN_PANEL_PROVIDERS, NAVIGATION_FEATURE_GATE, NavigationService } from './admin-panel/index.js';
import { navigationGroupKeyList } from './admin-panel/navigation-defaults.js';
import { ADVANCED_INTEGRATIONS_CONTROLLERS, ADVANCED_INTEGRATIONS_PROVIDERS } from './advanced-integrations/index.js';
import { AI_AGENTS_CONTROLLERS, AI_AGENTS_PROVIDERS } from './ai-agents/index.js';
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
import type { MenuInvalidator } from './crm-chat/index.js';
import { CRM_CHAT_CONTROLLERS, CRM_CHAT_MENU_INVALIDATOR, CRM_CHAT_PROVIDERS, CRMChatSettingsService } from './crm-chat/index.js';
import { CUSTOMER_SUCCESS_CONTROLLERS, CUSTOMER_SUCCESS_PROVIDERS } from './customer-success/index.js';
import { DatabaseService } from './database/database.service.js';
import { DOCS_CONTROLLERS, DOCS_PROVIDERS, DocsSettingsService } from './docs/index.js';
import { DOCUMENT_CONTROLLERS, DOCUMENT_PROVIDERS } from './document/index.js';
import { EMAIL_CONTROLLERS, EMAIL_PROVIDERS } from './email/index.js';
import { ENTITY_CONTROLLERS, ENTITY_PROVIDERS } from './entity/entity.module.js';
import type { PostgresRecordStore } from './entity/entity-record.store.js';
import { ENTITY_STORE } from './entity/entity-record.store.js';
import type { AfterSaveHook } from './entity/hooks.js';
import { KERNEL_HOOKS_TOKEN } from './entity/hooks.js';
import { ESIGNATURE_CONTROLLERS, ESIGNATURE_PROVIDERS, ESignatureSettingsService } from './esignature/index.js';
import { DOMAIN_EVENT_CONTROLLERS, DOMAIN_EVENT_PROVIDERS, EntityEventHookService, registerEntityEventHook } from './events/index.js';
import type { ExtensionHost as ExtensionHostType } from './extensions/extension-host.js';
import { EXTENSION_HOST, extensionHost } from './extensions/extension-host.js';
import { EXTENSION_CONTROLLERS, EXTENSION_PROVIDERS } from './extensions/index.js';
import { HealthController } from './health/health.controller.js';
import { HookRegistry } from './hooks/hook.registry.js';
import { HOOK_CONTROLLERS, HOOK_PROVIDERS } from './hooks/index.js';
import { I18nController } from './i18n/i18n.controller.js';
import { I18nService } from './i18n/i18n.service.js';
import { JOB_CONTROLLERS, JOB_PROVIDERS } from './jobs/index.js';
import { JobsService } from './jobs/jobs.service.js';
import { LEADSCORE_CONTROLLERS, LEADSCORE_PROVIDERS } from './lead-score/index.js';
import { FormulaService } from './logic/formula.service.js';
import { LOGIC_CONTROLLERS, LOGIC_PROVIDERS } from './logic/index.js';
import { MARKETING_AUTOMATION_CONTROLLERS, MARKETING_AUTOMATION_PROVIDERS } from './marketing-automation/index.js';
import type { MetadataStoreService as MetadataStoreType } from './metadata/metadata-store.service.js';
import { METADATA_STORE,MetadataStoreService,NAVIGATION_GROUP_KEYS } from './metadata/metadata-store.service.js';
import { PORTAL_CONTROLLERS, PORTAL_PROVIDERS } from './portal/index.js';
import { PREFERENCES_CONTROLLERS, PREFERENCES_PROVIDERS } from './preferences/index.js';
import { PROCESS_CONTROLLERS, PROCESS_PROVIDERS } from './processes/index.js';
import { PROJECTS_CONTROLLERS, PROJECTS_PROVIDERS } from './projects/index.js';
import { REPORT_CONTROLLERS, REPORT_PROVIDERS } from './reports/index.js';
import { SALES_CONTROLLERS, SALES_PROVIDERS } from './sales/index.js';
import { SEARCH_CONTROLLERS, SEARCH_PROVIDERS } from './search/index.js';
import { SERVICE_DESK_CONTROLLERS, SERVICE_DESK_PROVIDERS } from './service-desk/index.js';
import { SETTINGS_CONTROLLERS, SETTINGS_PROVIDERS } from './settings/index.js';
import { SETUP_CHECKLIST_CONTROLLERS, SETUP_CHECKLIST_PROVIDERS } from './setup-checklist/index.js';
import type { StreamEntityMetadataLookup } from './stream/index.js';
import { registerStreamUpdateHook, STREAM_CONTROLLERS, STREAM_METADATA_LOOKUP, STREAM_PROVIDERS, StreamUpdateHookService } from './stream/index.js';
import { VOICE_COMMUNICATIONS_CONTROLLERS, VOICE_COMMUNICATIONS_PROVIDERS } from './voice-communications/index.js';
import { WORKFLOW_CONTROLLERS, WORKFLOW_PROVIDERS } from './workflows/index.js';

@Module({
  controllers: [
    HealthController,
    AuthController,
    IdentityController,
    // Phase 7A (PLAN §41.5): `/api/v1/I18n` and `/api/v1/AppUser` are static prefixes,
    // matched before the generic `:entity` wildcard.
    I18nController,
    // `/api/v1/Settings` is a static prefix too: it must not fall through to `:entity`.
    ...SETTINGS_CONTROLLERS,
    // Phase 20.15: setup checklist for first-run administrators.
    ...SETUP_CHECKLIST_CONTROLLERS,
    // Phase 20: `/api/v1/AdminPanel`, `/api/v1/Navigation` and `/api/v1/Settings/documents` are
    // static prefixes, registered with the settings routes so `Settings/:name` never matches them.
    ...ADMIN_PANEL_CONTROLLERS,
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
    // `/api/v1/Email/action/...` and `/Email/:id/deliveries` must be matched before `:entity`.
    ...EMAIL_CONTROLLERS,
    // Phase 20.10: `/api/v1/Preferences` is a static prefix — the caller's own rows are the only ones
    // reachable, so it must never fall through to the `:entity` wildcard.
    ...PREFERENCES_CONTROLLERS,
    // Phase 12: `/api/v1/Search`, `/SavedFilter`, `/Dashboard` static prefixes plus
    // `:entity/action/{import,export}` — all before the generic `:entity` wildcard.
    ...SEARCH_CONTROLLERS,
    // Phase 17: saved report definitions, preview/run and CSV export routes.
    ...REPORT_CONTROLLERS,
    // `/api/v1/Extension`, `/Workflow`, `/WorkflowRun`, `/Process`, `/ProcessInstance` and
    // `/ProcessTask` are static prefixes, matched before `:entity`.
    ...EXTENSION_CONTROLLERS,
    ...WORKFLOW_CONTROLLERS,
    ...PROCESS_CONTROLLERS,
    // Phase 18: `/api/v1/Portal` (portal user + admin) and `/api/v1/PortalRole` static prefixes.
    ...PORTAL_CONTROLLERS,
    // Phase 19: `/api/v1/Project/...` and `/api/v1/ProjectTask/...` domain commands, static
    // prefixes matched before the generic `:entity` wildcard.
    ...PROJECTS_CONTROLLERS,
    // Phase 19-S: `/api/v1/Sales/action/...` domain commands (health, settings, numbering,
    // price resolution, bulk price update, totals preview) — also before `:entity`.
    ...SALES_CONTROLLERS,
    // Phase 19-CS: `/api/v1/CustomerSuccess/action/...` domain commands.
    ...CUSTOMER_SUCCESS_CONTROLLERS,
    // Phase 19-SD: `/api/v1/ServiceDesk/action/...` module commands (diagnostics, settings,
    // numbering). Case CRUD stays on the generic `:entity` API.
    ...SERVICE_DESK_CONTROLLERS,
    // Phase 19-MA: `/api/v1/MarketingAutomation/action/...` module and campaign lifecycle commands.
    // Case/record CRUD stays on the generic `:entity` API.
    ...MARKETING_AUTOMATION_CONTROLLERS,
    // Phase 19-AI: `/api/v1/AIAgents/action/...` is a static prefix (diagnostics, settings,
    // provider connections) and must be matched before the generic `:entity` wildcard.
    ...AI_AGENTS_CONTROLLERS,
    // Phase 19-CHAT: `/api/v1/CRMChat/action/...` is a static prefix (capabilities, diagnostics and
    // the administrative settings row) and must be matched before the generic `:entity` wildcard.
    ...CRM_CHAT_CONTROLLERS,
    // Phase 19-VC: `/api/v1/VoiceCommunications/action/...` and the provider webhook prefix
    // `/api/v1/integrations/voice-communications/...` are static prefixes and must be matched before
    // the generic `:entity` wildcard.
    ...VOICE_COMMUNICATIONS_CONTROLLERS,
    // Phase 19-INT: `/api/v1/AdvancedIntegrations/action/...` and the OAuth callback prefix
    // `/api/v1/integrations/advanced-integrations/...` are static prefixes and must be matched before
    // the generic `:entity` wildcard.
    ...ADVANCED_INTEGRATIONS_CONTROLLERS,
    // Phase 19-ES.1: `/api/v1/ESignature/action/...` is a static prefix and must be matched before
    // the generic `:entity` wildcard. The DocuSign Connect prefix `/api/v1/integrations/esignature/...`
    // arrives with 19-ES.11 and joins the same spread.
    ...ESIGNATURE_CONTROLLERS,
    // Phase 19-LS.1: `/api/v1/LeadScore/action/...` is a static prefix and must be matched before the
    // generic `/api/v1/:entity` wildcard, or the control plane reads as "entity LeadScore, record
    // action". Lead CRUD itself stays exactly where it is: the generic entity controller.
    ...LEADSCORE_CONTROLLERS,
    // `/api/v1/DocumentTemplate` and `/api/v1/document/action/preview` are static prefixes too.
    ...DOCUMENT_CONTROLLERS,
    // Phase 21: `/api/v1/Docs/{tree,page,search}` is a static prefix and must be matched before the
    // generic `:entity` wildcard, or a page read becomes "record `tree` of entity `Docs`".
    ...DOCS_CONTROLLERS,
    // Generic `/api/v1/:entity` wildcard routes stay last so static routes win.
    ...ENTITY_CONTROLLERS,
  ],
  providers: [
    { provide: CONFIG_TOKEN, useFactory: buildConfig },
    DatabaseService,
    { provide: METADATA_STORE, useClass: MetadataStoreService },
    { provide: REQUEST_SCOPE_TOKEN, useClass: RequestScope },
    // Phase 7A (PLAN §41): catalog loader + translator, injected by metadata and error paths too.
    I18nService,
    AuthService,
    IdentityService,
    OutboxService,
    ...ACL_PROVIDERS,
    ...HOOK_PROVIDERS,
    ...DOMAIN_EVENT_PROVIDERS,
    ...JOB_PROVIDERS,
    ...EMAIL_PROVIDERS,
    ...PREFERENCES_PROVIDERS,
    ...LOGIC_PROVIDERS,
    ...SEARCH_PROVIDERS,
    ...REPORT_PROVIDERS,
    ...EXTENSION_PROVIDERS,
    ...WORKFLOW_PROVIDERS,
    ...PROCESS_PROVIDERS,
    // Phase 18: portal ACL policy (delegated to by AclApiService) + portal admin/portal-user services.
    ...PORTAL_PROVIDERS,
    ...PROJECTS_PROVIDERS,
    ...SALES_PROVIDERS,
    ...CUSTOMER_SUCCESS_PROVIDERS,
    ...SERVICE_DESK_PROVIDERS,
    ...MARKETING_AUTOMATION_PROVIDERS,
    // Phase 19-AI: module settings/permission/policy, provider connections and the model gateway.
    ...AI_AGENTS_PROVIDERS,
    // Phase 19-CHAT: the workspace settings row, capability gate, policy, assistant readiness and
    // module health. The module owns no table, queue or adapter of its own.
    ...CRM_CHAT_PROVIDERS,
    // Phase 19-VC: settings, provider registry/accounts, webhook ingress/processing, resolution,
    // consent/policy and the module health/navigation reports.
    ...VOICE_COMMUNICATIONS_PROVIDERS,
    // Phase 19-INT: the permission gate, module settings, provider registry, the credential vault,
    // the connection lifecycle and the OAuth flow.
    ...ADVANCED_INTEGRATIONS_PROVIDERS,
    // Phase 19-ES.1: the capability matrix, the settings document, the module health view, the
    // visibility report and the single gate that stands in front of every provider operation.
    ...ESIGNATURE_PROVIDERS,
    // Phase 19-LS.1: the settings document, the capability matrix, the gate in front of every score and
    // conversion operation, and the module health view. The module owns no table, queue, adapter or
    // navigation entry yet — those arrive with the phases that use them.
    ...LEADSCORE_PROVIDERS,
    ...DOCUMENT_PROVIDERS,
    // Phase 21: the in-app handbook — the content read path and the `docs` settings document's cache.
    ...DOCS_PROVIDERS,
    ...ENTITY_PROVIDERS,
    ...ATTACHMENT_PROVIDERS,
    ...SETTINGS_PROVIDERS,
    ...SETUP_CHECKLIST_PROVIDERS,
    // Phase 20: the settings document registry, the admin panel descriptors and the navigation
    // resolver. `PlatformSettingsRegistrar` registers the platform documents at bootstrap.
    ...ADMIN_PANEL_PROVIDERS,
    // Phase 19-CHAT: the menu pipeline asks a deployment flag before it renders a module page, and
    // the kernel resolves it here instead of importing a domain module. A module this build does not
    // know stays visible — the ACL still decides who may see it.
    //
    // Both factories resolve their target **lazily** through `ModuleRef`, because the dependency runs
    // in a circle by design: `NavigationService` needs the gate, the gate needs the Chat settings row,
    // and the settings row needs the menu invalidator. Resolving inside the returned closure keeps the
    // graph acyclic at construction time.
    {
      provide: NAVIGATION_FEATURE_GATE,
      inject: [ModuleRef],
      useFactory:
        (ref: ModuleRef): NavigationFeatureGate =>
        async (module: string, flag: string) => {
          if (module === 'crmChat' && flag === 'workspace') {
            const chat = ref.get(CRMChatSettingsService, { strict: false });
            return (await chat.settings()).features.workspace;
          }
          // Phase 21: the handbook is a module page with no entity, so its own document decides whether
          // the sidebar carries it. The gate runs after the ACL, so this can only remove an entry.
          if (module === 'docs' && flag === 'showInSidebar') {
            const docs = ref.get(DocsSettingsService, { strict: false });
            return (await docs.settings()).showInSidebar;
          }
          // Phase 19-ES.1: an unconfigured installation must not carry the page at all. The gate runs
          // after the ACL, so switching the module off can only remove the entry, never reveal one.
          if (module === 'eSignature' && flag === 'enabled') {
            const esignature = ref.get(ESignatureSettingsService, { strict: false });
            return (await esignature.settings()).enabled;
          }
          return true;
        },
    },
    // The menu is cached per user for 30 s; a Chat flag write drops it so a disabled module leaves
    // the sidebar on the next render instead of after the TTL (`docs/admin/navigation.md`).
    {
      provide: CRM_CHAT_MENU_INVALIDATOR,
      inject: [ModuleRef],
      useFactory:
        (ref: ModuleRef): MenuInvalidator =>
        () => {
          ref.get(NavigationService, { strict: false }).invalidate();
        },
    },
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
    // The navigation group keys an entity's `nav.group` may name. Owned by the admin panel, handed to
    // the metadata writer through its seam so the dependency keeps pointing at the kernel.
    {
      provide: NAVIGATION_GROUP_KEYS,
      useFactory: (): ReadonlySet<string> => new Set(navigationGroupKeyList()),
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
            id: recordId,
            data: record.data,
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
    // The extension packages are assembled by the bootstrap loader before Nest starts, so the
    // container reads them from the parked host instead of from a mutable static registry
    // (PLAN §38.3). An installation with no `EXTENSIONS_DIR` gets an empty host.
    { provide: EXTENSION_HOST, useFactory: (): ExtensionHostType => extensionHost() },
    // Framework-neutral tokens an extension may inject, so a package never imports this application.
    {
      provide: EXTENSION_DATABASE,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService): ExtensionDb => ({
        query: async <Row>(sql: string, params?: readonly unknown[]) =>
          (await database.pool.query(sql, params as unknown[])).rows as Row[],
      }),
    },
    {
      provide: EXTENSION_ACL,
      inject: [AclApiService, ENTITY_STORE, METADATA_STORE],
      useFactory: (acl: AclApiService, store: PostgresRecordStore): ExtensionAcl => ({
        canAccess: async (entityType, action) => (await acl.canUser(entityType, action)) !== 'no',
        canAccessRecord: async (entityType, action, recordId) => {
          const record = await store.findById(entityType, recordId);
          if (!record) return false;
          const teams = Array.isArray(record.data['teams']) ? (record.data['teams'] as string[]) : undefined;
          const decision = await acl.canAccessRecord(entityType, action, {
            id: recordId,
            data: record.data,
            assignedUserId: record.assignedUserId,
            createdById: record.createdById,
            ...(teams !== undefined ? { teams } : {}),
          });
          return decision.allowed;
        },
      }),
    },
    {
      provide: EXTENSION_METADATA,
      inject: [METADATA_STORE],
      useFactory: (store: MetadataStoreType): ExtensionMetadataLookup => () => store.getMetadata(),
    },
    {
      provide: EXTENSION_JOB_ENQUEUER,
      inject: [JobsService],
      useFactory: (jobs: JobsService): ExtensionJobEnqueuer => async (job, data) => (await jobs.enqueue({ job, data: data ?? {} })).id,
    },
    {
      provide: EXTENSION_PRINCIPAL,
      inject: [REQUEST_SCOPE_TOKEN],
      // Getters, not a snapshot: `RequestScope` is a singleton the auth guard fills per request,
      // so a value captured at boot would answer for whoever was signed in at that moment.
      useFactory: (scope: RequestScope): ExtensionPrincipal => ({
        get userId(): string | undefined {
          return scope.userId;
        },
        get userName(): string | undefined {
          return scope.principal?.userName;
        },
        get userType(): string | undefined {
          return scope.userType;
        },
        get isAdmin(): boolean {
          return scope.isAdmin;
        },
        get roles(): readonly string[] {
          return scope.roleIds();
        },
        get teams(): readonly string[] {
          return scope.teamIds();
        },
      }),
    },
  ],
  exports: [
    DatabaseService,
    AuthService,
    IdentityService,
    I18nService,
    OutboxService,
    REQUEST_SCOPE_TOKEN,
    KERNEL_HOOKS_TOKEN,
    METADATA_STORE,
    AclApiService,
    HookRegistry,
    FormulaService,
    JobsService,
    EXTENSION_HOST,
    EXTENSION_DATABASE,
    EXTENSION_ACL,
    EXTENSION_METADATA,
    EXTENSION_JOB_ENQUEUER,
    EXTENSION_PRINCIPAL,
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
