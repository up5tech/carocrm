import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { ConflictService } from './conflict.service.js';
import { ConnectionLifecycleService, type IntegrationConnectionView } from './connection-lifecycle.service.js';
import { DeadLetterService } from './dead-letter.service.js';
import { crmFieldsOf,type CrmFieldView } from './integration-fields.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { MappingService } from './mapping.service.js';
import { SyncOrchestrator } from './sync-orchestrator.service.js';
import { WebhookIngressService } from './webhook-ingress.service.js';

/**
 * Phase 19-INT.14 — the connector catalog and the connection detail document
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.1, §15.3).
 *
 * The catalog answers *"what can this installation connect to?"* and the detail answers *"what is
 * wrong with this connection?"*. Both are **reports**, not commands: they never change anything.
 *
 * Two rules shape them:
 *
 *  - **No secret appears.** A credential is `hasCredential` plus a non-secret hint, and a warning
 *    message never quotes a token.
 *  - **A warning is derived, never asserted.** An operator is told what is actually wrong with
 *    this connection — an expiring credential, a missing permission, an open conflict — not a
 *    generic "check your configuration".
 */

/**
 * The delivery tier a provider belongs to (plan §2.4).
 *
 * The tier is a property of the *provider*, not of the connection, so it lives here rather than in
 * the registry — the registry knows a provider exists; the catalog knows what it is for.
 */
const PROVIDER_TIERS: Readonly<Record<string, 'core' | 'optional' | 'experimental' | 'deprecated'>> = {
  'generic-rest': 'core',
  'google-workspace': 'optional',
  'microsoft-365': 'optional',
  zoom: 'optional',
  stripe: 'optional',
  mailchimp: 'experimental',
  'meta-lead-ads': 'experimental',
  shopify: 'optional',
  woocommerce: 'optional',
  'quickbooks-online': 'optional',
  xero: 'optional',
  'data-enrichment': 'optional',
};

export type ProviderTier = 'core' | 'optional' | 'experimental' | 'deprecated';

export interface CatalogProviderView {
  readonly providerKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly status: string;
  readonly tier: ProviderTier;
  readonly authentication: string;
  readonly objects: readonly {
    readonly objectType: string;
    readonly label: string;
    readonly read: boolean;
    readonly write: boolean;
    readonly webhook: boolean;
  }[];
  readonly requiredScopes: readonly string[];
  readonly optionalScopes: readonly string[];
  readonly docsUrl: string | null;
  readonly connectionCount: number;
  readonly healthyCount: number;
  readonly executable: boolean;
}

export interface ConnectionWarningView {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface ConnectionDetailView {
  readonly connection: IntegrationConnectionView;
  readonly provider: {
    readonly providerKey: string;
    readonly displayName: string;
    readonly adapterVersion: string;
    readonly providerApiVersion: string;
    readonly status: string;
  };
  readonly tenant: {
    readonly ownerType: string;
    readonly ownerId: string;
    readonly tenantRef: string | null;
  };
  readonly lastTest: {
    readonly ok: boolean;
    readonly code: string | null;
    readonly message: string | null;
    readonly checkedAt: string;
  } | null;
  readonly lastRun: {
    readonly id: string;
    readonly status: string;
    readonly finishedAt: string | null;
    readonly recordsApplied: number;
    readonly recordsFailed: number;
  } | null;
  readonly syncLagSeconds: number | null;
  readonly lastWebhook: {
    readonly receivedAt: string;
    readonly status: string;
    readonly signatureValid: boolean;
    readonly eventType: string | null;
  } | null;
  readonly mappings: readonly {
    readonly id: string;
    readonly objectType: string;
    readonly crmEntityType: string;
    readonly direction: string;
    readonly status: string;
    readonly mappingVersion: number;
    readonly syncMode: string;
    readonly conflictPolicy: string;
    readonly deletionPolicy: string;
    readonly fieldCount: number;
  }[];
  readonly warnings: readonly ConnectionWarningView[];
  readonly missingScopes: readonly string[];
}

/** A credential that expires within this many days is worth a warning. */
const CREDENTIAL_EXPIRY_WARNING_DAYS = 14;

@Injectable()
export class ConnectionDetailService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(MappingService) private readonly mappings: MappingService,
    @Inject(SyncOrchestrator) private readonly orchestrator: SyncOrchestrator,
    @Inject(ConflictService) private readonly conflicts: ConflictService,
    @Inject(DeadLetterService) private readonly deadLetters: DeadLetterService,
    @Inject(WebhookIngressService) private readonly webhooks: WebhookIngressService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  /**
   * The connector catalog.
   *
   * A provider is **not** "installed" merely because it is visible. The card says what it can do
   * and what it asks for; the action says what happens next.
   */
  async catalog(): Promise<readonly CatalogProviderView[]> {
    const connections = await this.connections.list();
    const counts = new Map<string, { total: number; healthy: number }>();
    for (const connection of connections) {
      const entry = counts.get(connection.providerKey) ?? { total: 0, healthy: 0 };
      entry.total += 1;
      if (connection.status === 'connected' || connection.status === 'degraded') entry.healthy += 1;
      counts.set(connection.providerKey, entry);
    }

    return this.registry.all().map((definition) => {
      const count = counts.get(definition.providerKey) ?? { total: 0, healthy: 0 };
      return {
        providerKey: definition.providerKey,
        displayName: definition.displayName,
        description: definition.description,
        category: definition.category,
        status: definition.status,
        tier: PROVIDER_TIERS[definition.providerKey] ?? 'experimental',
        authentication: definition.capabilities.authentication,
        objects: definition.capabilities.objects.map((object) => ({
          objectType: object.objectType,
          label: object.label,
          read: object.read,
          write: object.create || object.update || object.upsert,
          webhook: object.webhook,
        })),
        requiredScopes: definition.requiredScopes,
        optionalScopes: definition.optionalScopes,
        docsUrl: definition.docsUrl,
        connectionCount: count.total,
        healthyCount: count.healthy,
        executable: definition.adapter !== null,
      } satisfies CatalogProviderView;
    });
  }

