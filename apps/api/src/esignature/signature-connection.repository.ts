import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import {
  CONNECTED_STATUS,
  CONNECTION_ENVIRONMENTS,
  type ESignatureConnectionEnvironment,
  type ESignatureConnectionStatus,
  PROVIDER_KEY_DOCUSIGN,
} from './esignature-domain.js';
import { isSignatureProviderKey, SIGNATURE_PROVIDER_KEYS } from './providers/signature-provider.keys.js';

/**
 * Phase 19-ES.2 — the provider connection repository
 * (`PLAN_Phase_19_ESignature.md` §6.1, §4.1; `19-ES.2`).
 *
 * This row is the *non-secret* half of a connection: the environment, the discovered account
 * context, the granted scopes and the health timestamps (plan §6.1). The credential half — the client
 * secret, the refresh token, the Connect HMAC secret — is a vault row referenced by
 * `(connection id, kind)` and is not reachable from this file, which is the point: making "a secret
 * can never leak through the entity API" a property of the data model rather than a convention
 * (audit §6, `credential-vault.ts:12-27`).
 *
 * Nothing here authorizes a provider call. `ESignatureConnectionGate` decides admission; this
 * repository only stores what the operator and ES.4's OAuth flow establish, and it refuses a status
 * that would put a connection into a state it cannot legally be in.
 */

export interface SignatureConnection {
  readonly id: string;
  readonly name: string;
  readonly providerKey: string;
  readonly environment: ESignatureConnectionEnvironment;
  readonly status: ESignatureConnectionStatus;
  readonly isActive: boolean;
  readonly oauthClientId: string | null;
  readonly redirectUri: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly baseUri: string | null;
  readonly subjectUserId: string | null;
  readonly grantedScopes: readonly string[];
  readonly consentStatus: string;
  readonly publicId: string;
  readonly connectReference: string | null;
  readonly lastAuthAt: string | null;
  readonly lastSuccessfulApiAt: string | null;
  readonly lastWebhookAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly createdById: string | null;
  readonly deleted: boolean;
}

/**
 * The connection lifecycle (plan §4.1).
 *
 * `not_connected` is the state of a row an administrator created but never authorized. `disabled` is
 * the operator's switch during an incident — it must stop calls without touching history
 * (plan §21.12). `reauthorization_required` is the only state a revoked or expired grant may enter,
 * and nothing but a completed authorization leaves it (plan §9.2).
 */
export const CONNECTION_TRANSITIONS: Readonly<Record<ESignatureConnectionStatus, readonly ESignatureConnectionStatus[]>> = {
  // `reauthorization_required` is reachable from `not_connected` since ES.4, because DocuSign can
  // answer a first authorization with a grant that is real but insufficient: the consent exists, the
  // scopes do not, and the state that says so is exactly this one (plan §6.1 `consentStatus`).
  not_connected: ['connected', 'reauthorization_required', 'error', 'disabled'],
  connected: ['reauthorization_required', 'disabled', 'error'],
  reauthorization_required: ['connected', 'disabled', 'not_connected', 'error'],
  disabled: ['connected', 'not_connected'],
  error: ['connected', 'reauthorization_required', 'disabled', 'not_connected'],
};

export function canConnectionTransition(from: ESignatureConnectionStatus, to: ESignatureConnectionStatus): boolean {
  return (CONNECTION_TRANSITIONS[from] ?? []).includes(to);
}

export function assertConnectionTransition(from: ESignatureConnectionStatus, to: ESignatureConnectionStatus): void {
  if (canConnectionTransition(from, to)) return;
  throw new ValidationError(`A signature connection in "${from}" cannot move to "${to}".`, {
    from,
    to,
    allowed: [...(CONNECTION_TRANSITIONS[from] ?? [])],
  });
}

