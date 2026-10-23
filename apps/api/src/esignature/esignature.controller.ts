import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { Public } from '../auth/auth.guard.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import {
  ArtifactRetrieveSchema,
  ConnectionAuthorizeSchema,
  ConnectionCreateSchema,
  ConnectionSecretSchema,
  ConnectionUpdateSchema,
  ESignatureReportQuerySchema,
  OperationProbeSchema,
  OperationsQuerySchema,
  RecordEntryQuerySchema,
  SettingsPatchSchema,
  WebhookProcessSchema,
} from './dto/esignature-shapes.js';
import { runAsESignatureSystem } from './esignature-authority.js';
import { ESignatureConnectionService } from './esignature-connection.service.js';
import { ESIGNATURE_OPERATIONS,ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { ESignatureModuleHealthService } from './esignature-module-health.service.js';
import { ESignatureNavigationService } from './esignature-navigation.service.js';
import { ESignatureOperationsService } from './esignature-operations.service.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureRecordEntryService } from './esignature-record-entry.service.js';
import { ESignatureReportService } from './esignature-report.service.js';
import { ESignatureRequestService } from './esignature-request.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { ESignatureWebhookService } from './esignature-webhook.service.js';
import { SIGNATURE_PROVIDER_CATALOG } from './providers/signature-provider.catalog.js';

/**
 * Phase 19-ES.1 — the `ESignature` control-plane API
 * (`PLAN_Phase_19_ESignature.md` §8.1, §12, §18 `19-ES.1`).
 *
 * Only the control plane exists at this phase: identity, the caller's capabilities, the security
 * policy, and a probe of the gate that stands in front of every provider call. Requests,
 * recipients, documents, connections and the Connect endpoint arrive with their own sub-phases
 * (§18), and each will pass through the same two services rather than re-implementing a check.
 *
 * Every route checks a capability server-side; hiding a control in the SPA is never authorization.
 * A route that would contact the provider calls `ESignatureConnectionGate.assertOperation` first, so
 * "no provider operations are possible before a connection is enabled" is enforced in one place
 * instead of being remembered per endpoint.
 *
 * Registered before `ENTITY_CONTROLLERS`, so the static `ESignature` prefix can never be swallowed
 * by the generic `/api/v1/:entity` wildcard.
 */
@ApiTags('esignature')
@Controller('api/v1/ESignature')
export class ESignatureController {
  constructor(
    @Inject(ESignatureModuleHealthService) private readonly health: ESignatureModuleHealthService,
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(ESignatureNavigationService) private readonly navigation: ESignatureNavigationService,
    @Inject(ESignatureConnectionGate) private readonly gate: ESignatureConnectionGate,
    @Inject(ESignatureConnectionService) private readonly connections: ESignatureConnectionService,
    @Inject(ESignatureWebhookService) private readonly webhooks: ESignatureWebhookService,
    @Inject(ESignatureRequestService) private readonly requests: ESignatureRequestService,
    @Inject(ESignatureRecordEntryService) private readonly recordEntry: ESignatureRecordEntryService,
    @Inject(ESignatureReportService) private readonly reports: ESignatureReportService,
    @Inject(ESignatureOperationsService) private readonly ops: ESignatureOperationsService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Module health: the platform foundation, the feature state, the gate and the checks. */
  @Get('action/health')
  async moduleHealth() {
    await this.permissions.assert('use');
    return this.health.health();
  }

  /**
   * What this caller may do, and what the first provider can do.
   *
   * The SPA renders from this answer; a missing capability means the matching endpoint would refuse
   * the call, not that the UI merely hides a button (plan §12.1).
   */
  @Get('action/capabilities')
  async capabilities() {
    await this.permissions.assert('use');
    return {
      capabilities: await this.permissions.describe(),
      provider: await this.gate.assessment(),
    };
  }

  /** The module's own navigation signal. */
  @Get('action/nav')
  async nav() {
    await this.permissions.assert('use');
    return this.navigation.visibility();
  }

  /**
   * The provider catalog: which e-signature providers this build knows, how each authenticates and
   * whether its integration is installed.
   *
   * The admin screen builds its provider picker from this answer instead of hard-coding a vendor.
   * It is readable with `connectionRead` and carries no credential — the client id in settings is
   * public, and the matching secret never leaves the vault.
   */
  @Get('action/provider-catalog')
  async providerCatalog() {
    await this.permissions.assert('connectionRead');
    return { providers: SIGNATURE_PROVIDER_CATALOG };
  }

  // ---------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------

  /**
   * The validated settings document with its warnings, its pending phases and its defaults.
   *
   * The same right as the write, like `AdvancedIntegrations`: the document is the security policy —
   * feature switches, document ceilings, the approval policy, the embedded return-host allowlist — and
   * a policy is administered, not browsed. A user's own screens read the effective answer from
   * `action/capabilities` and `action/nav`, and no field here can ever be a secret.
   */
  @Get('action/settings')
  async readSettings() {
    await this.permissions.assert('connectionManage');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('connectionManage');
    return this.settings.update(this.parse(SettingsPatchSchema, body));
  }

  // ---------------------------------------------------------------------------
  // connections (19-ES.4)
  // ---------------------------------------------------------------------------

  /**
   * The provider connections an administrator can see.
   *
   * The capability check lives in the service, not here — and it is `connectionRead`, not `use`: this
   * answer names the provider account the CRM would send documents through and inventories which
   * credentials are stored. A signature user has no business reading either (plan §12).
   */
  @Get('connections')
  async listConnections() {
    return this.connections.list();
  }

  @Get('connections/:id')
  async getConnection(@Param('id') id: string) {
    return this.connections.get(this.parseId(id));
  }

  /**
   * Create a connection and store its client secret in the same call.
   *
   * The response is the redacted view: the secret that was just written is not in it, and cannot be
   * read back from anywhere in this module (plan §8.1).
   */
  @HttpCode(201)
  @Post('connections')
  async createConnection(@Body() body: unknown) {
    const input = this.parse(ConnectionCreateSchema, body);
    return this.connections.create(input);
  }

  @HttpCode(200)
  @Patch('connections/:id')
  async updateConnection(@Param('id') id: string, @Body() body: unknown) {
    return this.connections.update(this.parseId(id), this.parse(ConnectionUpdateSchema, body));
  }

  /** Write-only credential rotation. The value goes to the vault and is never returned. */
  @HttpCode(200)
  @Post('connections/:id/secret')
  async storeConnectionSecret(@Param('id') id: string, @Body() body: unknown) {
    const { kind, value } = this.parse(ConnectionSecretSchema, body);
    return this.connections.storeSecret(this.parseId(id), kind, value);
  }

  /**
   * Begin the DocuSign authorization flow: returns the URL the browser is sent to.
   *
   * This is the bootstrap path, so it is deliberately not gated by an existing connection — the guard
   * is the capability plus the module and feature switches inside the service.
   */
  @HttpCode(200)
  @Post('connections/:id/authorize')
  async authorizeConnection(@Param('id') id: string, @Body() body: unknown) {
    const { scopes } = this.parse(ConnectionAuthorizeSchema, body);
    return this.connections.authorize(this.parseId(id), scopes);
  }

  /**
   * Re-authorize a connection whose consent expired, was revoked, or was never sufficient.
   *
   * The same flow as `authorize`, as its own verb because the administrator's *reason* differs and the
   * audit trail records which action was taken (plan §9.2).
   */
  @HttpCode(200)
  @Post('connections/:id/re-authorize')
  async reauthorizeConnection(@Param('id') id: string, @Body() body: unknown) {
    const { scopes } = this.parse(ConnectionAuthorizeSchema, body);
    return this.connections.authorize(this.parseId(id), scopes);
  }

  /** Test Connection: the gate decides admission, then the bound adapter answers. Performs no write. */
  @HttpCode(200)
  @Post('connections/:id/test')
  async testConnection(@Param('id') id: string) {
    return this.connections.test(this.parseId(id));
  }

  /** The operator's switch, split into two verbs because the audit action is different either way. */
  @HttpCode(200)
  @Post('connections/:id/enable')
  async enableConnection(@Param('id') id: string) {
    return this.connections.setActive(this.parseId(id), true);
  }

  @HttpCode(200)
  @Post('connections/:id/disable')
  async disableConnection(@Param('id') id: string) {
    return this.connections.setActive(this.parseId(id), false);
  }

  /**
   * Disconnect: destroy the stored credentials, then soft-delete the connection.
   *
   * History survives (plan §21.12); the answer says whether this connection had requests, so an
   * administrator learns what they just stopped before they learn it from a support ticket.
   */
  @HttpCode(200)
  @Post('connections/:id/disconnect')
  async disconnectConnection(@Param('id') id: string) {
    return this.connections.disconnect(this.parseId(id));
  }

  // ---------------------------------------------------------------------------
  // the gate
  // ---------------------------------------------------------------------------

  /**
   * Ask the gate what it would answer for one adapter operation, and let it refuse in the caller's
   * own stable error.
   *
   * This is the security contract made inspectable: an operator or a test can prove that a send, a
   * recipient view or a download is refused before a connection is enabled, without any code path
   * that could reach DocuSign. It performs no provider call of its own.
   */
  @HttpCode(200)
  @Post('action/gate/check')
  async checkOperation(@Body() body: unknown) {
    const { operation, providerKey } = this.parse(OperationProbeSchema, body);
    await this.gate.assertOperation(operation, providerKey);
    return { operation, providerKey: providerKey ?? null, admitted: true };
  }

  /** The operation names the gate knows, so a client never guesses a string. */
  @Get('action/gate/operations')
  async operations() {
    await this.permissions.assert('use');
    return { operations: ESIGNATURE_OPERATIONS, provider: this.scope.userType ?? 'user' };
  }

  /**
   * The entry point a CRM record detail page asks for (ES.18).
   *
   * A 200 answer with `available: false` is deliberate: the generic record component must hide itself
   * for a caller without the module right, a disabled module, an unsupported entity or a record whose
   * ACL the caller cannot pass — without turning a normal "no" into an error state on every page.
   */
  @Get('action/record-entry')
  async recordEntryPoint(@Query() query: unknown) {
    const parsed = this.parse(RecordEntryQuerySchema, query);
    return this.recordEntry.entry(parsed.entityType, parsed.recordId);
  }

  // ---------------------------------------------------------------------------
  // operational reports (19-ES.19)
  // ---------------------------------------------------------------------------

  /**
   * Every curated aggregate in one answer, for the module's reporting screen.
   *
   * Each section names its own timestamp semantics; the record scope is applied in SQL before any
   * row is counted, and the projection carries no recipient, document or message detail.
   */
  @Get('action/reports')
  async reportOverview(@Query() query: unknown) {
    return this.reports.overview(this.parse(ESignatureReportQuerySchema, query));
  }

  /** One aggregate by key — the shape the dashboard's `esignature` dashlet consumes. */
  @Get('action/reports/:key')
  async reportSection(@Param('key') key: string, @Query() query: unknown) {
    return this.reports.section(key, this.parse(ESignatureReportQuerySchema, query));
  }

  // ---------------------------------------------------------------------------
  // recovery workbench (19-ES.20)
  // ---------------------------------------------------------------------------

  /**
   * Connection health, webhook diagnostics and the recovery queues in one bounded answer.
   *
   * Reads the database, the redacted credential metadata and no provider endpoint. Request rows are
   * filtered by the caller's own `SignatureRequest` record scope, so a connection operator cannot
   * enumerate requests they could not open.
   */
  @Get('action/operations')
  async operationsOverview(@Query() query: unknown) {
    return this.ops.overview(this.parse(OperationsQuerySchema, query));
  }

  /**
   * Retry applying one verified webhook delivery that failed or dead-lettered.
   *
   * This is not a resend: no provider call is made and no send is re-attempted. The delivery keeps
   * its dedup key and the projection stays monotonic, so a repeated retry is harmless. Unverified
   * deliveries are refused by name.
   */
  @HttpCode(200)
  @Post('action/operations/webhooks/:id/retry')
  async retryWebhookDelivery(@Param('id') id: string) {
    return this.webhooks.retryDelivery(this.operationId(id));
  }

  // ---------------------------------------------------------------------------
  // worker-authorized operations (19-ES.11+)
  // ---------------------------------------------------------------------------

  /**
   * Apply one durably accepted Connect delivery.
   *
   * The worker has no user session, so `@Public()` skips session authentication and the shared
   * worker→API capability is the authorisation, compared in constant time. The inbox row is the
   * idempotency key: a retried job can call this again and the second answer is "already processed".
   */
  @Public()
  @HttpCode(200)
  @Post('action/process-provider-webhook')
  async processProviderWebhook(@Headers('x-worker-secret') secret: string | undefined, @Body() body: unknown) {
    this.assertWorkerSecret(secret);
    const { inboxId } = this.parse(WebhookProcessSchema, body);
    return runAsESignatureSystem(this.scope, 'process-webhook', () => this.webhooks.processDelivery(inboxId));
  }

  /**
   * Retrieve a completed request's signed documents and completion certificate.
   *
   * The job is enqueued when a completion event is projected; an operator may also trigger it. The
   * command is idempotent, so a redelivered job stores nothing new.
   */
  @Public()
  @HttpCode(200)
  @Post('action/retrieve-artifacts')
  async retrieveArtifactsForWorker(@Headers('x-worker-secret') secret: string | undefined, @Body() body: unknown) {
    this.assertWorkerSecret(secret);
    const { requestId } = this.parse(ArtifactRetrieveSchema, body);
    return runAsESignatureSystem(this.scope, 'retrieve-artifacts', () => this.requests.retrieveCompletedArtifacts(requestId));
  }

  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === '' || supplied === undefined) throw new AuthenticationFailedError('Invalid worker capability.');
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
  }

  private parse<T extends ZodTypeAny>(schema: T, value: unknown): T['_output'] {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError('Invalid ESignature request.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return parsed.data;
  }

  /**
   * A connection id from the path.
   *
   * Shape only — the repository's own `findById` decides whether the row exists, and an unknown id is a
   * refusal rather than a hint about which ids this installation holds.
   */
  private parseId(value: string): string {
    const id = value.trim();
    if (id === '' || id.length > 64) {
      throw new InvalidQueryError('Invalid ESignature request.', { issues: [{ path: 'id', message: 'A connection identifier is at most 64 characters.' }] });
    }
    return id;
  }

  private operationId(value: string): string {
    const id = value.trim();
    if (id === '' || id.length > 64) {
      throw new InvalidQueryError('Invalid ESignature request.', {
        issues: [{ path: 'id', message: 'An operations record identifier is at most 64 characters.' }],
      });
    }
    return id;
  }
}