  /** The full detail document of one connection. */
  async detail(connectionId: string): Promise<ConnectionDetailView> {
    const connection = await this.connections.get(connectionId);
    const definition = this.registry.find(connection.providerKey);
    const mappings = await this.mappings.list(connectionId);
    const runs = await this.orchestrator.listRuns(connectionId, 1);
    const deliveries = await this.webhooks.listDeliveries(connectionId, 1);
    const openConflicts = await this.conflicts.listOpen(connectionId, 1);
    const openLetters = await this.deadLetters.listOpen(connectionId, 1);

    const lastRun = runs[0] ?? null;
    const lastWebhook = deliveries[0] ?? null;
    const lastTest = connection.lastValidatedAt
      ? {
          ok: connection.healthStatus === 'ok',
          code: connection.healthSummaryCode,
          message: null,
          checkedAt: connection.lastValidatedAt,
        }
      : null;

    const syncLagSeconds = this.syncLag(connection);
    const warnings = await this.warnings(connection, {
      openConflicts: openConflicts.length,
      openDeadLetters: openLetters.length,
      draftMappings: mappings.filter((mapping) => mapping.status === 'draft').length,
    });

    return {
      connection,
      provider: {
        providerKey: connection.providerKey,
        displayName: definition?.displayName ?? connection.providerKey,
        adapterVersion: definition?.adapterVersion ?? connection.adapterVersion,
        providerApiVersion: definition?.providerApiVersion ?? 'unknown',
        status: definition?.status ?? 'unsupported',
      },
      tenant: {
        ownerType: connection.ownerType,
        ownerId: connection.ownerId,
        tenantRef: connection.tenantRef,
      },
      lastTest,
      lastRun: lastRun === null ? null : {
        id: lastRun.id,
        status: lastRun.status,
        finishedAt: lastRun.finishedAt,
        recordsApplied: lastRun.recordsApplied,
        recordsFailed: lastRun.recordsFailed,
      },
      syncLagSeconds,
      lastWebhook: lastWebhook === null ? null : {
        receivedAt: lastWebhook.receivedAt,
        status: lastWebhook.status,
        signatureValid: lastWebhook.signatureValid,
        eventType: lastWebhook.eventType,
      },
      mappings: mappings.map((mapping) => ({
        id: mapping.id,
        objectType: mapping.objectType,
        crmEntityType: mapping.crmEntityType,
        direction: mapping.direction,
        status: mapping.status,
        mappingVersion: mapping.mappingVersion,
        syncMode: mapping.syncMode,
        conflictPolicy: mapping.conflictPolicy,
        deletionPolicy: mapping.deletionPolicy,
        fieldCount: mapping.fields.length,
      })),
      warnings,
      missingScopes: connection.missingScopes,
    };
  }

