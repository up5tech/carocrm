import { Inject, Injectable } from '@nestjs/common';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { ESignatureConnectionService, type SignatureConnectionView } from './esignature-connection.service.js';
import type { ESignatureStoredCredential } from './esignature-credential-vault.js';
import { ESignatureCredentialVault } from './esignature-credential-vault.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { SignatureConnectionRepository } from './signature-connection.repository.js';
import {
  type FailedJobList,
  type RecoveryRequestList,
  SignatureOperationsRepository,
} from './signature-operations.repository.js';
import type { RequestAccessScope } from './signature-request.repository.js';
import {
  type SignatureWebhookDelivery,
  SignatureWebhookInboxRepository,
  type WebhookInboxDiagnostics,
} from './signature-webhook-inbox.repository.js';

/**
 * Phase 19-ES.20 — the admin operations and recovery read model
 * (`PLAN_Phase_19_ESignature.md` §14, §16, §18 `19-ES.20`).
 *
 * The workbench answers three questions without ever calling the provider:
 *
 *  1. **Is a connection usable, and if not, why?** A redacted token/webhook/credential inventory plus
 *     the last API and webhook stamps. Nothing here is a secret; the credential vault is read for
 *     *metadata* only.
 *  2. **What is waiting, failed or drifting?** Four request queues (failed, stuck, send-unknown,
 *     reconciliation), the webhook inbox states and failed module jobs. Request rows obey the
 *     caller's `SignatureRequest` record scope, so an operator without a broad request role cannot
 *     enumerate ids outside it.
 *  3. **What can be done about it?** Retry is offered **only** for an inbound webhook delivery whose
 *     signature verified. There is deliberately no "retry send": a request in trouble can only be
 *     reconciled against the provider (or recovered and sent again deliberately from its detail
 *     page), which is what makes the duplicate-send acceptance criterion structural.
 *
 * Provider health is derived from persisted stamps (`lastSuccessfulApiAt`, `lastErrorAt`) rather than
 * a live probe: opening this screen during a provider outage must not create load on the provider or
 * fail the page, and unrelated CRM features never depend on this module's provider.
 */

export interface OperationsQuery {
  readonly staleAfterHours: number;
  readonly limit: number;
}

export interface OperationCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ConnectionHealthView {
  readonly id: string;
  readonly name: string;
  readonly providerKey: string;
  readonly environment: string;
  readonly status: string;
  readonly isActive: boolean;
  readonly accountName: string | null;
  readonly adapterMode: string;
  readonly consentStatus: string;
  readonly pendingAuthorization: boolean;
  readonly token: {
    readonly state: 'missing' | 'valid' | 'expiring' | 'expired' | 'reauthorization_required';
    readonly expiresAt: string | null;
    readonly hasRefreshToken: boolean;
    readonly hasClientSecret: boolean;
  };
  readonly webhook: {
    readonly configured: boolean;
    readonly lastReceivedAt: string | null;
    readonly pending: number;
    readonly retryable: number;
    readonly deadLetter: number;
    readonly invalid: number;
  };
  readonly requests: Readonly<Record<string, number>>;
  readonly lastSuccessfulApiAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly issues: readonly string[];
  readonly health: 'ok' | 'attention' | 'blocked';
}

export interface WebhookDeliveryView {
  readonly id: string;
  readonly connectionId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly state: string;
  readonly signatureStatus: string;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly attemptCount: number;
  readonly lastErrorSafe: string | null;
  readonly contentLength: number;
  readonly correlationId: string | null;
  readonly retryAllowed: boolean;
}

export interface WebhookDiagnosticsView extends WebhookInboxDiagnostics {
  readonly pendingLagMinutes: number | null;
  readonly deliveries: readonly WebhookDeliveryView[];
}

export interface OperationsOverview {
  readonly generatedAt: string;
  readonly moduleEnabled: boolean;
  readonly webhooksEnabled: boolean;
  readonly requestAccess: 'all' | 'team' | 'own' | 'none';
  readonly connections: readonly ConnectionHealthView[];
  readonly webhook: WebhookDiagnosticsView;
  readonly worklists: {
    readonly failed: RecoveryRequestList;
    readonly stuck: RecoveryRequestList;
    readonly sendUnknown: RecoveryRequestList;
    readonly reconciliation: RecoveryRequestList;
  };
  readonly failedJobs: FailedJobList;
  readonly checks: readonly OperationCheck[];
  readonly actions: { readonly canRetryWebhook: boolean; readonly canReconcile: boolean };
}

