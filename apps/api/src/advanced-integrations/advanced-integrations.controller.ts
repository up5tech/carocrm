import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, InvalidQueryError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { runAsAdvancedIntegrationsSystem } from './advanced-integrations-authority.js';
import { AdvancedIntegrationsHealthService } from './advanced-integrations-health.service.js';
import { AdvancedIntegrationsNavigationService } from './advanced-integrations-navigation.service.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { ConflictService } from './conflict.service.js';
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';
import { DeadLetterService } from './dead-letter.service.js';
import {
  AuthorizeSchema,
  ConflictResolveSchema,
  ConnectionCreateSchema,
  ConnectionPatchSchema,
  CredentialWriteSchema,
  EmptyBodySchema,
  MappingCreateSchema,
  MappingPatchSchema,
  MappingPreviewSchema,
  OutboundEventSchema,
  OutboundPushSchema,
  SyncRunSchema,
  WebhookProcessSchema,
} from './dto/advanced-integrations-shapes.js';
import { ExternalLinkService } from './external-link.service.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { MappingService } from './mapping.service.js';
import { OAuthFlowService } from './oauth-flow.service.js';
import { OutboundSyncService } from './outbound-sync.service.js';
import { SyncOrchestrator } from './sync-orchestrator.service.js';
import { WebhookIngressService } from './webhook-ingress.service.js';

/**
 * Phase 19-INT.2–19-INT.5 — the `AdvancedIntegrations` control-plane API
 * (`PLAN_Phase_19_Advanced_Integrations.md` §13.1, §13.4; `19-INT.2`).
 *
 * Only the control plane exists here: the provider catalog, connections, credentials, the OAuth
 * flow and the module's own diagnostics. Mapping, sync, conflicts and webhooks arrive with their
 * own sub-phases.
 *
 * Every route checks a capability server-side. Hiding a control in the SPA is never authorization.
 * Every request shape is strict; the controller parses shape, the services enforce policy.
 *
 * Registered before `ENTITY_CONTROLLERS`, so the static `AdvancedIntegrations` prefix can never be
 * swallowed by the generic `:entity` wildcard.
 */
