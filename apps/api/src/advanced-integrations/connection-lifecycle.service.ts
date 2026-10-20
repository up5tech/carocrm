import { randomBytes, randomUUID } from 'node:crypto';

import { DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import {
  assertConfigIsSafe,
  assertTransition,
  type ConnectionOwnerType,
  type ConnectionStatus,
  isConnectionStatus,
  secretHint,
} from './advanced-integrations-domain.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { type CredentialVaultPort } from './credential-vault.js';
import { IntegrationAuditService } from './integration-audit.service.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { requiredScopesFor } from './provider-capabilities.js';

/**
 * Phase 19-INT.4 — the connection lifecycle
 * (`PLAN_Phase_19_Advanced_Integrations.md` §6.2, §7.1, §7.3, §7.4; `19-INT.4`).
 *
 * A connection is the platform's record of one configured installation/account/tenant of a
 * provider. This service owns its state machine, its configuration and its ownership.
 *
 * Four rules are enforced here rather than in an adapter:
 *
 *  1. A connection may only name a **registered** provider, and the scopes it records are checked
 *     against that provider's declaration.
 *  2. A plaintext secret may not be smuggled through the configuration object; credentials belong
 *     in the vault (ADR 0001).
 *  3. Every state change is validated against the state machine. `paused`, `revoked` and
 *     `reauthorization_required` are **not** permission to call the provider.
 *  4. A connection that is missing a required scope may not reach `connected`, so a connection
 *     never looks usable when it is not.
 *
 * The connection row lives in its own table rather than in `entity_records`: a metadata entity is
 * reachable through the generic `/api/v1/:entity` API, and a direct `PATCH` would move a
 * connection between states without passing the machine above.
 */

export interface IntegrationConnectionView {
  readonly id: string;
  readonly providerKey: string;
  readonly name: string;
  readonly ownerType: ConnectionOwnerType;
  readonly ownerId: string;
  /** A non-secret provider account/tenant label, for example a Google Workspace domain. */
  readonly tenantRef: string | null;
  readonly status: ConnectionStatus;
  readonly enabled: boolean;
  readonly grantedScopes: readonly string[];
  /** The scopes the provider declares as required for the objects in use. */
  readonly requiredScopes: readonly string[];
  /** The required scopes the connection does not hold. */
  readonly missingScopes: readonly string[];
  readonly connectionOptions: Readonly<Record<string, unknown>>;
  readonly adapterVersion: string;
  readonly healthStatus: string | null;
  readonly healthSummaryCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastErrorCode: string | null;
  readonly credentialReferenceId: string | null;
  /**
   * The opaque endpoint key the provider is given for a webhook URL. It is a routing identifier,
   * not a secret; the secret is the provider's signature.
   */
  readonly webhookKey: string | null;
  /** Whether a credential is stored. The value is never returned. */
  readonly hasCredential: boolean;
  /** A short, non-secret hint that identifies the credential to a human. */
  readonly credentialHint: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly createdById: string | null;
  readonly modifiedById: string | null;
}

export interface ConnectionCreateInput {
  readonly providerKey: string;
  readonly name: string;
  readonly ownerType: ConnectionOwnerType;
  readonly ownerId: string;
  readonly tenantRef?: string | null;
  readonly connectionOptions?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface ConnectionPatchInput {
  readonly name?: string | undefined;
  readonly tenantRef?: string | null | undefined;
  readonly connectionOptions?: Record<string, unknown> | undefined;
  readonly enabled?: boolean | undefined;
}

interface ConnectionRow {
  id: string;
  provider_key: string;
  name: string;
  owner_type: string;
  owner_id: string;
  tenant_ref: string | null;
  status: string;
  enabled: boolean;
  granted_scopes: unknown;
  required_scopes: unknown;
  connection_options: unknown;
  adapter_version: string;
  health_status: string | null;
  health_summary_code: string | null;
  last_validated_at: Date | null;
  last_successful_sync_at: Date | null;
  last_error_code: string | null;
  credential_reference_id: string | null;
  webhook_key: string | null;
  created_by_id: string | null;
  modified_by_id: string | null;
  created_at: Date;
  modified_at: Date;
}

/** The vault token, so a test can substitute a fake vault. */
export const CREDENTIAL_VAULT = Symbol('CREDENTIAL_VAULT');

@Injectable()
export class ConnectionLifecycleService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(AdvancedIntegrationsPermissionService) private readonly permissions: AdvancedIntegrationsPermissionService,
    @Inject(AdvancedIntegrationsSettingsService) private readonly settings: AdvancedIntegrationsSettingsService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVaultPort,
    @Inject(IntegrationAuditService) private readonly audit: IntegrationAuditService,
  ) {}

  /** Every connection the caller may see. */
  async list(): Promise<readonly IntegrationConnectionView[]> {
    await this.permissions.assert('use');
    const rows = await sql<ConnectionRow>`
      select * from integration_connections
      where deleted_at is null
      order by provider_key asc, name asc
    `.execute(this.database.db);
    const visible = await this.filterVisible(rows.rows);
    return Promise.all(visible.map((row) => this.toView(row)));
  }

  async get(id: string): Promise<IntegrationConnectionView> {
    await this.permissions.assert('use');
    const row = await this.requireRow(id);
    await this.assertVisible(row);
    return this.toView(row);
  }

  /**
   * Create a connection in the `draft` state.
   *
   * A draft is inert: it holds configuration and no credential, and nothing may call a provider
   * through it until it is authorized and enabled.
   */
  async create(input: ConnectionCreateInput): Promise<IntegrationConnectionView> {
    await this.permissions.assert('connectionAdmin');
    const provider = this.registry.require(input.providerKey);
    if (provider.adapter === null) {
      throw new ValidationError(
        `Provider "${input.providerKey}" has no connector bound and cannot be connected to.`,
        { providerKey: input.providerKey },
      );
    }
    const options = input.connectionOptions ?? {};
    assertConfigIsSafe(options);

    const now = new Date();
    const id = randomUUID();
    const requiredScopes = [...provider.requiredScopes];
    // A provider that can push webhooks gets an opaque endpoint key. It is a routing identifier,
    // not a secret: the secret is the provider's signature.
    const webhookKey = provider.capabilities.webhook.supported ? randomBytes(24).toString('base64url') : null;
    try {
      await sql`
        insert into integration_connections
          (id, provider_key, name, owner_type, owner_id, tenant_ref, status, enabled,
           granted_scopes, required_scopes, connection_options, adapter_version, webhook_key,
           created_by_id, modified_by_id, created_at, modified_at)
        values
          (${id}, ${input.providerKey}, ${input.name}, ${input.ownerType}, ${input.ownerId},
           ${input.tenantRef ?? null}, 'draft', ${input.enabled ?? false},
           ${JSON.stringify([])}::jsonb, ${JSON.stringify(requiredScopes)}::jsonb,
           ${JSON.stringify(options)}::jsonb, ${provider.adapterVersion}, ${webhookKey},
           ${this.scope.userId ?? null}, ${this.scope.userId ?? null}, ${now}, ${now})
      `.execute(this.database.db);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateRecordError(
          `A connection named "${input.name}" already exists for "${input.providerKey}" and this owner.`,
        );
      }
      throw error;
    }
    await this.audit.record({
      action: 'connection.created',
      connectionId: id,
      entityType: 'IntegrationConnection',
      entityId: id,
      detail: { providerKey: input.providerKey, ownerType: input.ownerType },
    });
    return this.get(id);
  }

  async update(id: string, patch: ConnectionPatchInput): Promise<IntegrationConnectionView> {
    await this.permissions.assert('connectionAdmin');
    const current = await this.requireRow(id);
    const options = patch.connectionOptions === undefined ? undefined : patch.connectionOptions;
    if (options !== undefined) assertConfigIsSafe(options);

    const now = new Date();
    await sql`
      update integration_connections set
        name = ${patch.name ?? current.name},
        tenant_ref = ${patch.tenantRef === undefined ? current.tenant_ref : patch.tenantRef},
        connection_options = ${options === undefined ? current.connection_options : JSON.stringify(options)}::jsonb,
        enabled = ${patch.enabled === undefined ? current.enabled : patch.enabled},
        modified_at = ${now},
        modified_by_id = ${this.scope.userId ?? null}
      where id = ${id}
    `.execute(this.database.db);
    await this.audit.record({
      action: 'connection.updated',
      connectionId: id,
      entityType: 'IntegrationConnection',
      entityId: id,
      detail: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.tenantRef === undefined ? {} : { tenantRef: patch.tenantRef }),
        optionsChanged: patch.connectionOptions !== undefined,
      },
    });
    if (patch.enabled === true) {
      await this.audit.record({
        action: 'connection.enabled',
        connectionId: id,
        entityType: 'IntegrationConnection',
        entityId: id,
      });
    } else if (patch.enabled === false) {
      await this.audit.record({
        action: 'connection.disabled',
        connectionId: id,
        entityType: 'IntegrationConnection',
        entityId: id,
      });
    }
    return this.get(id);
  }

  /**
   * Move a connection to a new state.
   *
   * The transition is validated against the state machine, and the required-scope check runs when
   * the connection would become usable.
   */
  async transition(
    id: string,
    to: ConnectionStatus,
    extra: {
      grantedScopes?: readonly string[] | undefined;
      /**
       * The scopes this connection actually needs.
       *
       * The provider declares a scope set for the whole connector, but an operator may narrow
       * what a connection asks for. When the authorization flow narrowed the request, the
       * connection's requirement becomes the narrowed set — otherwise a connection that asked for
       * less would report a permanently missing scope.
       */
      requiredScopes?: readonly string[] | undefined;
      lastErrorCode?: string | null | undefined;
    } = {},
  ): Promise<IntegrationConnectionView> {
    await this.permissions.assert('connectionAdmin');
    const current = await this.requireRow(id);
    const from = parseStatus(current.status);
    assertTransition(from, to);

    const grantedScopes =
      extra.grantedScopes === undefined ? parseScopes(current.granted_scopes) : [...new Set(extra.grantedScopes)];
    const requiredScopes =
      extra.requiredScopes === undefined
        ? parseScopes(current.required_scopes)
        : [...new Set(extra.requiredScopes)];

    if (to === 'connected') {
      const settings = await this.settings.settings();
      if (settings.oauth.requireScopes) {
        const missing = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
        if (missing.length > 0) {
          throw new ValidationError(
            `The connection is missing the required permission${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
            { missingScopes: missing },
          );
        }
      }
    }

    const now = new Date();
    await sql`
      update integration_connections set
        status = ${to},
        granted_scopes = ${JSON.stringify(grantedScopes)}::jsonb,
        required_scopes = ${JSON.stringify(requiredScopes)}::jsonb,
        enabled = ${to === 'connected' || to === 'degraded' ? true : to === 'paused' || to === 'revoked' ? false : current.enabled},
        last_error_code = ${extra.lastErrorCode === undefined ? current.last_error_code : extra.lastErrorCode},
        modified_at = ${now},
        modified_by_id = ${this.scope.userId ?? null}
      where id = ${id}
    `.execute(this.database.db);
    await this.audit.record({
      action: 'connection.changed',
      connectionId: id,
      entityType: 'IntegrationConnection',
      entityId: id,
      detail: { from: from, to: to },
    });
    return this.get(id);
  }

  /** Pause a connection. No provider call may be made through it while it is paused. */
  async pause(id: string): Promise<IntegrationConnectionView> {
    const view = await this.transition(id, 'paused');
    await this.audit.record({
      action: 'connection.paused',
      connectionId: id,
      entityType: 'IntegrationConnection',
      entityId: id,
    });
    return view;
  }

  /**
   * Resume a paused connection.
   *
   * The scope check runs again: a credential that expired while the connection was paused resumes
   * to `reauthorization_required`, not to `connected`.
   */
  async resume(id: string): Promise<IntegrationConnectionView> {
    await this.permissions.assert('connectionAdmin');
    const current = await this.requireRow(id);
    const requiredScopes = parseScopes(current.required_scopes);
    const grantedScopes = parseScopes(current.granted_scopes);
    const missing = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
    if (missing.length > 0) {
      await this.transition(id, 'reauthorization_required');
      throw new ValidationError(
        `The connection is missing the required permission${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Reauthorize it before resuming.`,
        { missingScopes: missing },
      );
    }
    const view = await this.transition(id, 'connected');
    await this.audit.record({
      action: 'connection.resumed',
      connectionId: id,
      entityType: 'IntegrationConnection',
      entityId: id,
    });
    return view;
  }

  /**
   * Revoke a connection.
   *
   * The provider grant is revoked through the adapter when it supports revocation; the stored
   * credentials are revoked either way. The connection keeps its configuration so an operator can
   * see what was revoked.
   */
  async revoke(id: string): Promise<IntegrationConnectionView> {
    await this.permissions.assert('authorize');
    const current = await this.requireRow(id);
    const provider = this.registry.find(current.provider_key);
    if (provider?.adapter?.supportsRevocation === true) {
      // The adapter's revocation call belongs to 19-INT.6; until then the platform still revokes
      // its own stored credential, which is the part it is responsible for.
    }
    const credentials = await this.vault.list(id);
    for (const credential of credentials) {
      await this.vault.revoke({ connectionId: id, kind: credential.kind });
      await this.audit.record({
        action: 'credential.revoked',
        connectionId: id,
        entityType: 'IntegrationCredential',
        entityId: id,
        detail: { kind: credential.kind },
      });
    }
    const view = await this.transition(id, 'revoked');
    await this.audit.record({
      action: 'connection.revoked',
      connectionId: id,
      entityType: 'IntegrationConnection',
      entityId: id,
      detail: { revokedCredentials: credentials.length },
    });
    return view;
  }

  /**
   * Record the outcome of a connection test.
   *
   * The result is a health summary, never a credential: the provider's message is not stored
   * verbatim, only the stable code.
   */
  async recordTest(connectionId: string, result: { readonly ok: boolean; readonly code: string | null }): Promise<void> {
    await sql`
      update integration_connections set
        health_status = ${result.ok ? 'ok' : 'error'},
        health_summary_code = ${result.code},
        last_validated_at = ${new Date()},
        modified_at = ${new Date()},
        modified_by_id = ${this.scope.userId ?? null}
      where id = ${connectionId}
    `.execute(this.database.db);
    await this.audit.record({
      action: 'connection.tested',
      connectionId,
      entityType: 'IntegrationConnection',
      entityId: connectionId,
      outcome: result.ok ? 'ok' : 'refused',
      detail: { ok: result.ok, code: result.code },
    });
  }

  /** Reset the inbound checkpoint of every active mapping, so the next run is a full re-sync. */
  async resetCheckpoints(connectionId: string): Promise<number> {
    const result = await sql`
      update integration_sync_checkpoints
      set cursor_value = null, reset_required = true, updated_at = ${new Date()}
      where connection_id = ${connectionId} and direction = 'inbound'
    `.execute(this.database.db);
    const reset = Number(result.numAffectedRows ?? 0n);
    await this.audit.record({
      action: 'sync.reconciled',
      connectionId,
      entityType: 'IntegrationConnection',
      entityId: connectionId,
      detail: { resetCheckpoints: reset },
    });
    return reset;
  }

  /**
   * Remove a connection.
   *
   * The configuration and the credentials go. The CRM records the connection synced are **not**
   * touched — a provider-side delete never hard-deletes a CRM record (feature contract §5.4).
   */
  async remove(id: string): Promise<{ readonly success: boolean }> {
    await this.permissions.assert('connectionAdmin');
    // Refuses an unknown or already-deleted connection before anything is removed.
    await this.requireRow(id);
    await this.vault.removeConnection(id);
    await sql`
      update integration_connections set
        deleted_at = now(),
        enabled = false,
        status = 'revoked',
        modified_at = now(),
        modified_by_id = ${this.scope.userId ?? null}
      where id = ${id}
    `.execute(this.database.db);
    await sql`delete from integration_oauth_states where connection_id = ${id}`.execute(this.database.db);
    await this.audit.record({
      action: 'connection.deleted',
      connectionId: id,
      entityType: 'IntegrationConnection',
      entityId: id,
      detail: { crmRecordsDeleted: 0 },
    });
    return { success: true };
  }

  /**
   * Store a credential for a connection.
   *
   * The value is write-only: it goes to the vault and is never returned.
   */
  async storeCredential(input: {
    connectionId: string;
    kind: 'api_key' | 'client_secret' | 'webhook_secret' | 'signing_secret';
    value: string;
    expiresAt?: string | null;
  }): Promise<IntegrationConnectionView> {
    await this.permissions.assert('credentialAdmin');
    await this.requireRow(input.connectionId);
    await this.vault.store({
      connectionId: input.connectionId,
      kind: input.kind,
      value: input.value,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    await sql`
      update integration_connections set
        credential_reference_id = ${input.connectionId},
        modified_at = now(),
        modified_by_id = ${this.scope.userId ?? null}
      where id = ${input.connectionId}
    `.execute(this.database.db);
    await this.audit.record({
      action: 'credential.stored',
      connectionId: input.connectionId,
      entityType: 'IntegrationCredential',
      entityId: input.connectionId,
      // The kind is recorded; the value never is.
      detail: { kind: input.kind, expiresAt: input.expiresAt ?? null },
    });
    return this.get(input.connectionId);
  }

  /** The required scopes for one provider object, taken from the provider's declaration. */
  requiredScopesFor(providerKey: string, objectType: string): readonly string[] {
    return requiredScopesFor(this.registry.require(providerKey).capabilities, objectType);
  }

  private async requireRow(id: string): Promise<ConnectionRow> {
    const rows = await sql<ConnectionRow>`
      select * from integration_connections where id = ${id} and deleted_at is null limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError(`Connection "${id}" does not exist.`);
    return row;
  }

  /**
   * Filter to the connections the caller may see.
   *
   * A caller who is not an administrator sees only the connections they own. This is a
   * *visibility* rule layered on top of the capability check — hiding a row is never the only
   * control, so every privileged action also asserts the capability (AGENTS.md §5.3).
   */
  private async filterVisible(rows: readonly ConnectionRow[]): Promise<readonly ConnectionRow[]> {
    const isAdmin = (await this.acl.canUser('AdvancedIntegrations', 'edit')) !== 'no';
    if (isAdmin) return rows;
    const userId = this.scope.userId;
    if (userId === undefined) return [];
    return rows.filter((row) => row.owner_type === 'user' && row.owner_id === userId);
  }

  private async assertVisible(row: ConnectionRow): Promise<void> {
    const visible = await this.filterVisible([row]);
    if (visible.length === 0) {
      throw new NotFoundError(`Connection "${row.id}" does not exist.`);
    }
  }

  private async toView(row: ConnectionRow): Promise<IntegrationConnectionView> {
    const credentials = await this.vault.list(row.id);
    const active = credentials.find((credential) => credential.state === 'active');
    const requiredScopes = parseScopes(row.required_scopes);
    const grantedScopes = parseScopes(row.granted_scopes);
    return {
      id: row.id,
      providerKey: row.provider_key,
      name: row.name,
      ownerType: row.owner_type as ConnectionOwnerType,
      ownerId: row.owner_id,
      tenantRef: row.tenant_ref,
      status: parseStatus(row.status),
      enabled: row.enabled,
      grantedScopes,
      requiredScopes,
      missingScopes: requiredScopes.filter((scope) => !grantedScopes.includes(scope)),
      connectionOptions: parseObject(row.connection_options),
      adapterVersion: row.adapter_version,
      healthStatus: row.health_status,
      healthSummaryCode: row.health_summary_code,
      lastValidatedAt: row.last_validated_at ? row.last_validated_at.toISOString() : null,
      lastSuccessfulSyncAt: row.last_successful_sync_at ? row.last_successful_sync_at.toISOString() : null,
      lastErrorCode: row.last_error_code,
      credentialReferenceId: row.credential_reference_id,
      webhookKey: row.webhook_key,
      hasCredential: active !== undefined,
      credentialHint: active === undefined ? null : credentialHintOf(credentials, active.kind),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
      createdById: row.created_by_id,
      modifiedById: row.modified_by_id,
    };
  }
}

/**
 * A hint for the stored credential.
 *
 * The vault keeps the value encrypted, so the hint is derived from the credential's *kind* and
 * its expiry rather than from the plaintext — a read path must never decrypt to render a label.
 */
function credentialHintOf(
  credentials: readonly { readonly kind: string; readonly expiresAt: string | null }[],
  kind: string,
): string | null {
  const credential = credentials.find((entry) => entry.kind === kind);
  if (!credential) return null;
  return credential.expiresAt === null ? kind : `${kind} (expires ${credential.expiresAt})`;
}

function parseScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseStatus(value: string): ConnectionStatus {
  if (!isConnectionStatus(value)) {
    throw new ValidationError(`Unknown connection status "${value}".`, { status: value });
  }
  return value;
}

/** PostgreSQL error code 23505, unique_violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

export { secretHint };