interface ConnectionRow {
  id: string;
  name: string;
  provider_key: string;
  environment: string;
  status: string;
  is_active: boolean;
  oauth_client_id: string | null;
  redirect_uri: string | null;
  account_id: string | null;
  account_name: string | null;
  base_uri: string | null;
  subject_user_id: string | null;
  granted_scopes: unknown;
  consent_status: string;
  public_id: string;
  connect_reference: string | null;
  last_auth_at: Date | null;
  last_successful_api_at: Date | null;
  last_webhook_at: Date | null;
  last_error_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  modified_at: Date;
  created_by_id: string | null;
  deleted_at: Date | null;
}

@Injectable()
export class SignatureConnectionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  /**
   * A live connection in the only state that permits a provider call (the gate's hot read).
   *
   * Scoped to one provider when asked: a request must not be admitted because a *different*
   * provider happens to be connected. Without a key it answers "any usable connection", which is
   * what the module health view reports.
   */
  async countUsable(providerKey?: string): Promise<number> {
    let query = this.db
      .selectFrom('esignature_connections')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('deleted_at', 'is', null)
      .where('status', '=', CONNECTED_STATUS)
      .where('is_active', '=', true);
    if (providerKey !== undefined) query = query.where('provider_key', '=', providerKey);
    const row = await query.executeTakeFirst();
    return Number.parseInt(String(row?.n ?? '0'), 10) || 0;
  }

  async findById(id: string, options: { includeDeleted?: boolean } = {}): Promise<SignatureConnection | undefined> {
    const query = this.db.selectFrom('esignature_connections').selectAll().where('id', '=', id);
    const row = await (options.includeDeleted === true ? query : (query as typeof query).where('deleted_at', 'is', null)).executeTakeFirst();
    return row === undefined ? undefined : toConnection(row);
  }

  async findByPublicId(publicId: string): Promise<SignatureConnection | undefined> {
    if (publicId.trim() === '') return undefined;
    const row = await this.db
      .selectFrom('esignature_connections')
      .selectAll()
      .where('public_id', '=', publicId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toConnection(row);
  }

  async list(options: { environment?: ESignatureConnectionEnvironment } = {}): Promise<SignatureConnection[]> {
    let query = this.db.selectFrom('esignature_connections').selectAll().where('deleted_at', 'is', null);
    if (options.environment !== undefined) query = query.where('environment', '=', options.environment);
    const rows = await query.orderBy('environment', 'asc').orderBy('name', 'asc').execute();
    return rows.map((row) => toConnection(row));
  }

  /**
   * Create a connection in `not_connected`.
   *
   * `publicId` is generated here and is a routing identifier only — a webhook path segment that
   * authenticates nothing on its own (plan §8.3). The environment must be named explicitly: there is
   * no default, because guessing demo versus production is a plan §9.4 incident waiting to happen.
   */
  async create(input: {
    providerKey?: string | undefined;
    name: string;
    environment: ESignatureConnectionEnvironment;
    oauthClientId?: string | undefined;
    redirectUri?: string | undefined;
    connectReference?: string | undefined;
    createdById?: string | undefined;
    id?: string | undefined;
  }): Promise<SignatureConnection> {
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A signature connection needs a name.');
    const providerKey = input.providerKey ?? PROVIDER_KEY_DOCUSIGN;
    if (!isSignatureProviderKey(providerKey)) {
      throw new ValidationError(`"${providerKey}" is not a signature provider this build knows.`, {
        providerKey,
        known: [...SIGNATURE_PROVIDER_KEYS],
      });
    }
    if (!CONNECTION_ENVIRONMENTS.includes(input.environment)) {
      throw new ValidationError('A signature connection names either the demo or the production environment.', {
        environment: input.environment,
        allowed: [...CONNECTION_ENVIRONMENTS],
      });
    }
    const id = input.id ?? randomUUID();
    const now = new Date();
    const row = await this.db
      .insertInto('esignature_connections')
      .values({
        id,
        name,
        provider_key: providerKey,
        environment: input.environment,
        status: 'not_connected',
        is_active: false,
        oauth_client_id: input.oauthClientId?.trim() || null,
        redirect_uri: input.redirectUri?.trim() || null,
        granted_scopes: JSON.stringify([]),
        consent_status: 'unknown',
        // The routing id in the webhook path. Random, opaque, and not a secret.
        public_id: randomUUID().replaceAll('-', ''),
        connect_reference: input.connectReference?.trim() || null,
        created_at: now,
        modified_at: now,
        created_by_id: input.createdById ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConnection(row);
  }

  /**
   * Record the result of a completed authorization.
   *
   * The account id and the account-specific base URI are exactly what OAuth's `userinfo` returned —
   * the repository stores what it is told and refuses an empty account context, because a connection
   * without an account cannot address the REST API (plan §3.2, §9.2).
   */
  async recordAuthorized(
    id: string,
    context: {
      accountId: string;
      accountName?: string | undefined;
      baseUri: string;
      subjectUserId?: string | undefined;
      grantedScopes: readonly string[];
      consentStatus?: 'granted' | 'insufficient' | 'revoked' | undefined;
      oauthClientId?: string | undefined;
      redirectUri?: string | undefined;
    },
  ): Promise<SignatureConnection> {
    const current = await this.require(id);
    assertConnectionTransition(current.status, 'connected');
    if (context.accountId.trim() === '') throw new ValidationError('The provider returned no account, so the connection cannot be authorized.');
    if (context.baseUri.trim() === '') throw new ValidationError('The provider returned no account base URI, so the connection cannot be used.');
    const row = await this.db
      .updateTable('esignature_connections')
      .set({
        status: 'connected',
        is_active: true,
        account_id: context.accountId.trim(),
        account_name: context.accountName?.trim() || null,
        base_uri: context.baseUri.trim(),
        subject_user_id: context.subjectUserId?.trim() || null,
        granted_scopes: JSON.stringify([...context.grantedScopes]),
        consent_status: context.consentStatus ?? 'granted',
        ...(context.oauthClientId !== undefined ? { oauth_client_id: context.oauthClientId.trim() } : {}),
        ...(context.redirectUri !== undefined ? { redirect_uri: context.redirectUri.trim() } : {}),
        last_auth_at: new Date(),
        last_error_at: null,
        last_error_code: null,
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConnection(row);
  }

  /** Move a connection, through the same table a caller cannot bypass. */
  async setStatus(
    id: string,
    to: ESignatureConnectionStatus,
    details: {
      errorCode?: string | undefined;
      byId?: string | undefined;
      consentStatus?: 'unknown' | 'granted' | 'insufficient' | 'revoked' | undefined;
    } = {},
  ): Promise<SignatureConnection> {
    const current = await this.require(id);
    assertConnectionTransition(current.status, to);
    const row = await this.db
      .updateTable('esignature_connections')
      .set({
        status: to,
        // Only an authorization can put a connection back into `connected`; deactivating is separate.
        is_active: to === CONNECTED_STATUS ? current.isActive : false,
        consent_status: details.consentStatus ?? (to === 'reauthorization_required' ? 'revoked' : current.consentStatus),
        last_error_at: to === 'error' || to === 'reauthorization_required' ? new Date() : current.lastErrorAt ? new Date(current.lastErrorAt) : null,
        last_error_code: details.errorCode ?? (to === 'error' || to === 'reauthorization_required' ? current.lastErrorCode : null),
        modified_at: new Date(),
        ...(details.byId !== undefined ? { modified_by_id: details.byId } : {}),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConnection(row);
  }

  /**
   * Edit the non-secret profile of a connection.
   *
   * The environment and the provider key are not editable, and `status` is not reachable from here:
   * an existing connection is never silently moved between demo and production (plan §9.4), and only
   * an authorization or an operator switch moves its state.
   */
  async updateProfile(
    id: string,
    patch: {
      name?: string | undefined;
      redirectUri?: string | undefined;
      connectReference?: string | undefined;
      oauthClientId?: string | undefined;
    },
    byId?: string | undefined,
  ): Promise<SignatureConnection> {
    const current = await this.require(id);
    const name = patch.name?.trim();
    if (patch.name !== undefined && (name === undefined || name === '')) {
      throw new ValidationError('A signature connection needs a name.');
    }
    const row = await this.db
      .updateTable('esignature_connections')
      .set({
        ...(name !== undefined && name !== '' ? { name } : {}),
        ...(patch.redirectUri !== undefined ? { redirect_uri: patch.redirectUri.trim() } : {}),
        ...(patch.connectReference !== undefined ? { connect_reference: patch.connectReference.trim() || null } : {}),
        ...(patch.oauthClientId !== undefined ? { oauth_client_id: patch.oauthClientId.trim() || null } : {}),
        modified_at: new Date(),
        ...(byId !== undefined ? { modified_by_id: byId } : {}),
      })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConnection(row);
  }

  /** The operator's switch. It stops calls; it never deletes history (plan §21.12). */
  async setActive(id: string, isActive: boolean, byId?: string | undefined): Promise<SignatureConnection> {
    const current = await this.require(id);
    if (isActive && current.status !== CONNECTED_STATUS) {
      throw new ValidationError('A connection must be authorized before it can be activated.', { status: current.status });
    }
    const row = await this.db
      .updateTable('esignature_connections')
      .set({ is_active: isActive, modified_at: new Date(), ...(byId !== undefined ? { modified_by_id: byId } : {}) })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConnection(row);
  }

  /** The health stamps. Each is a single write, and none of them carries a provider body. */
  async recordSuccessfulApiCall(id: string): Promise<void> {
    await this.db
      .updateTable('esignature_connections')
      .set({ last_successful_api_at: new Date(), modified_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async recordWebhookReceived(id: string): Promise<void> {
    await this.db
      .updateTable('esignature_connections')
      .set({ last_webhook_at: new Date(), modified_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** A sanitized code only. A provider's message may quote a token, so it never lands here. */
  async recordError(id: string, errorCode: string): Promise<void> {
    await this.db
      .updateTable('esignature_connections')
      .set({ last_error_at: new Date(), last_error_code: errorCode.slice(0, 64), modified_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Disconnect: soft delete, so requests and evidence keep pointing at the connection (plan §21.12).
   *
   * It moves through the same transition table as every other status change — a connection cannot be
   * dropped out from under a state it has not reached — and only the `deleted_at` flag makes it
   * invisible. Nothing here removes a request, an event, an artifact or an audit row.
   */
  async disconnect(id: string, byId?: string | undefined): Promise<SignatureConnection> {
    const current = await this.require(id);
    assertConnectionTransition(current.status, 'disabled');
    const row = await this.db
      .updateTable('esignature_connections')
      .set({
        status: 'disabled',
        is_active: false,
        deleted_at: new Date(),
        modified_at: new Date(),
        ...(byId !== undefined ? { modified_by_id: byId } : {}),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConnection(row);
  }

  async hasRequests(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('signature_requests')
      .select('id')
      .where('connection_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async require(id: string): Promise<SignatureConnection> {
    const found = await this.findById(id);
    if (found === undefined) throw new ValidationError(`No signature connection "${id}".`, { id });
    return found;
  }
}

function toConnection(row: ConnectionRow): SignatureConnection {
  return {
    id: row.id,
    name: row.name,
    providerKey: row.provider_key,
    environment: row.environment as ESignatureConnectionEnvironment,
    status: row.status as ESignatureConnectionStatus,
    isActive: row.is_active,
    oauthClientId: row.oauth_client_id,
    redirectUri: row.redirect_uri,
    accountId: row.account_id,
    accountName: row.account_name,
    baseUri: row.base_uri,
    subjectUserId: row.subject_user_id,
    grantedScopes: Array.isArray(row.granted_scopes) ? (row.granted_scopes as string[]).filter((s) => typeof s === 'string') : [],
    consentStatus: row.consent_status,
    publicId: row.public_id,
    connectReference: row.connect_reference,
    lastAuthAt: iso(row.last_auth_at),
    lastSuccessfulApiAt: iso(row.last_successful_api_at),
    lastWebhookAt: iso(row.last_webhook_at),
    lastErrorAt: iso(row.last_error_at),
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    createdById: row.created_by_id,
    deleted: row.deleted_at !== null,
  };
}

function iso(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