@ApiTags('advanced-integrations')
@Controller('api/v1/AdvancedIntegrations')
export class AdvancedIntegrationsController {
  constructor(
    @Inject(AdvancedIntegrationsHealthService) private readonly health: AdvancedIntegrationsHealthService,
    @Inject(AdvancedIntegrationsPermissionService) private readonly permissions: AdvancedIntegrationsPermissionService,
    @Inject(AdvancedIntegrationsSettingsService) private readonly settings: AdvancedIntegrationsSettingsService,
    @Inject(AdvancedIntegrationsNavigationService) private readonly navigation: AdvancedIntegrationsNavigationService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(OAuthFlowService) private readonly oauth: OAuthFlowService,
    @Inject(MappingService) private readonly mappings: MappingService,
    @Inject(SyncOrchestrator) private readonly orchestrator: SyncOrchestrator,
    @Inject(ConflictService) private readonly conflicts: ConflictService,
    @Inject(DeadLetterService) private readonly deadLetters: DeadLetterService,
    @Inject(ExternalLinkService) private readonly links: ExternalLinkService,
    @Inject(WebhookIngressService) private readonly webhooks: WebhookIngressService,
    @Inject(OutboundSyncService) private readonly outbound: OutboundSyncService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // diagnostics
  // ---------------------------------------------------------------------------

  /** Module diagnostics. The caller must be allowed to use the module at all. */
  @Get('action/health')
  async moduleHealth() {
    await this.permissions.assert('use');
    return this.health.health();
  }

  /**
   * What this caller may do. The SPA renders from this answer; a missing capability means the
   * matching endpoint would refuse the call, not that the UI merely hides a button.
   */
  @Get('action/capabilities')
  async capabilities() {
    await this.permissions.assert('use');
    return { capabilities: await this.permissions.describe() };
  }

  /** The module's own navigation signal. */
  @Get('action/nav')
  async nav() {
    await this.permissions.assert('use');
    return this.navigation.visibility();
  }

  // ---------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------

  @Get('action/settings')
  async readSettings() {
    await this.permissions.assert('settingsAdmin');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('settingsAdmin');
    return this.settings.update(body);
  }

  // ---------------------------------------------------------------------------
  // provider catalog
  // ---------------------------------------------------------------------------

  /** The connector catalog with each connector's capabilities. Never contains a secret. */
  @Get('action/providers')
  async listProviders() {
    await this.permissions.assert('providerAdmin');
    return { list: this.registry.describeAll() };
  }

  @Get('action/providers/:providerKey')
  async getProvider(@Param('providerKey') providerKey: string) {
    await this.permissions.assert('providerAdmin');
    const definition = this.registry.require(providerKey);
    return this.registry.describe(definition);
  }

  // ---------------------------------------------------------------------------
  // connections
  // ---------------------------------------------------------------------------

  @Get('action/connections')
  async listConnections() {
    await this.permissions.assert('use');
    return { list: await this.connections.list() };
  }

  @Post('action/connections')
  async createConnection(@Body() body: unknown) {
    const input = parse(ConnectionCreateSchema, body);
    return this.connections.create({
      providerKey: input.providerKey,
      name: input.name,
      ownerType: input.ownerType,
      ownerId: input.ownerId ?? this.scope.userId ?? 'organization',
      tenantRef: input.tenantRef ?? null,
      ...(input.connectionOptions === undefined ? {} : { connectionOptions: input.connectionOptions }),
    });
  }

  @Get('action/connections/:id')
  async getConnection(@Param('id') id: string) {
    await this.permissions.assert('use');
    return this.connections.get(id);
  }

  @Patch('action/connections/:id')
  async updateConnection(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ConnectionPatchSchema, body);
    return this.connections.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.tenantRef === undefined ? {} : { tenantRef: input.tenantRef }),
      ...(input.connectionOptions === undefined ? {} : { connectionOptions: input.connectionOptions }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    });
  }

  /** Store a credential. The value is write-only — no read path returns it. */
  @Post('action/connections/:id/credentials')
  async storeCredential(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(CredentialWriteSchema, body);
    return this.connections.storeCredential({
      connectionId: id,
      kind: input.kind,
      value: input.value,
      expiresAt: input.expiresAt ?? null,
    });
  }

  @Post('action/connections/:id/pause')
  async pauseConnection(@Param('id') id: string) {
    return this.connections.pause(id);
  }

  @Post('action/connections/:id/resume')
  async resumeConnection(@Param('id') id: string) {
    return this.connections.resume(id);
  }

  @Post('action/connections/:id/revoke')
  async revokeConnection(@Param('id') id: string) {
    return this.oauth.revoke(id);
  }

  @Delete('action/connections/:id')
  async removeConnection(@Param('id') id: string) {
    return this.connections.remove(id);
  }

  // ---------------------------------------------------------------------------
  // authorization
  // ---------------------------------------------------------------------------

  /** Begin an approved OAuth flow where the provider supports one. */
  @Post('action/connections/:id/authorize')
  async authorizeConnection(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(AuthorizeSchema, body);
    return this.oauth.authorize(id, input.scopes);
  }

  /** Start a reauthorization for a connection whose grant is no longer usable. */
  @Post('action/connections/:id/reconnect')
  async reconnectConnection(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(AuthorizeSchema, body);
    return this.oauth.reconnect(id, input.scopes);
  }

  // ---------------------------------------------------------------------------
  // 19-INT.7 — external id links
  // ---------------------------------------------------------------------------

  @Get('action/connections/:id/links')
  async listLinks(@Param('id') id: string) {
    await this.permissions.assert('use');
    return { list: await this.links.list(id) };
  }

  // ---------------------------------------------------------------------------
  // 19-INT.8 — mappings
  // ---------------------------------------------------------------------------

  @Get('action/mappings')
  async listMappings() {
    await this.permissions.assert('use');
    return { list: await this.mappings.listAllActive() };
  }

  @Post('action/mappings')
  async createMapping(@Body() body: unknown) {
    const input = parse(MappingCreateSchema, body);
    return this.mappings.create({
      connectionId: await resolveConnectionId(this.connections, input.providerKey),
      objectType: input.objectType,
      crmEntityType: input.crmEntityType,
      direction: input.direction,
      syncMode: input.syncMode,
      conflictPolicy: input.conflictPolicy,
      deletionPolicy: input.deletionPolicy,
      fieldAuthority: input.fieldAuthority,
      fields: input.fields.map((field) => ({
        sourcePath: field.sourcePath,
        targetField: field.targetField,
        transform: (field.transform ?? null) as never,
        required: field.required,
        direction: field.direction,
      })),
    });
  }

  @Get('action/mappings/:id')
  async getMapping(@Param('id') id: string) {
    await this.permissions.assert('use');
    return this.mappings.get(id);
  }

  @Patch('action/mappings/:id')
  async updateMapping(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(MappingPatchSchema, body);
    return this.mappings.update(id, {
      ...(input.crmEntityType === undefined ? {} : { crmEntityType: input.crmEntityType }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      ...(input.syncMode === undefined ? {} : { syncMode: input.syncMode }),
      ...(input.conflictPolicy === undefined ? {} : { conflictPolicy: input.conflictPolicy }),
      ...(input.deletionPolicy === undefined ? {} : { deletionPolicy: input.deletionPolicy }),
      ...(input.fieldAuthority === undefined ? {} : { fieldAuthority: input.fieldAuthority }),
      ...(input.fields === undefined
        ? {}
        : {
            fields: input.fields.map((field) => ({
              sourcePath: field.sourcePath,
              targetField: field.targetField,
              transform: (field.transform ?? null) as never,
              required: field.required,
              direction: field.direction,
            })),
          }),
    });
  }

  @Post('action/mappings/:id/activate')
  async activateMapping(@Param('id') id: string) {
    return this.mappings.activate(id);
  }

  @Post('action/mappings/:id/retire')
  async retireMapping(@Param('id') id: string) {
    return this.mappings.retire(id);
  }

  /** A dry run: what the mapping would write, without writing it. */
  @Post('action/mappings/:id/preview')
  async previewMapping(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(MappingPreviewSchema, body);
    return this.mappings.preview(id, input.sample);
  }

  // ---------------------------------------------------------------------------
  // 19-INT.9 — sync runs
  // ---------------------------------------------------------------------------

  @Post('action/mappings/:id/sync')
  async runSync(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(SyncRunSchema, body ?? {});
    return this.orchestrator.runInbound(id, {
      ...(input.runType === undefined ? {} : { runType: input.runType }),
      ...(input.triggerSource === undefined ? {} : { triggerSource: input.triggerSource }),
      ...(input.maxRecords === undefined ? {} : { maxRecords: input.maxRecords }),
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
    });
  }

  @Get('action/connections/:id/runs')
  async listRuns(@Param('id') id: string) {
    await this.permissions.assert('use');
    return { list: await this.orchestrator.listRuns(id) };
  }

  @Get('action/runs/:id')
  async getRun(@Param('id') id: string) {
    await this.permissions.assert('use');
    return this.orchestrator.getRun(id);
  }

  @Post('action/runs/:id/cancel')
  async cancelRun(@Param('id') id: string) {
    return this.orchestrator.cancelRun(id);
  }

  // ---------------------------------------------------------------------------
  // 19-INT.10 — conflicts
  // ---------------------------------------------------------------------------

  @Get('action/connections/:id/conflicts')
  async listConflicts(@Param('id') id: string) {
    await this.permissions.assert('use');
    return { list: await this.conflicts.listOpen(id) };
  }

  @Post('action/conflicts/:id/resolve')
  async resolveConflict(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ConflictResolveSchema, body);
    return this.conflicts.resolve(id, input.resolution);
  }

  // ---------------------------------------------------------------------------
  // 19-INT.11 — dead letters
  // ---------------------------------------------------------------------------

  @Get('action/connections/:id/dead-letters')
  async listDeadLetters(@Param('id') id: string) {
    await this.permissions.assert('use');
    return { list: await this.deadLetters.listOpen(id) };
  }

  @Post('action/dead-letters/:id/replay')
  async replayDeadLetter(@Param('id') id: string) {
    return this.deadLetters.markReplayed(id);
  }

  // ---------------------------------------------------------------------------
  // 19-INT.12 — webhook deliveries
  // ---------------------------------------------------------------------------

  @Get('action/connections/:id/webhook-deliveries')
  async listWebhookDeliveries(@Param('id') id: string) {
    await this.permissions.assert('use');
    return { list: await this.webhooks.listDeliveries(id) };
  }

  // ---------------------------------------------------------------------------
  // 19-INT.13 — outbound operations
  // ---------------------------------------------------------------------------

  @Get('action/connections/:id/outbound')
  async listOutbound(@Param('id') id: string) {
    await this.permissions.assert('use');
    return { list: await this.outbound.listOperations(id) };
  }

  // ---------------------------------------------------------------------------
  // worker-authorized operations
  //
  // The worker has no user session, so `@Public()` skips session authentication and the shared
  // worker→API capability in `x-worker-secret` is the authorisation — compared in constant time and
  // refused when no capability is configured.
  // ---------------------------------------------------------------------------

  /**
   * A CRM domain event, delivered by the worker.
   *
   * The worker has no session, so the shared worker→API capability is the authorisation. The
   * endpoint turns the event into outbound operations, and the echo guard decides whether the
   * provider should hear about it at all.
   */
  @HttpCode(200)
  @Post('action/outbound-event')
  async outboundEvent(@Headers('x-worker-secret') secret: string | undefined, @Body() body: unknown) {
    this.assertWorkerSecret(secret);
    const input = parse(OutboundEventSchema, body);
    return runAsAdvancedIntegrationsSystem(this.scope, 'outbound-event', () =>
      this.outbound.handleEvent({
        eventId: input.eventId,
        eventType: input.eventType,
        entityType: input.entityType,
        entityId: input.entityId,
      }),
    );
  }

  /**
   * Process one verified provider callback.
   *
   * The worker calls this after the ingress recorded the delivery. The receipt's status is the
   * idempotency guard, so a retried job does not apply the event twice.
   */
  @HttpCode(200)
  @Post('action/process-webhook-event')
  async processWebhookEvent(@Headers('x-worker-secret') secret: string | undefined, @Body() body: unknown) {
    this.assertWorkerSecret(secret);
    const input = parse(WebhookProcessSchema, body);
    return runAsAdvancedIntegrationsSystem(this.scope, 'process-webhook-event', () =>
      this.webhooks.processDelivery({
        connectionId: input.connectionId,
        deliveryId: input.deliveryId,
        providerKey: input.providerKey,
        objectType: input.objectType,
        externalId: input.externalId,
        eventType: input.eventType,
      }),
    );
  }

  /** Push one queued outbound operation to the provider. */
  @HttpCode(200)
  @Post('action/push-outbound')
  async pushOutbound(@Headers('x-worker-secret') secret: string | undefined, @Body() body: unknown) {
    this.assertWorkerSecret(secret);
    const input = parse(OutboundPushSchema, body);
    return runAsAdvancedIntegrationsSystem(this.scope, 'push-outbound', () => this.outbound.push(input.operationId));
  }

  @HttpCode(200)
  @Post('action/notify-expiring-credentials')
  async notifyExpiringCredentials(@Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    // The worker has no session; the sweep runs under the documented service authority.
    return runAsAdvancedIntegrationsSystem(this.scope, 'notify-expiring-credentials', () =>
      this.oauth.notifyExpiringCredentials(),
    );
  }

  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === '' || supplied === undefined) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
  }
}

/**
 * The connection a provider key names.
 *
 * The mapping builder addresses a connection by its provider and the connection's name; the
 * caller must be allowed to see it, so the lookup goes through the connection service.
 */
async function resolveConnectionId(
  connections: ConnectionLifecycleService,
  providerKey: string,
): Promise<string> {
  const all = await connections.list();
  const found = all.find((connection) => connection.providerKey === providerKey);
  if (!found) {
    throw new ValidationError(`No connection for provider "${providerKey}" exists.`, { providerKey });
  }
  return found.id;
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError('The request is not valid.', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return parsed.data;
}

export { EmptyBodySchema };
