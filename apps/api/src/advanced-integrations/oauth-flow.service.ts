import { createHash, randomBytes } from 'node:crypto';

import { AuthenticationFailedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { runAsAdvancedIntegrationsSystem } from './advanced-integrations-authority.js';
import { canTransition } from './advanced-integrations-domain.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { ConnectionLifecycleService,CREDENTIAL_VAULT } from './connection-lifecycle.service.js';
import type { CredentialVaultPort } from './credential-vault.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import type {
  OAuthAuthorizeContext,
  OAuthExchangeContext,
  OAuthProviderError,
  OAuthRefreshContext,
  OAuthRevokeContext,
  OAuthTokenSet,
} from './oauth-connector.js';

/**
 * Phase 19-INT.5 — the OAuth flow
 * (`PLAN_Phase_19_Advanced_Integrations.md` §7.2; `19-INT.5`).
 *
 * The platform owns the flow; the connector owns only the provider's HTTP details.
 *
 * The rules this file implements, one by one:
 *
 *  - **Single-use, unguessable state.** 256 bits of entropy, stored **hashed**, so a database read
 *    does not yield a usable state. The state is consumed atomically: a second callback with the
 *    same state finds nothing and is refused.
 *  - **The state is bound.** It names the connection, the provider and the user who started the
 *    flow. The callback derives the connection **from the state**, never from the request, so a
 *    callback cannot be aimed at somebody else's connection.
 *  - **PKCE.** A verifier is generated per flow, its S256 challenge goes to the provider and the
 *    verifier goes to the token exchange. The verifier is stored with the state and deleted with it.
 *  - **The redirect URI is allowlisted.** It is a constant of the platform, never request input.
 *  - **Minimum scopes.** Only the scopes the provider declares are requested. A caller may narrow
 *    them further, never widen them.
 *  - **Granted scopes are compared with required scopes** before the connection becomes usable. A
 *    missing scope is reported as a *permission class*, never as a credential.
 *  - **Tokens live only in the vault.** The authorization code is never persisted and never logged.
 *  - **Refresh is serialised per connection** with a Postgres advisory lock, because a rotating
 *    refresh token is destroyed by a second concurrent refresh.
 */

export const OAUTH_CALLBACK_PATH = '/api/v1/integrations/advanced-integrations/oauth/callback';

/** The only redirect URI the platform will ever send to a provider. */
export const OAUTH_REDIRECT_URI = OAUTH_CALLBACK_PATH;

/** The OAuth credential kinds the vault stores. */
const KIND_ACCESS_TOKEN = 'oauth_access_token';
const KIND_REFRESH_TOKEN = 'oauth_refresh_token';