const RECENT_ERROR_MS = 15 * 60_000;
const CREDENTIAL_MAX_AGE_DAYS = 180;

@Injectable()
export class ESignatureOperationsService {
  constructor(
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(ESignatureConnectionService) private readonly connectionViews: ESignatureConnectionService,
    @Inject(SignatureConnectionRepository) private readonly connections: SignatureConnectionRepository,
    @Inject(SignatureWebhookInboxRepository) private readonly inbox: SignatureWebhookInboxRepository,
    @Inject(SignatureOperationsRepository) private readonly operations: SignatureOperationsRepository,
    @Inject(ESignatureCredentialVault) private readonly vault: ESignatureCredentialVault,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async overview(query: OperationsQuery): Promise<OperationsOverview> {
    await this.permissions.assert('connectionRead');
    const settings = await this.settings.read();
    const webhooksEnabled = settings.settings.enabled === true && settings.effective.webhooks === true;
    const level = await this.permissions.level('use');
    const canUse = level !== 'no';
    const canManage = (await this.permissions.can('connectionManage'));
    const canSend = await this.permissions.can('send');
    const access = canUse ? this.accessScope(level) : null;

    const [views, requestCounts, webhookCounts, diagnostics, deliveries, failedJobs, checks] = await Promise.all([
      this.connectionViews.list(),
      this.operations.requestCountsByConnection(),
      this.operations.webhookCountsByConnection(),
      this.inbox.diagnostics(),
      this.inbox.listProblemDeliveries(query.limit),
      this.operations.failedJobs(query.limit),
      this.healthChecks(),
    ]);

    const connections = views.map((view) =>
      toConnectionHealth(view, requestCounts.get(view.id) ?? {}, webhookCounts.get(view.id), settings, webhooksEnabled),
    );
    const empty: RecoveryRequestList = { items: [], count: 0 };
    const worklists = access === null
      ? { failed: empty, stuck: empty, sendUnknown: empty, reconciliation: empty }
      : {
          failed: await this.operations.requests('failed', access, query),
          stuck: await this.operations.requests('stuck', access, query),
          sendUnknown: await this.operations.requests('sendUnknown', access, query),
          reconciliation: await this.operations.requests('reconciliation', access, query),
        };

    const pendingLagMinutes = lagMinutes(diagnostics.oldestPendingAt);
    return {
      generatedAt: new Date().toISOString(),
      moduleEnabled: settings.settings.enabled === true,
      webhooksEnabled,
      requestAccess: access?.kind ?? 'none',
      connections,
      webhook: {
        ...diagnostics,
        pendingLagMinutes,
        deliveries: deliveries.map((delivery) => toDeliveryView(delivery, canManage && webhooksEnabled)),
      },
      worklists,
      failedJobs,
      checks,
      actions: {
        // Retry is an inbound-event action only. The SPA receives this flag so it never renders a
        // control the server would refuse; the server checks again on the command.
        canRetryWebhook: canManage && webhooksEnabled,
        canReconcile: canUse && canSend,
      },
    };
  }

  /**
   * The new ES.20 health checks.
   *
   * No `connectionRead` assertion: `/action/health` is already gated by `use` and this method returns
   * counts and ages only — no connection name, account id, credential detail or request id. The
   * workbench calls it after its own `connectionRead` check.
   */
  async healthChecks(): Promise<OperationCheck[]> {
    const settings = await this.settings.read();
    const connections = await this.connections.list();
    const credentials = new Map<string, readonly ESignatureStoredCredential[]>();
    for (const connection of connections) credentials.set(connection.id, await this.vault.list(connection.id));
    const active = connections.filter((connection) => connection.status === 'connected' && connection.isActive);
    const activeKind = (connectionId: string, kind: ESignatureStoredCredential['kind']): boolean =>
      (credentials.get(connectionId) ?? []).some((entry) => entry.kind === kind && entry.state === 'active');

    const reauthorization = connections.filter((connection) => connection.status === 'reauthorization_required').length;
    const activeWithoutRefresh = active.filter((connection) => !activeKind(connection.id, 'oauth_refresh_token')).length;
    const tokenRefreshOk = reauthorization === 0 && activeWithoutRefresh === 0;
    const tokenRefreshDetail =
      reauthorization === 0 && activeWithoutRefresh === 0
        ? 'Every active connection holds a refresh token; no consent needs renewal.'
        : `${String(reauthorization)} connection(s) require reauthorization; ${String(activeWithoutRefresh)} active connection(s) hold no refresh token.`;

    const webhooksEffective = settings.settings.enabled === true && settings.effective.webhooks === true;
    const missingWebhookSecrets =
      webhooksEffective && settings.settings.webhooks.requireHmac
        ? active.filter((connection) => !activeKind(connection.id, 'webhook_secret')).length
        : 0;
    const webhookSecretsOk = missingWebhookSecrets === 0;
    const webhookSecretsDetail = !webhooksEffective
      ? 'Connect intake is switched off; a webhook secret is not required.'
      : settings.settings.webhooks.requireHmac
        ? missingWebhookSecrets === 0
          ? 'Every active connection has a Connect HMAC secret.'
          : `${String(missingWebhookSecrets)} active connection(s) have no Connect HMAC secret; their deliveries cannot be verified.`
        : 'HMAC verification is deliberately off; deliveries are accepted without a secret.';

    const now = Date.now();
    const recentErrors = connections.filter((connection) => {
      if (connection.lastErrorAt === null) return false;
      const at = new Date(connection.lastErrorAt).getTime();
      if (!Number.isFinite(at) || now - at > RECENT_ERROR_MS) return false;
      return connection.lastSuccessfulApiAt === null || new Date(connection.lastSuccessfulApiAt).getTime() < at;
    }).length;
    const providerErrorsOk = recentErrors === 0;
    const providerErrorsDetail =
      connections.length === 0
        ? 'No provider connection is configured; unrelated CRM features continue to work.'
        : recentErrors === 0
          ? 'No recent provider API failure is recorded.'
          : `${String(recentErrors)} connection(s) recorded a provider API failure in the last 15 minutes; check the provider status page before retrying.`;

    const inbox = await this.inbox.diagnostics();
    const pendingLag = lagMinutes(inbox.oldestPendingAt);
    const inboxOk = inbox.countsByState.dead_letter === 0 && (pendingLag === null || pendingLag <= 30);
    const inboxDetail =
      inbox.total === 0
        ? 'No Connect delivery has been received yet.'
        : `${String(inbox.countsByState.received + inbox.countsByState.retryable)} pending, ${String(inbox.countsByState.dead_letter)} dead-letter; oldest pending ${pendingLag === null ? 'none' : `${String(pendingLag)} min`}.`;

    const rotatedAt = connections.flatMap((connection) =>
      (credentials.get(connection.id) ?? [])
        .filter((entry) => entry.state === 'active')
        .map((entry) => entry.rotatedAt ?? entry.createdAt),
    );
    const oldestAgeDays = rotatedAt.reduce((oldest, value) => {
      const age = (now - new Date(value).getTime()) / 86_400_000;
      return Number.isFinite(age) ? Math.max(oldest, age) : oldest;
    }, 0);
    const credentialAgeOk = oldestAgeDays <= CREDENTIAL_MAX_AGE_DAYS;
    const credentialAgeDetail =
      rotatedAt.length === 0
        ? 'No credential is stored yet.'
        : `${String(Math.round(oldestAgeDays))} day(s) since the oldest active credential was stored or rotated (rotation runbook target: ${String(CREDENTIAL_MAX_AGE_DAYS)} days).`;

    return [
      { name: 'token_refresh', ok: tokenRefreshOk, detail: tokenRefreshDetail },
      { name: 'webhook_secrets', ok: webhookSecretsOk, detail: webhookSecretsDetail },
      { name: 'provider_errors', ok: providerErrorsOk, detail: providerErrorsDetail },
      { name: 'webhook_inbox', ok: inboxOk, detail: inboxDetail },
      { name: 'credential_age', ok: credentialAgeOk, detail: credentialAgeDetail },
    ];
  }

  private accessScope(level: string): RequestAccessScope {
    const userId = this.scope.userId ?? '';
    return level === 'all' || level === 'yes'
      ? { kind: 'all', userId, teamIds: [] }
      : { kind: level === 'team' ? 'team' : 'own', userId, teamIds: this.scope.teamIds() };
  }
}

function toConnectionHealth(
  view: SignatureConnectionView,
  requests: Record<string, number>,
  webhook:
    | { pending: number; retryable: number; deadLetter: number; invalid: number; lastReceivedAt: string | null }
    | undefined,
  settings: Awaited<ReturnType<ESignatureSettingsService['read']>>,
  webhooksEnabled: boolean,
): ConnectionHealthView {
  const active = view.credentials.filter((entry) => entry.state === 'active');
  const kinds = new Set(active.map((entry) => entry.kind));
  const tokenState = tokenStateOf(view);
  const webhookConfigured = kinds.has('webhook_secret');
  const lastErrorAt = view.lastErrorAt === null ? null : new Date(view.lastErrorAt);
  const recentError =
    lastErrorAt !== null &&
    Number.isFinite(lastErrorAt.getTime()) &&
    Date.now() - lastErrorAt.getTime() <= RECENT_ERROR_MS &&
    (view.lastSuccessfulApiAt === null || new Date(view.lastSuccessfulApiAt) < lastErrorAt);

  const issues: string[] = [];
  if (!view.isActive) issues.push('inactive');
  if (view.status === 'reauthorization_required') issues.push('reauthorization_required');
  else if (view.status === 'error') issues.push('connection_error');
  else if (view.status === 'not_connected') issues.push('not_connected');
  else if (view.status === 'disabled') issues.push('disabled');
  if (tokenState === 'missing') issues.push('token_missing');
  else if (tokenState === 'expired') issues.push('token_expired');
  else if (tokenState === 'expiring') issues.push('token_expiring');
  if (!view.hasRefreshToken) issues.push('no_refresh_token');
  if (webhooksEnabled && settings.settings.webhooks.requireHmac && !webhookConfigured) issues.push('no_webhook_secret');
  if (recentError) issues.push('recent_provider_error');
  if ((webhook?.deadLetter ?? 0) > 0) issues.push('webhook_dead_letter');
  if ((webhook?.retryable ?? 0) > 0) issues.push('webhook_retryable');

  const blocked = view.status !== 'connected' || !view.isActive;
  return {
    id: view.id,
    name: view.name,
    providerKey: view.providerKey,
    environment: view.environment,
    status: view.status,
    isActive: view.isActive,
    accountName: view.accountName,
    adapterMode: view.adapterMode,
    consentStatus: view.consentStatus,
    pendingAuthorization: view.pendingAuthorization,
    token: {
      state: tokenState,
      expiresAt: view.accessTokenExpiresAt,
      hasRefreshToken: view.hasRefreshToken,
      hasClientSecret: view.hasClientSecret,
    },
    webhook: {
      configured: webhookConfigured,
      lastReceivedAt: webhook?.lastReceivedAt ?? view.lastWebhookAt,
      pending: webhook?.pending ?? 0,
      retryable: webhook?.retryable ?? 0,
      deadLetter: webhook?.deadLetter ?? 0,
      invalid: webhook?.invalid ?? 0,
    },
    requests,
    lastSuccessfulApiAt: view.lastSuccessfulApiAt,
    lastErrorAt: view.lastErrorAt,
    lastErrorCode: view.lastErrorCode,
    issues,
    health: blocked ? 'blocked' : issues.length === 0 ? 'ok' : 'attention',
  };
}

function tokenStateOf(view: SignatureConnectionView): ConnectionHealthView['token']['state'] {
  if (view.status === 'reauthorization_required') return 'reauthorization_required';
  if (view.accessTokenExpiresAt === null) return 'missing';
  const expiresAt = new Date(view.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return 'missing';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'expired';
  if (remaining <= 15 * 60_000) return 'expiring';
  return 'valid';
}

function toDeliveryView(delivery: SignatureWebhookDelivery, canRetry: boolean): WebhookDeliveryView {
  return {
    id: delivery.id,
    connectionId: delivery.connectionId,
    providerEnvelopeId: delivery.providerEnvelopeId,
    state: delivery.state,
    signatureStatus: delivery.signatureStatus,
    receivedAt: delivery.receivedAt,
    processedAt: delivery.processedAt,
    attemptCount: delivery.attemptCount,
    lastErrorSafe: delivery.lastErrorSafe,
    contentLength: delivery.contentLength,
    correlationId: delivery.correlationId,
    retryAllowed:
      canRetry &&
      delivery.signatureStatus !== 'invalid' &&
      (delivery.state === 'retryable' || delivery.state === 'dead_letter'),
  };
}

function lagMinutes(iso: string | null): number | null {
  if (iso === null) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.round(Math.max(0, (Date.now() - at) / 60_000) * 10) / 10;
}