  /**
   * How long ago the last successful sync finished.
   *
   * `null` when there has never been one — an operator must be able to tell "never synced" from
   * "synced a moment ago".
   */
  private syncLag(connection: IntegrationConnectionView): number | null {
    if (connection.lastSuccessfulSyncAt === null) return null;
    const at = Date.parse(connection.lastSuccessfulSyncAt);
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.round((Date.now() - at) / 1000));
  }

  /**
   * Everything the operator has to act on.
   *
   * Each warning is derived from the connection's actual state. A warning is never a generic
   * "check your configuration": it names the thing and the consequence.
   */
  private async warnings(
    connection: IntegrationConnectionView,
    counters: { readonly openConflicts: number; readonly openDeadLetters: number; readonly draftMappings: number },
  ): Promise<readonly ConnectionWarningView[]> {
    const warnings: ConnectionWarningView[] = [];

    if (connection.status === 'reauthorization_required') {
      warnings.push({
        code: 'REAUTHORIZATION_REQUIRED',
        severity: 'error',
        message: 'The provider no longer accepts this credential. Reauthorize the connection to continue syncing.',
      });
    }
    if (connection.status === 'error') {
      warnings.push({
        code: 'CONNECTION_ERROR',
        severity: 'error',
        message: 'The last operation failed. Open the run to see what went wrong.',
      });
    }
    if (connection.status === 'paused') {
      warnings.push({
        code: 'PAUSED',
        severity: 'info',
        message: 'The connection is paused. No provider call is made until it is resumed.',
      });
    }
    if (connection.status === 'revoked') {
      warnings.push({
        code: 'REVOKED',
        severity: 'error',
        message: 'The provider grant was revoked. The stored credential no longer works.',
      });
    }
    if (connection.status === 'draft') {
      warnings.push({
        code: 'DRAFT',
        severity: 'info',
        message: 'The connection is a draft. It does not call the provider until a mapping is published.',
      });
    }

    if (connection.missingScopes.length > 0) {
      warnings.push({
        code: 'MISSING_SCOPES',
        severity: 'error',
        message: `The provider needs permissions this connection does not hold: ${connection.missingScopes.join(', ')}.`,
      });
    }

    const expiry = await this.credentialExpiry(connection.id);
    if (expiry !== null) {
      const days = Math.ceil(expiry / (24 * 60 * 60));
      if (days <= 0) {
        warnings.push({
          code: 'CREDENTIAL_EXPIRED',
          severity: 'error',
          message: 'The stored credential has expired. Reauthorize the connection.',
        });
      } else if (days <= CREDENTIAL_EXPIRY_WARNING_DAYS) {
        warnings.push({
          code: 'CREDENTIAL_EXPIRING',
          severity: 'warning',
          message: `The stored credential expires in ${String(days)} day${days === 1 ? '' : 's'}. Reauthorize before it lapses.`,
        });
      }
    }

    if (counters.openConflicts > 0) {
      warnings.push({
        code: 'OPEN_CONFLICTS',
        severity: 'warning',
        message: `${String(counters.openConflicts)} record${counters.openConflicts === 1 ? '' : 's'} changed on both sides and need a decision.`,
      });
    }
    if (counters.openDeadLetters > 0) {
      warnings.push({
        code: 'DEAD_LETTERS',
        severity: 'warning',
        message: `${String(counters.openDeadLetters)} operation${counters.openDeadLetters === 1 ? '' : 's'} failed permanently and can be replayed.`,
      });
    }
    if (counters.draftMappings > 0) {
      warnings.push({
        code: 'DRAFT_MAPPINGS',
        severity: 'info',
        message: `${String(counters.draftMappings)} mapping${counters.draftMappings === 1 ? '' : 's'} have not been published, so they do not sync.`,
      });
    }

    const circuit = await this.circuitState(connection.id);
    if (circuit === 'open') {
      warnings.push({
        code: 'CIRCUIT_OPEN',
        severity: 'warning',
        message: 'The provider is failing repeatedly, so calls to it are paused until it recovers.',
      });
    }

    return warnings;
  }

  /** The soonest credential expiry, in seconds, or `null` when there is none. */
  private async credentialExpiry(connectionId: string): Promise<number | null> {
    const rows = await sql<{ expires_at: Date | null }>`
      select min(expires_at) as expires_at
      from integration_credential_secrets
      where connection_id = ${connectionId} and state = 'active' and expires_at is not null
    `.execute(this.database.db);
    const expiresAt = rows.rows[0]?.expires_at ?? null;
    if (expiresAt === null) return null;
    return Math.round((expiresAt.getTime() - Date.now()) / 1000);
  }

  /** The state of the circuit breaker for a connection. */
  private async circuitState(connectionId: string): Promise<string | null> {
    const rows = await sql<{ state: string }>`
      select state from integration_circuit_states where key = ${`conn:${connectionId}`} limit 1
    `.execute(this.database.db);
    return rows.rows[0]?.state ?? null;
  }

  /** The CRM entity's fields, for the mapping builder's target pane. */
  crmFields(entityType: string): readonly CrmFieldView[] {
    return crmFieldsOf(this.metadata, entityType);
  }
}