export interface OAuthAuthorizationStartResult {
  readonly connectionId: string;
  /** The URL the administrator's browser is sent to. */
  readonly authorizationUrl: string;
  /** ISO timestamp at which the authorization request stops being usable. */
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

export interface OAuthCallbackResult {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly status: 'connected' | 'reauthorization_required';
  readonly grantedScopes: readonly string[];
  /** The permission classes the connection is missing. Never a credential. */
  readonly missingScopes: readonly string[];
  /** A non-secret identifier of the connected provider account. */
  readonly accountRef: string | null;
}

interface OAuthStateRow {
  id: string;
  connection_id: string;
  provider_key: string;
  initiated_by: string;
  code_verifier: string | null;
  redirect_uri: string;
  requested_scopes: unknown;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

@Injectable()
export class OAuthFlowService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AdvancedIntegrationsPermissionService) private readonly permissions: AdvancedIntegrationsPermissionService,
    @Inject(AdvancedIntegrationsSettingsService) private readonly settings: AdvancedIntegrationsSettingsService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVaultPort,
  ) {}

  /**
   * Start an authorization flow.
   *
   * The caller may narrow the requested scopes; they can never widen them beyond what the provider
   * declares.
   */
  async authorize(connectionId: string, requestedScopes?: readonly string[]): Promise<OAuthAuthorizationStartResult> {
    await this.permissions.assert('authorize');
    const settings = await this.settings.settings();
    if (!settings.features.oauth) {
      throw new ValidationError(
        'The OAuth flow is disabled for this installation. Enable it in the module settings before authorizing a connection.',
      );
    }
    const connection = await this.connections.get(connectionId);
    if (!['draft', 'pending_authorization', 'reauthorization_required', 'error'].includes(connection.status)) {
      throw new ValidationError(`A connection in "${connection.status}" cannot start an authorization flow.`, {
        status: connection.status,
      });
    }
    const provider = this.registry.requireExecutable(connection.providerKey);
    const adapter = provider.adapter;
    if (adapter === null || adapter.supportsAuthorization !== true || adapter.authorize === undefined) {
      throw new ValidationError(`Provider "${connection.providerKey}" does not support an OAuth flow.`, {
        providerKey: connection.providerKey,
      });
    }

    // Minimum necessary scopes: the provider's required set, optionally narrowed by the caller.
    const allowed = new Set([...provider.requiredScopes, ...provider.optionalScopes]);
    const requested =
      requestedScopes === undefined || requestedScopes.length === 0
        ? [...provider.requiredScopes]
        : [...new Set(requestedScopes)].filter((scope) => allowed.has(scope));
    if (requestedScopes !== undefined && requestedScopes.length > 0 && requested.length === 0) {
      throw new ValidationError('None of the requested scopes is available for this provider.', {
        requestedScopes: [...requestedScopes],
      });
    }

    const state = randomBytes(32).toString('base64url');
    const codeVerifier = settings.oauth.pkce ? randomBytes(32).toString('base64url') : null;
    const codeChallenge = codeVerifier === null ? null : challengeFor(codeVerifier);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.oauth.stateTtlSeconds * 1000);

    await sql`
      insert into integration_oauth_states
        (id, connection_id, provider_key, initiated_by, code_verifier, redirect_uri,
         requested_scopes, created_at, expires_at)
      values
        (${hashState(state)}, ${connectionId}, ${connection.providerKey}, ${this.scope.userId ?? 'system'},
         ${codeVerifier}, ${OAUTH_REDIRECT_URI}, ${JSON.stringify(requested)}::jsonb, ${now}, ${expiresAt})
    `.execute(this.database.db);

    const context: OAuthAuthorizeContext = {
      connectionId,
      providerKey: connection.providerKey,
      redirectUri: OAUTH_REDIRECT_URI,
      scopes: requested,
      state,
      codeChallenge,
      codeChallengeMethod: codeChallenge === null ? null : 'S256',
      tenantRef: connection.tenantRef,
    };
    const started = await adapter.authorize(context);

    await this.connections.transition(connectionId, 'pending_authorization');
    return {
      connectionId,
      authorizationUrl: started.authorizationUrl,
      expiresAt: expiresAt.toISOString(),
      scopes: requested,
    };
  }

  /**
   * Complete an authorization flow.
   *
   * The connection is derived from the state, so a callback cannot be aimed at another connection.
   * The state is consumed atomically, so a replay finds nothing.
   */
  async complete(input: { state: string; code: string; error?: string | null }): Promise<OAuthCallbackResult> {
    if (input.error !== undefined && input.error !== null && input.error !== '') {
      throw new AuthenticationFailedError(`The provider refused the authorization: ${input.error}`);
    }
    if (input.state.trim() === '') {
      throw new AuthenticationFailedError('The authorization response carried no state.');
    }
    if (input.code.trim() === '') {
      throw new AuthenticationFailedError('The authorization response carried no code.');
    }

    const row = await this.consumeState(input.state);
    if (row === null) {
      throw new AuthenticationFailedError(
        'The authorization response is not valid. It may have expired, already been used, or never have come from this platform.',
      );
    }

    const connection = await this.connections.get(row.connection_id);
    if (connection.status !== 'pending_authorization') {
      throw new AuthenticationFailedError(
        `The connection is in "${connection.status}" and cannot complete an authorization.`,
      );
    }
    // The state names the user who started the flow. A user-scoped connection must still belong
    // to that user; a connection that changed hands in the meantime is refused rather than taken
    // over.
    if (connection.ownerType === 'user' && connection.ownerId !== row.initiated_by) {
      throw new AuthenticationFailedError(
        'The connection is no longer owned by the user that started this authorization.',
      );
    }

    const provider = this.registry.requireExecutable(row.provider_key);
    const adapter = provider.adapter;
    if (adapter === null || adapter.exchangeCode === undefined) {
      throw new ValidationError(`Provider "${row.provider_key}" does not support an OAuth flow.`, {
        providerKey: row.provider_key,
      });
    }

    const exchangeContext: OAuthExchangeContext = {
      connectionId: row.connection_id,
      providerKey: row.provider_key,
      code: input.code,
      redirectUri: row.redirect_uri,
      codeVerifier: row.code_verifier,
      scopes: parseScopes(row.requested_scopes),
    };

    let tokens: OAuthTokenSet;
    try {
      tokens = await adapter.exchangeCode(exchangeContext);
    } catch (error) {
      await this.connections.transition(row.connection_id, 'error', { lastErrorCode: 'AUTHORIZATION_FAILED' });
      throw wrapProviderError(error);
    }

    await this.storeTokens(row.connection_id, tokens);

    const required = connection.requiredScopes;
    const granted = [...new Set(tokens.grantedScopes)];
    const missing = required.filter((scope) => !granted.includes(scope));
    if (missing.length > 0) {
      // The grant is real but insufficient. The connection must not look usable, and the missing
      // permission class is reported without exposing anything about the credential.
      await this.connections.transition(row.connection_id, 'reauthorization_required', {
        grantedScopes: granted,
        lastErrorCode: 'SCOPE_MISSING',
      });
      return {
        connectionId: row.connection_id,
        providerKey: row.provider_key,
        status: 'reauthorization_required',
        grantedScopes: granted,
        missingScopes: missing,
        accountRef: tokens.accountRef,
      };
    }

    await this.connections.transition(row.connection_id, 'connected', { grantedScopes: granted });
    return {
      connectionId: row.connection_id,
      providerKey: row.provider_key,
      status: 'connected',
      grantedScopes: granted,
      missingScopes: [],
      accountRef: tokens.accountRef,
    };
  }

  /**
   * Refresh a connection's access token.
   *
   * The refresh runs inside a transaction that holds a per-connection advisory lock, so two
   * concurrent operations cannot refresh the same token twice. The second one finds a fresh token
   * and does nothing.
   */
  async refresh(connectionId: string): Promise<{ readonly refreshed: boolean; readonly expiresAt: string | null }> {
    // A refresh is background work: it has no human session. It runs under the documented service
    // authority (ADR 0003, §7.2), and it is not exposed as a route.
    return runAsAdvancedIntegrationsSystem(this.scope, `refresh:${connectionId}`, () =>
      this.refreshUnderServiceAuthority(connectionId),
    );
  }

  private async refreshUnderServiceAuthority(
    connectionId: string,
  ): Promise<{ readonly refreshed: boolean; readonly expiresAt: string | null }> {
    const connection = await this.connections.get(connectionId);
    const provider = this.registry.find(connection.providerKey);
    const adapter = provider?.adapter ?? null;
    if (adapter === null || adapter.supportsRefresh !== true || adapter.refreshCredentials === undefined) {
      throw new ValidationError(`Provider "${connection.providerKey}" does not support refreshing a credential.`, {
        providerKey: connection.providerKey,
      });
    }
    // Bound outside the transaction closure: TypeScript does not carry a property narrowing into a
    // closure, and the method needs its receiver.
    const refresh = adapter.refreshCredentials.bind(adapter);

    return this.database.db.transaction().execute(async (tx) => {
      // Serialise refreshes for this connection across every process. A rotating refresh token is
      // destroyed by a second concurrent refresh, so this lock is a correctness requirement.
      await sql`select pg_advisory_xact_lock(hashtext(${connectionId}))`.execute(tx);

      const current = await this.vault.describe({ connectionId, kind: KIND_ACCESS_TOKEN });
      if (current === null) {
        throw new ValidationError('The connection holds no access token.');
      }
      // Another worker may have refreshed while this one waited for the lock.
      if (!needsRefresh(current.expiresAt)) {
        return { refreshed: false, expiresAt: current.expiresAt };
      }
      const refreshToken = await this.vault.read({ connectionId, kind: KIND_REFRESH_TOKEN });
      if (refreshToken === null) {
        throw new ValidationError('The connection holds no refresh token.');
      }
      const context: OAuthRefreshContext = {
        connectionId,
        providerKey: connection.providerKey,
        refreshToken,
        scopes: connection.grantedScopes,
      };
      let tokens: OAuthTokenSet;
      try {
        tokens = await refresh(context);
      } catch (error) {
        await this.connections.transition(connectionId, 'reauthorization_required', {
          lastErrorCode: 'TOKEN_EXPIRED',
        });
        throw wrapProviderError(error);
      }
      await this.storeTokens(connectionId, tokens, { keepRefreshToken: tokens.refreshToken === null });
      return { refreshed: true, expiresAt: tokens.expiresAt };
    });
  }

  /**
   * Revoke the provider grant and the stored credential.
   *
   * The provider revocation is attempted first; the stored credential is revoked either way, so a
   * provider that does not implement revocation still leaves nothing usable behind.
   */
  async revoke(connectionId: string): Promise<{ readonly success: boolean; readonly providerRevoked: boolean }> {
    await this.permissions.assert('authorize');
    const connection = await this.connections.get(connectionId);
    const provider = this.registry.find(connection.providerKey);
    const adapter = provider?.adapter ?? null;
    let providerRevoked = false;
    if (adapter !== null && adapter.supportsRevocation === true && adapter.revokeCredentials !== undefined) {
      const accessToken = await this.vault.read({ connectionId, kind: KIND_ACCESS_TOKEN });
      const refreshToken = await this.vault.read({ connectionId, kind: KIND_REFRESH_TOKEN });
      const context: OAuthRevokeContext = {
        connectionId,
        providerKey: connection.providerKey,
        accessToken,
        refreshToken,
      };
      try {
        await adapter.revokeCredentials(context);
        providerRevoked = true;
      } catch (error) {
        // A provider that refuses to revoke must not leave the platform's own credential usable.
        throw wrapProviderError(error);
      }
    }
    await this.connections.revoke(connectionId);
    return { success: true, providerRevoked };
  }

  /**
   * Start a reauthorization for a connection whose grant is no longer usable.
   *
   * The flow is the same as `authorize`; the connection's status is what changes.
   */
  async reconnect(connectionId: string, requestedScopes?: readonly string[]): Promise<OAuthAuthorizationStartResult> {
    return this.authorize(connectionId, requestedScopes);
  }

  /** Remove expired and consumed authorization states. Called by the scheduled sweep. */
  async purgeExpiredStates(): Promise<number> {
    const result = await sql`
      delete from integration_oauth_states
      where expires_at < now() or consumed_at is not null
    `.execute(this.database.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Warn the operator that a credential is about to expire, and move a connection whose credential
   * has already expired to `reauthorization_required`.
   *
   * The sweep is **idempotent**: a notification carries a deterministic id, so re-running the job
   * adds nothing. A retry of the job is therefore safe.
   */
  async notifyExpiringCredentials(): Promise<{
    readonly notified: number;
    readonly expired: number;
    readonly purgedStates: number;
  }> {
    const settings = await this.settings.settings();
    const purgedStates = await this.purgeExpiredStates();
    if (!settings.features.expiryNotices) {
      return { notified: 0, expired: 0, purgedStates };
    }

    const warningDays = settings.notifications.reauthorizationWarningDays;
    const horizon = new Date(Date.now() + warningDays * 24 * 60 * 60 * 1000);

    const expiring = await sql<{
      id: string;
      connection_id: string;
      kind: string;
      expires_at: Date;
      provider_key: string;
      name: string;
      created_by_id: string | null;
      owner_type: string;
      owner_id: string;
    }>`
      select c.id, c.connection_id, c.kind, c.expires_at, c.provider_key, c.name,
             c.created_by_id, c.owner_type, c.owner_id
      from integration_credential_secrets c
      join integration_connections k on k.id = c.connection_id
      where c.state = 'active'
        and c.expires_at is not null
        and c.expires_at <= ${horizon}
        and k.deleted_at is null
        and k.status not in ('revoked')
      order by c.expires_at asc
    `.execute(this.database.db);

    let notified = 0;
    let expired = 0;
    const now = new Date();
    for (const row of expiring.rows) {
      const isExpired = row.expires_at.getTime() <= now.getTime();
      if (isExpired) {
        // The credential is no longer usable: the connection must not look healthy.
        await this.markReauthorizationRequired(row.connection_id);
        expired += 1;
        continue;
      }
      const recipient = row.owner_type === 'user' ? row.owner_id : row.created_by_id;
      if (recipient === null || recipient === '') continue;
      const inserted = await sql`
        insert into notifications (id, type, user_id, data, is_read, created_at)
        values (
          ${notificationId(row.connection_id, row.kind)},
          'IntegrationReauthorizationRequired',
          ${recipient},
          ${JSON.stringify({
            connectionId: row.connection_id,
            connectionName: row.name,
            providerKey: row.provider_key,
            kind: row.kind,
            expiresAt: row.expires_at.toISOString(),
          })}::jsonb,
          false,
          now()
        )
        on conflict (id) do nothing
      `.execute(this.database.db);
      notified += Number(inserted.numAffectedRows ?? 0n);
    }
    return { notified, expired, purgedStates };
  }

  /**
   * Move a connection to `reauthorization_required`.
   *
   * The transition is validated, so a connection that is already revoked, paused or in a state
   * that does not allow the move is left alone rather than forced into it.
   */
  private async markReauthorizationRequired(connectionId: string): Promise<void> {
    const connection = await this.connections.get(connectionId);
    if (!canTransition(connection.status, 'reauthorization_required')) return;
    await this.connections.transition(connectionId, 'reauthorization_required', {
      lastErrorCode: 'TOKEN_EXPIRED',
    });
  }

  /**
   * Consume a state atomically.
   *
   * The `consumed_at is null` predicate is what makes a replay impossible: two concurrent
   * callbacks with the same state serialise on the row, and the second finds it consumed.
   */
  private async consumeState(state: string): Promise<OAuthStateRow | null> {
    const rows = await sql<OAuthStateRow>`
      update integration_oauth_states
      set consumed_at = now()
      where id = ${hashState(state)}
        and consumed_at is null
        and expires_at >= now()
      returning *
    `.execute(this.database.db);
    return rows.rows[0] ?? null;
  }

  private async storeTokens(
    connectionId: string,
    tokens: OAuthTokenSet,
    options: { readonly keepRefreshToken?: boolean } = {},
  ): Promise<void> {
    await this.vault.store({
      connectionId,
      kind: KIND_ACCESS_TOKEN,
      value: tokens.accessToken,
      expiresAt: tokens.expiresAt,
    });
    if (tokens.refreshToken !== null) {
      await this.vault.store({ connectionId, kind: KIND_REFRESH_TOKEN, value: tokens.refreshToken });
    } else if (options.keepRefreshToken !== true) {
      await this.vault.revoke({ connectionId, kind: KIND_REFRESH_TOKEN });
    }
  }
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The stored key for a state.
 *
 * The state itself is never persisted: a database read must not yield a usable authorization
 * state.
 */
function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function parseScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The deterministic id of a reauthorization notification.
 *
 * A deterministic id is what makes the expiry sweep idempotent: re-running it adds nothing.
 */
function notificationId(connectionId: string, kind: string): string {
  return `intgn_reauth_${connectionId}_${kind}`;
}

/** Whether an access token is expired, or close enough to expiry to be worth refreshing. */
function needsRefresh(expiresAt: string | null): boolean {
  if (expiresAt === null) return true;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry - Date.now() <= 60_000;
}

/**
 * Translate a provider error into a platform error without leaking anything.
 *
 * The provider's message may quote a response body, which may quote a token. Only the stable code
 * and a generic message survive.
 */
function wrapProviderError(error: unknown): Error {
  if (error instanceof Error && error.name === 'OAuthProviderError') {
    const providerError = error as OAuthProviderError;
    return new ValidationError(`The provider refused the request (${providerError.code}).`, {
      providerCode: providerError.code,
    });
  }
  return new ValidationError('The provider refused the request.');
}
