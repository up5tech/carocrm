import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
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
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';
import {
  AuthorizeSchema,
  ConnectionCreateSchema,
  ConnectionPatchSchema,
  CredentialWriteSchema,
  EmptyBodySchema,
} from './dto/advanced-integrations-shapes.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { OAuthFlowService } from './oauth-flow.service.js';

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
  // worker-authorized operations
  //
  // The worker has no user session, so `@Public()` skips session authentication and the shared
  // worker→API capability in `x-worker-secret` is the authorisation — compared in constant time and
  // refused when no capability is configured.
  // ---------------------------------------------------------------------------

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
