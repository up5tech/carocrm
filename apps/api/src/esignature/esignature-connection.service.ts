import { AuthenticationFailedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { ProviderError } from '../advanced-integrations/provider-error.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../advanced-integrations/provider-http-client.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { runAsESignatureSystem } from './esignature-authority.js';
import { ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { ESignatureCredentialVault, type ESignatureCredentialVaultPort, type ESignatureStoredCredential } from './esignature-credential-vault.js';
import {
  type ESignatureConnectionEnvironment,
  type ESignatureConnectionStatus,
  type ESignatureSecretKind,
  SECRET_KIND_API_KEY,
  SECRET_KIND_CLIENT_SECRET,
  SECRET_KIND_LABELS,
  SECRET_KIND_OAUTH_ACCESS_TOKEN,
  SECRET_KIND_OAUTH_REFRESH_TOKEN,
} from './esignature-domain.js';
import { encryptionKeyMissingError, providerNotConnectedError } from './esignature-errors.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { type ESignatureSettings, ESignatureSettingsService,oauthClientIdFor } from './esignature-settings.service.js';
import {
  type SignatureProviderAuthStyle,
  type SignatureProviderDescriptor,
  signatureProviderDescriptor,
  signatureProviderLabel,
} from './providers/signature-provider.catalog.js';
import { toModuleError } from './providers/signature-provider.errors.js';
import { correlationId } from './providers/signature-provider.idempotency.js';
import { PROVIDER_KEY_DOCUSIGN } from './providers/signature-provider.keys.js';
import type { SignatureProviderAdapter, SignatureProviderContext } from './providers/signature-provider.port.js';
import { SignatureProviderRegistry } from './providers/signature-provider.registry.js';
import {
  SIGNATURE_PROVIDER_AUTHS,
  type SignatureProviderAuthStrategy,
  type SignatureProviderTokenSet,
} from './providers/signature-provider-auth.port.js';
import { type AuditInput, SignatureAuditRepository } from './signature-audit.repository.js';
import { canConnectionTransition, type SignatureConnection,SignatureConnectionRepository } from './signature-connection.repository.js';
import { SignatureOAuthStateRepository } from './signature-oauth-state.repository.js';

/**
 * Phase 19-ES.4 — DocuSign OAuth and the connection lifecycle
 * (`PLAN_Phase_19_ESignature.md` §6.1, §8.1, §9.2, §13.4, §18 `19-ES.4`).
 *
 * This is the only place in the product that touches a credential. The rules, in the order a security
 * review needs them:
 *
 *  - **An administrator starts the flow.** Every verb on a connection — including the reads — requires
 *    `connectionManage`: the view exposes a provider account identity and a credential inventory, and
 *    plan §12 gives a plain signature user neither.
 *  - **A secret is write-only.** `create` and `storeSecret` accept a value; nothing returns one. The
 *    vault's `read` has exactly two callers in this file: the OAuth exchange and the adapter context.
 *  - **The account context comes from the provider.** `userinfo` decides the account id and the
 *    account-specific base URI (plan §3.2, audit §4). Neither is a settings field and neither is
 *    inferred from the environment.
 *  - **The redirect URI is allowlisted by construction.** It is stored per connection, must be https (a
 *    loopback host may use plain http, for a developer completing a callback locally), must carry no
 *    credentials, and must name this platform's own callback path — a constant of the platform, never
 *    request input. DocuSign compares the string exactly, so the value registered in the DocuSign
 *    console and the value sent here are one.
 *  - **Refresh is serialized per connection and re-checked under the lock**, because a rotating refresh
 *    token is destroyed by a second concurrent refresh; the loser of that race makes no provider call.
 *  - **A revoked, expired or insufficient grant stops sends.** `reauthorization_required` also clears
 *    `is_active`, so the gate's `countUsable()` returns zero and every provider operation is refused
 *    again — plan §9.2's "disables unsafe sends" as a consequence of the data, not a flag to remember.
 *
 * The callback route has no session, so it runs under the module's documented service authority
 * (`esignature-authority.ts`). Its real defences are the single-use hashed state, the connection derived
 * **from** that state, and the environment binding.
 */

/** The platform's own OAuth callback path. A constant, never request input (plan §8.1). */
export const ESIGNATURE_OAUTH_CALLBACK_PATH = '/api/v1/ESignature/oauth/callback';

/** How close to expiry an access token is already refreshed, so a call never starts with a dead token. */
const REFRESH_SKEW_MS = 60_000;

/** A credential an administrator may write. An access or refresh token is the flow's, not theirs. */
const OPERATOR_SECRET_KINDS: readonly ESignatureSecretKind[] = ['api_key', 'client_secret', 'webhook_secret'];

export interface SignatureCredentialView {
  readonly kind: ESignatureSecretKind;
  readonly label: string;
  readonly state: 'active' | 'revoked';
  /** When the credential stops being usable — a fact about it, not its value. */
  readonly expiresAt: string | null;
  readonly rotatedAt: string | null;
}

export interface SignatureConnectionView {
  readonly id: string;
  readonly name: string;
  readonly providerKey: string;
  readonly environment: ESignatureConnectionEnvironment;
  readonly status: ESignatureConnectionStatus;
  readonly isActive: boolean;
  /** A public OAuth client id. The matching secret lives only in the vault. */
  readonly oauthClientId: string | null;
  readonly redirectUri: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly baseUri: string | null;
  readonly grantedScopes: readonly string[];
  readonly consentStatus: string;
  readonly lastAuthAt: string | null;
  readonly lastSuccessfulApiAt: string | null;
  readonly lastWebhookAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  /** An authorization request is open for this connection right now. */
  readonly pendingAuthorization: boolean;
  /** The credential inventory: which kinds exist, their state, their expiry. Never a value. */
  readonly credentials: readonly SignatureCredentialView[];
  readonly hasClientSecret: boolean;
  readonly hasRefreshToken: boolean;
  /** An API-key provider's credential exists. Never the key itself. */
  readonly hasApiKey: boolean;
  /** How this provider authenticates, so the admin screen shows the right form and verbs. */
  readonly authStyle: SignatureProviderAuthStyle | null;
  /** The credential kind that verifies this provider's deliveries, or `null` when none is defined. */
  readonly webhookSecretKind: 'webhook_secret' | 'api_key' | null;
  readonly accessTokenExpiresAt: string | null;
  /** Which adapter answers for this provider in this build. A fake can never sign a real contract. */
  readonly adapterMode: SignatureProviderAdapter['mode'] | 'none';
  /** The provider's display name, from the catalog. A legacy row falls back to its key. */
  readonly providerLabel: string;
  /** Whether this build can connect to the provider, or the integration is only cataloged. */
  readonly providerStatus: 'available' | 'declared' | 'unknown';
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface SignatureAuthorizationStart {
  readonly connectionId: string;
  readonly environment: ESignatureConnectionEnvironment;
  /** The URL the administrator's browser is sent to. The only place a state leaves the platform. */
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

export interface SignatureAuthorizationOutcome {
  readonly connection: SignatureConnectionView;
  readonly status: 'connected' | 'reauthorization_required';
  readonly grantedScopes: readonly string[];
  /** The permission classes the grant is missing — reported as scopes, never as a credential (plan §9.2). */
  readonly missingScopes: readonly string[];
  readonly accountName: string | null;
}

export interface SignatureConnectionTest {
  readonly connectionId: string;
  readonly environment: ESignatureConnectionEnvironment;
  readonly reachable: boolean;
  readonly checkedAt: string;
  readonly detailCode: string;
  readonly adapterMode: SignatureProviderAdapter['mode'];
}

@Injectable()
export class ESignatureConnectionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settingsService: ESignatureSettingsService,
    @Inject(ESignatureConnectionGate) private readonly gate: ESignatureConnectionGate,
    @Inject(SignatureConnectionRepository) private readonly connections: SignatureConnectionRepository,
    @Inject(SignatureOAuthStateRepository) private readonly states: SignatureOAuthStateRepository,
    @Inject(ESignatureCredentialVault) private readonly vault: ESignatureCredentialVaultPort,
    @Inject(SIGNATURE_PROVIDER_AUTHS) authStrategies: readonly SignatureProviderAuthStrategy[],
    @Inject(SignatureProviderRegistry) private readonly providers: SignatureProviderRegistry,
    @Inject(SignatureAuditRepository) private readonly audit: SignatureAuditRepository,
  ) {
    for (const strategy of authStrategies) this.authByProvider.set(strategy.providerKey, strategy);
  }

  /** The authorization protocol each connectable provider registered in this build. */
  private readonly authByProvider = new Map<string, SignatureProviderAuthStrategy>();

  // ---------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------

  async list(): Promise<SignatureConnectionView[]> {
    await this.permissions.assert('connectionRead');
    const rows = await this.connections.list();
    return Promise.all(rows.map((row) => this.view(row)));
  }

  async get(id: string): Promise<SignatureConnectionView> {
    await this.permissions.assert('connectionRead');
    return this.view(await this.require(id));
  }

  /**
   * The redacted connection view.
   *
   * Every credential-shaped fact is reported as *metadata*: which kinds exist, whether they are active,
   * when they expire. That is enough for an administrator to act, and it is the ceiling plan §8.1 sets
   * ("do not expose secret values in GET/PATCH responses").
   */
  async view(connection: SignatureConnection): Promise<SignatureConnectionView> {
    const credentials = await this.vault.list(connection.id);
    const activeOf = (kind: ESignatureSecretKind): ESignatureStoredCredential | undefined =>
      credentials.find((entry) => entry.kind === kind && entry.state === 'active');
    return {
      id: connection.id,
      name: connection.name,
      providerKey: connection.providerKey,
      environment: connection.environment,
      status: connection.status,
      isActive: connection.isActive,
      oauthClientId: connection.oauthClientId,
      redirectUri: connection.redirectUri,
      accountId: connection.accountId,
      accountName: connection.accountName,
      baseUri: connection.baseUri,
      grantedScopes: connection.grantedScopes,
      consentStatus: connection.consentStatus,
      lastAuthAt: connection.lastAuthAt,
      lastSuccessfulApiAt: connection.lastSuccessfulApiAt,
      lastWebhookAt: connection.lastWebhookAt,
      lastErrorAt: connection.lastErrorAt,
      lastErrorCode: connection.lastErrorCode,
      pendingAuthorization: (await this.states.countPending(connection.id)) > 0,
      credentials: credentials.map((entry) => toCredentialView(entry)),
      hasClientSecret: activeOf(SECRET_KIND_CLIENT_SECRET) !== undefined,
      hasRefreshToken: activeOf(SECRET_KIND_OAUTH_REFRESH_TOKEN) !== undefined,
      hasApiKey: activeOf(SECRET_KIND_API_KEY) !== undefined,
      authStyle: signatureProviderDescriptor(connection.providerKey)?.authStyle ?? null,
      webhookSecretKind: signatureProviderDescriptor(connection.providerKey)?.webhookSecretKind ?? null,
      accessTokenExpiresAt: activeOf(SECRET_KIND_OAUTH_ACCESS_TOKEN)?.expiresAt ?? null,
      adapterMode: this.providers.resolve(connection.providerKey)?.mode ?? 'none',
      providerLabel: signatureProviderLabel(connection.providerKey),
      providerStatus: signatureProviderDescriptor(connection.providerKey)?.integrationStatus ?? 'unknown',
      createdAt: connection.createdAt,
      modifiedAt: connection.modifiedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // the control plane
  // ---------------------------------------------------------------------------

  /**
   * Create a connection and store its client secret, in one action.
   *
   * One call on purpose: a "create, then post the secret later" sequence leaves a half-configured
   * connection visible to the next administrator, and that window is exactly where plan §9.2's
   * "changed account permissions" surprises live. The secret is a write parameter; the returned view
   * says only that a client secret is stored.
   */
  async create(input: {
    providerKey?: string | undefined;
    name: string;
    environment: ESignatureConnectionEnvironment;
    /** An OAuth provider's client secret. Ignored for an API-key provider. */
    clientSecret?: string | undefined;
    /** An API-key provider's key. Ignored for an OAuth provider. */
    apiKey?: string | undefined;
    oauthClientId?: string | undefined;
    redirectUri?: string | undefined;
    connectReference?: string | undefined;
  }): Promise<SignatureConnectionView> {
    const settings = await this.assertControlPlane();
    // The provider is chosen first and never guessed: an unknown key, a cataloged-but-not-installed
    // provider, and a provider whose authorization style this command cannot create are three
    // different refusals, and each names what is wrong.
    const descriptor = this.connectableProvider(input.providerKey ?? PROVIDER_KEY_DOCUSIGN);
    // A connectable provider must also have a strategy in this build; the check is here, before a
    // row exists, so a half-configured connection is never visible to the next administrator.
    const auth = this.authStrategy(descriptor);
    if (descriptor.authStyle === 'api_key') return this.createWithApiKey(input, settings, descriptor, auth);

    this.assertOAuthProvider(descriptor);
    const secret = (input.clientSecret ?? '').trim();
    if (secret === '') throw new ValidationError(`A ${descriptor.label} connection needs its OAuth client secret.`);
    if (secret.length > 512) throw new ValidationError(`That value is too long to be a ${descriptor.label} client secret.`);
    const explicitClientId = (input.oauthClientId ?? '').trim();
    const clientId = explicitClientId !== '' ? explicitClientId : this.integrationKey(settings, descriptor.key, input.environment);
    const redirectUri = assertRedirectUri((input.redirectUri ?? '').trim());

    const connection = await this.connections.create({
      providerKey: descriptor.key,
      name: input.name,
      environment: input.environment,
      oauthClientId: clientId,
      redirectUri,
      connectReference: input.connectReference,
      createdById: this.actorId(),
    });
    await this.vault.store({ connectionId: connection.id, kind: SECRET_KIND_CLIENT_SECRET, value: secret });
    await this.audit.append({
      action: 'connection.created',
      connectionId: connection.id,
      actor: this.actorRef(),
      detail: { providerKey: connection.providerKey, environment: connection.environment, clientIdPresent: clientId !== '' },
    });
    return this.view(connection);
  }

  /**
   * Create an API-key connection, verified and connected in the same action.
   *
   * There is no consent screen to send the administrator to, so a row left in `not_connected` would
   * have no path forward. The key is checked against the provider **before** it is stored: a key the
   * account endpoint refuses is not written at all, and a key it accepts names the account the
   * connection is bound to. The key itself reaches the vault and nothing else.
   */
  private async createWithApiKey(
    input: {
      name: string;
      environment: ESignatureConnectionEnvironment;
      apiKey?: string | undefined;
      oauthClientId?: string | undefined;
      connectReference?: string | undefined;
    },
    settings: ESignatureSettings,
    descriptor: SignatureProviderDescriptor,
    auth: SignatureProviderAuthStrategy,
  ): Promise<SignatureConnectionView> {
    const key = (input.apiKey ?? '').trim();
    if (key === '') throw new ValidationError(`A ${descriptor.label} connection needs its API key.`);
    if (key.length > 512) throw new ValidationError(`That value is too long to be a ${descriptor.label} API key.`);
    let account: Awaited<ReturnType<SignatureProviderAuthStrategy['accountContext']>>;
    try {
      account = await auth.accountContext({ environment: input.environment, accessToken: key });
    } catch (error) {
      throw toModuleError(error, descriptor.key);
    }
    // The public app key (used for branding and app callbacks) may come from the request or settings;
    // it is never the API key.
    const explicitClientId = (input.oauthClientId ?? '').trim();
    const clientId = explicitClientId !== '' ? explicitClientId : this.integrationKey(settings, descriptor.key, input.environment);
    const connection = await this.connections.create({
      providerKey: descriptor.key,
      name: input.name,
      environment: input.environment,
      oauthClientId: clientId,
      connectReference: input.connectReference,
      createdById: this.actorId(),
    });
    await this.vault.store({ connectionId: connection.id, kind: SECRET_KIND_API_KEY, value: key });
    const authorized = await this.connections.recordAuthorized(connection.id, {
      accountId: account.accountId,
      accountName: account.accountName ?? undefined,
      baseUri: account.baseUri,
      subjectUserId: account.subjectUserId ?? undefined,
      grantedScopes: [],
      consentStatus: 'granted',
      oauthClientId: clientId,
    });
    await this.audit.append({
      action: 'connection.created',
      connectionId: authorized.id,
      actor: this.actorRef(),
      detail: { providerKey: authorized.providerKey, environment: authorized.environment, authStyle: descriptor.authStyle },
    });
    await this.audit.append({
      action: 'connection.authorized',
      connectionId: authorized.id,
      actor: this.actorRef(),
      detail: { environment: authorized.environment, accountId: authorized.accountId, authStyle: descriptor.authStyle },
    });
    return this.view(authorized);
  }

  /** Rename a connection, re-point its redirect URI, or annotate its Connect configuration. */
  async update(
    id: string,
    patch: { name?: string | undefined; redirectUri?: string | undefined; connectReference?: string | undefined },
  ): Promise<SignatureConnectionView> {
    await this.assertControlPlane();
    const current = await this.require(id);
    const fields: Parameters<SignatureConnectionRepository['updateProfile']>[1] = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.connectReference !== undefined) fields.connectReference = patch.connectReference;
    if (patch.redirectUri !== undefined) fields.redirectUri = assertRedirectUri(patch.redirectUri.trim());
    if (Object.keys(fields).length === 0) throw new ValidationError('Nothing to change.');
    const updated = await this.connections.updateProfile(current.id, fields, this.actorId());
    await this.audit.append({
      action: 'connection.updated',
      connectionId: updated.id,
      actor: this.actorRef(),
      detail: { fields: Object.keys(fields).sort().join(',') },
    });
    return this.view(updated);
  }

  /**
   * Replace a credential an administrator holds.
   *
   * `client_secret` and `webhook_secret` only. An access or refresh token is produced by the flow, and
   * accepting a pasted one would create a connection that looks authorized with no consent behind it.
   */
  async storeSecret(id: string, kind: ESignatureSecretKind, value: string): Promise<SignatureConnectionView> {
    await this.assertControlPlane();
    if (!OPERATOR_SECRET_KINDS.includes(kind)) {
      throw new ValidationError('Only an API key, the OAuth client secret and the Connect webhook secret are entered by an administrator.', {
        allowed: [...OPERATOR_SECRET_KINDS],
      });
    }
    const connection = await this.require(id);
    const descriptor = this.requireProviderDescriptor(connection.providerKey);
    const secret = value.trim();
    if (secret === '' || secret.length > 512) throw new ValidationError('That value is not a credential this module can store.');

    if (kind === SECRET_KIND_API_KEY) {
      if (descriptor.authStyle !== 'api_key') {
        throw new ValidationError(`${descriptor.label} does not authenticate with an API key.`, { providerKey: descriptor.key });
      }
      // A replaced key is re-checked against the provider and re-binds the account. A connection that
      // was in `reauthorization_required` becomes usable again only after that check succeeds.
      const auth = this.authStrategy(descriptor);
      let account: Awaited<ReturnType<SignatureProviderAuthStrategy['accountContext']>>;
      try {
        account = await auth.accountContext({ environment: connection.environment, accessToken: secret });
      } catch (error) {
        throw toModuleError(error, descriptor.key);
      }
      await this.vault.store({ connectionId: connection.id, kind, value: secret });
      const authorized = await this.connections.recordAuthorized(connection.id, {
        accountId: account.accountId,
        accountName: account.accountName ?? undefined,
        baseUri: account.baseUri,
        subjectUserId: account.subjectUserId ?? undefined,
        grantedScopes: [],
        consentStatus: 'granted',
        oauthClientId: connection.oauthClientId ?? undefined,
      });
      await this.audit.append({
        action: 'connection.secretRotated',
        connectionId: connection.id,
        actor: this.actorRef(),
        detail: { kind },
      });
      await this.audit.append({
        action: connection.status === 'connected' ? 'connection.reauthorized' : 'connection.authorized',
        connectionId: connection.id,
        actor: this.actorRef(),
        detail: { environment: connection.environment, accountId: authorized.accountId, authStyle: descriptor.authStyle },
      });
      return this.view(authorized);
    }

    await this.vault.store({ connectionId: connection.id, kind, value: secret });
    await this.audit.append({
      action: 'connection.secretRotated',
      connectionId: connection.id,
      actor: this.actorRef(),
      detail: { kind },
    });
    return this.view(connection);
  }

  // ---------------------------------------------------------------------------
  // the authorization flow
  // ---------------------------------------------------------------------------

  /**
   * Start — or restart — an authorization for one connection.
   *
   * No provider call happens here: this records the state and builds the URL. That is why this path
   * cannot use `gate.assertOperation`, which additionally requires an existing usable connection —
   * creating the first one is precisely what must be reachable while the gate still answers
   * "no connection". `assertControlPlane` is the guard for that bootstrap.
   */
  async authorize(id: string, requestedScopes?: readonly string[] | undefined): Promise<SignatureAuthorizationStart> {
    const settings = await this.assertControlPlane();
    const connection = await this.require(id);
    if (connection.status === 'disabled') throw providerNotConnectedError('disabled');
    const descriptor = this.requireProviderDescriptor(connection.providerKey);
    if (descriptor.authStyle === 'api_key') {
      throw new ValidationError(
        `${descriptor.label} authenticates with an API key and has no consent screen. Replace the key to re-check the connection.`,
        { providerKey: descriptor.key, code: 'API_KEY_REPLACEMENT_REQUIRED' },
      );
    }
    this.assertOAuthProvider(descriptor);
    const auth = this.authStrategy(descriptor);
    const storedClientId = (connection.oauthClientId ?? '').trim();
    const clientId = storedClientId !== '' ? storedClientId : this.integrationKey(settings, descriptor.key, connection.environment);
    if (clientId === '') {
      throw new ValidationError(
        `No ${descriptor.label} integration key is configured for the "${connection.environment}" environment, so this connection cannot be authorized.`,
        { providerKey: descriptor.key, environment: connection.environment, envVars: [...descriptor.oauthClientIdEnvVars] },
      );
    }
    if ((await this.vault.describe({ connectionId: connection.id, kind: SECRET_KIND_CLIENT_SECRET })) === null) {
      throw new ValidationError('This connection has no stored client secret, so it cannot be authorized.');
    }
    const redirectUri = assertRedirectUri((connection.redirectUri ?? '').trim());
    let scopes: string[];
    try {
      scopes = auth.resolveScopes(requestedScopes ?? []);
    } catch (error) {
      // A refused scope is an input the administrator can correct, not a provider failure, so it is
      // reported as a validation problem. `detail` here is always a scope name this file wrote.
      const refused = error instanceof ProviderError ? error.detail : null;
      throw new ValidationError(
        `Those ${descriptor.label} scopes cannot be requested: the set is allowlisted to the minimum the operations need${refused === null ? '.' : ` (refused: ${refused}).`}`,
      );
    }

    // A live grant is being replaced, so it stops being usable the moment the new flow starts: a send
    // attempted during the window would be judged against a consent that is about to change.
    if (connection.status === 'connected') {
      await this.connections.setStatus(connection.id, 'reauthorization_required', {
        byId: this.actorId(),
        errorCode: 'REAUTHORIZATION_STARTED',
      });
    }

    const started = await this.states.start({
      connectionId: connection.id,
      providerKey: connection.providerKey,
      environment: connection.environment,
      initiatedBy: this.actorId() ?? 'system',
      redirectUri,
      requestedScopes: scopes,
    });
    if (auth.authorizeUrl === undefined) {
      throw new ValidationError(`The ${descriptor.label} authorization strategy cannot build a consent URL, so this connection cannot be authorized.`, { providerKey: descriptor.key });
    }
    return {
      connectionId: connection.id,
      environment: connection.environment,
      authorizationUrl: auth.authorizeUrl({
        environment: connection.environment,
        clientId,
        redirectUri,
        state: started.state,
        scopes,
        codeChallenge: started.codeChallenge,
      }),
      expiresAt: started.expiresAt,
      scopes,
    };
  }

  /**
   * Complete an authorization. Called by the public callback route, under the service authority.
   *
   * Every refusal has the same message and the same shape, because which of "forged", "replayed" and
   * "expired" it was is exactly what somebody probing this endpoint would like to learn (plan §8.1).
   */
  async complete(input: { state: string; code: string; error?: string | null | undefined }): Promise<SignatureAuthorizationOutcome> {
    const state = await this.states.consume(input.state);
    if (state === null) {
      // Nothing to attribute the attempt to — that is the point of a hashed, single-use state. Recording
      // that it happened at all is the only way an operator learns somebody is probing the endpoint.
      await this.audit.append({
        action: 'connection.authorized',
        actor: { type: 'system', id: 'esignature-oauth' },
        outcome: 'refused',
        reasonSafe: 'state_not_found',
      });
      throw new AuthenticationFailedError(
        'The authorization response is not valid. It may have expired, already been used, or never have come from this platform.',
      );
    }
    const connection = await this.connections.findById(state.connectionId);
    if (connection === undefined || connection.deleted) {
      throw new AuthenticationFailedError('The authorization response is not valid.');
    }

    if (input.error !== undefined && input.error !== null && input.error.trim() !== '') {
      // The administrator refused the consent screen. No grant ever existed, so the connection stays
      // where it is and the attempt is recorded without quoting the provider's reason.
      await this.connections.recordError(connection.id, 'AUTHORIZATION_REFUSED');
      await this.audit.append({
        action: connection.status === 'not_connected' ? 'connection.authorized' : 'connection.reauthorized',
        connectionId: connection.id,
        actor: { type: 'system', id: 'esignature-oauth' },
        outcome: 'refused',
        reasonSafe: 'provider_refused_authorization',
      });
      throw new AuthenticationFailedError('The provider refused the authorization.');
    }
    const code = input.code.trim();
    if (code === '') throw new AuthenticationFailedError('The authorization response is not valid.');

    // The state names the provider and the environment it was started for. A row that changed since
    // then is refused rather than authorized into a different DocuSign deployment (plan §9.4).
    if (connection.environment !== state.environment || connection.providerKey !== state.providerKey) {
      throw new AuthenticationFailedError('The authorization response is not valid.');
    }
    if (connection.status === 'disabled') throw providerNotConnectedError('disabled');

    const descriptor = this.requireProviderDescriptor(connection.providerKey);
    this.assertOAuthProvider(descriptor);
    const auth = this.authStrategy(descriptor);
    if (auth.exchangeCode === undefined) {
      throw new ValidationError(`The ${descriptor.label} authorization strategy cannot exchange a code, so this connection cannot be authorized.`, { providerKey: descriptor.key });
    }
    const settings = await this.settingsService.settings();
    const storedClientId = (connection.oauthClientId ?? '').trim();
    const clientId = storedClientId !== '' ? storedClientId : this.integrationKey(settings, descriptor.key, connection.environment);
    const clientSecret = await this.vault.read({ connectionId: connection.id, kind: SECRET_KIND_CLIENT_SECRET });
    if (clientSecret === null) {
      throw new ValidationError('This connection has no stored client secret, so it cannot be authorized.');
    }

    let tokens: SignatureProviderTokenSet;
    try {
      tokens = await auth.exchangeCode({
        environment: connection.environment,
        clientId,
        clientSecret,
        code,
        redirectUri: state.redirectUri,
        codeVerifier: state.codeVerifier,
      });
    } catch (error) {
      await this.refuseGrant(connection, error, 'AUTHORIZATION_FAILED');
      // The provider's own words may quote a token, and its status code is not this API's contract:
      // the caller gets the module's stable failure (plan §8.2, ES.3's boundary rule).
      throw toModuleError(error, connection.providerKey);
    }

    // The provider — not this installation — decides which account the credential belongs to and
    // where that account's API lives (plan §3.2, audit §4).
    let account: Awaited<ReturnType<SignatureProviderAuthStrategy['accountContext']>>;
    try {
      account = await auth.accountContext({ environment: connection.environment, accessToken: tokens.accessToken });
    } catch (error) {
      await this.refuseGrant(connection, error, 'ACCOUNT_LOOKUP_FAILED');
      throw toModuleError(error, connection.providerKey);
    }

    // The tokens are stored before the scope decision, so a partially usable grant is still evidence:
    // an administrator can see that a credential exists and when it expires even when the scopes are
    // not enough. It is not usable, because the connection does not become active.
    await this.storeTokens(connection.id, tokens);

    const granted = [...new Set(tokens.grantedScopes)];
    const missing = state.requestedScopes.filter((scope) => !granted.includes(scope));
    if (missing.length > 0) {
      await this.connections.setStatus(connection.id, 'reauthorization_required', {
        byId: this.actorId() ?? state.initiatedBy,
        errorCode: 'SCOPE_MISSING',
        consentStatus: 'insufficient',
      });
      await this.audit.append({
        action: 'connection.authorized',
        connectionId: connection.id,
        outcome: 'refused',
        reasonSafe: 'scope_missing',
        detail: { missingScopes: missing.join(',') },
      });
      return {
        connection: await this.view(await this.require(connection.id)),
        status: 'reauthorization_required',
        grantedScopes: granted,
        missingScopes: missing,
        accountName: account.accountName,
      };
    }

    const authorized = await this.connections.recordAuthorized(connection.id, {
      accountId: account.accountId,
      accountName: account.accountName ?? undefined,
      baseUri: account.baseUri,
      subjectUserId: account.subjectUserId ?? undefined,
      grantedScopes: granted,
      consentStatus: 'granted',
      oauthClientId: clientId,
      redirectUri: state.redirectUri,
    });
    await this.audit.append({
      action: connection.status === 'not_connected' ? 'connection.authorized' : 'connection.reauthorized',
      connectionId: authorized.id,
      actor: { type: 'system', id: 'esignature-oauth' },
      detail: { environment: authorized.environment, accountId: authorized.accountId },
    });
    return {
      connection: await this.view(authorized),
      status: 'connected',
      grantedScopes: granted,
      missingScopes: [],
      accountName: account.accountName,
    };
  }

  // ---------------------------------------------------------------------------
  // health, activation, disconnect
  // ---------------------------------------------------------------------------

  /**
   * Test Connection (plan §13.4 "verify the connection, selected account, environment").
   *
   * Admission is the gate's answer, not this method's opinion: `testConnection` requires the
   * capability, the effective `connections` feature, a provider that declares `connectionStatus`,
   * `ENCRYPTION_KEY`, and at least one usable connection. Then *this* connection's own state is
   * checked, because "some connection is usable" must not let an operator test a different one.
   */
  async test(id: string): Promise<SignatureConnectionTest> {
    const connection = await this.require(id);
    // Admission is per provider: an installation with only a Dropbox Sign connection must be able to
    // test that connection, not be refused because no DocuSign connection happens to exist.
    await this.gate.assertOperation('testConnection', connection.providerKey);
    // The bound adapter answers, so an installation reports the same thing the gate admitted (ES.3's
    // rule) and an operator can see whether a fake answered.
    const adapter = this.providers.assertOperation(connection.providerKey, 'connectionStatus');
    let status = await adapter.connectionStatus(await this.contextFor(connection));

    // A token the provider no longer accepts is not a diagnostic detail; it is a state change. Try the
    // documented recovery first — a refresh — and only a refresh that does not help moves the connection.
    // An API-key connection has nothing to refresh: the key itself must be replaced.
    const oauth = signatureProviderDescriptor(connection.providerKey)?.authStyle === 'oauth2_authorization_code';
    if (oauth && !status.reachable && status.detailCode === 'token_expired' && (await this.tryRefresh(connection.id))) {
      const retried = await adapter.connectionStatus(await this.contextFor(await this.require(connection.id)));
      if (retried.reachable) status = { ...retried, detailCode: 'ok_after_refresh' };
    }

    if (status.reachable) {
      await this.connections.recordSuccessfulApiCall(connection.id);
    } else {
      await this.connections.recordError(connection.id, (status.detailCode ?? 'unreachable').toUpperCase().slice(0, 64));
      if (status.detailCode === 'token_expired') await this.moveToReauthorization(connection.id, 'TOKEN_EXPIRED');
    }
    await this.audit.append({
      action: 'connection.tested',
      connectionId: connection.id,
      outcome: status.reachable ? 'ok' : 'refused',
      reasonSafe: status.detailCode,
      detail: { environment: connection.environment, adapterMode: adapter.mode },
    });
    return {
      connectionId: connection.id,
      environment: connection.environment,
      reachable: status.reachable,
      checkedAt: status.checkedAt,
      // An adapter that answers `detailCode: null` is saying "nothing went wrong", not "no reason".
      detailCode: status.detailCode ?? (status.reachable ? 'ok' : 'unreachable'),
      adapterMode: adapter.mode,
    };
  }

  /** The operator's switch. It stops calls; it never deletes history (plan §21.12). */
  async setActive(id: string, isActive: boolean): Promise<SignatureConnectionView> {
    await this.assertControlPlane();
    const connection = await this.require(id);
    const updated = await this.connections.setActive(connection.id, isActive, this.actorId());
    await this.audit.append({
      action: isActive ? 'connection.enabled' : 'connection.disabled',
      connectionId: updated.id,
      actor: this.actorRef(),
      detail: { environment: updated.environment },
    });
    return this.view(updated);
  }

  /**
   * Disconnect: destroy the credentials, then soft-delete the row.
   *
   * The order is the point. A connection whose ciphertext is still readable is a connection that can
   * still be used, so the vault is emptied first and every unfinished authorization state goes with it.
   * Requests, events, artifacts and audit rows that name this connection stay (plan §21.12).
   */
  async disconnect(id: string): Promise<{ connectionId: string; credentialsRemoved: number; statesDiscarded: number; hadRequests: boolean }> {
    await this.assertControlPlane();
    const connection = await this.require(id);
    const statesDiscarded = await this.states.discardPending(connection.id);
    const credentialsRemoved = await this.vault.clear(connection.id);
    const hadRequests = await this.connections.hasRequests(connection.id);
    if (connection.status !== 'disabled') {
      await this.connections.disconnect(connection.id, this.actorId());
    }
    await this.audit.append({
      action: 'connection.disconnected',
      connectionId: connection.id,
      actor: this.actorRef(),
      detail: { credentialsRemoved, hadRequests },
    });
    return { connectionId: connection.id, credentialsRemoved, statesDiscarded, hadRequests };
  }

  // ---------------------------------------------------------------------------
  // tokens
  // ---------------------------------------------------------------------------

  /**
   * Refresh this connection's access token, serialized per connection.
   *
   * Not a route. A call that needs a live token asks for a context, and this is what produces one; it
   * runs under the module's service authority because no human session exists.
   */
  async refresh(id: string): Promise<{ refreshed: boolean; expiresAt: string | null }> {
    return runAsESignatureSystem(this.scope, `refresh:${id}`, () => this.refreshLocked(id));
  }

  /** Whether a refresh is needed *now*, from the expiry stamp alone — no decryption, no provider call. */
  async needsRefresh(id: string): Promise<boolean> {
    const current = await this.vault.describe({ connectionId: id, kind: SECRET_KIND_OAUTH_ACCESS_TOKEN });
    return needsRefresh(current?.expiresAt ?? null);
  }

  /**
   * The authenticated account an adapter call runs against (plan §3.2, §5.2).
   *
   * The only path from a stored connection to a bearer token. It refreshes when the token is close to
   * expiry and refuses rather than inventing a context, so no adapter in this product ever receives a
   * credential the platform did not resolve from the vault for a connection in `connected` state.
   */
  async contextFor(connection: SignatureConnection): Promise<SignatureProviderContext> {
    if (connection.status !== 'connected' || !connection.isActive) {
      throw providerNotConnectedError(
        connection.status === 'reauthorization_required'
          ? 'reauthorization_required'
          : connection.status === 'connected'
            ? 'disabled'
            : 'not_authorized',
      );
    }
    if (connection.accountId === null || connection.baseUri === null) throw providerNotConnectedError('not_authorized');
    const descriptor = this.requireProviderDescriptor(connection.providerKey);

    // An API key *is* the credential: there is nothing to refresh, and a key the provider stopped
    // accepting moves the connection to reauthorization through the adapter's 401 classification.
    if (descriptor.authStyle === 'api_key') {
      const apiKey = await this.vault.read({ connectionId: connection.id, kind: SECRET_KIND_API_KEY });
      if (apiKey === null) throw providerNotConnectedError('not_authorized');
      return {
        connectionId: connection.id,
        providerKey: connection.providerKey,
        environment: connection.environment,
        accountId: connection.accountId,
        baseUri: connection.baseUri,
        grantedScopes: connection.grantedScopes,
        accessToken: apiKey,
        clientId: connection.oauthClientId,
        correlationId: correlationId(),
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      };
    }

    if (await this.needsRefresh(connection.id)) await this.refresh(connection.id);
    const accessToken = await this.vault.read({ connectionId: connection.id, kind: SECRET_KIND_OAUTH_ACCESS_TOKEN });
    if (accessToken === null) throw providerNotConnectedError('not_authorized');
    return {
      connectionId: connection.id,
      providerKey: connection.providerKey,
      environment: connection.environment,
      accountId: connection.accountId,
      baseUri: connection.baseUri,
      grantedScopes: connection.grantedScopes,
      accessToken,
      clientId: connection.oauthClientId,
      correlationId: correlationId(),
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    };
  }

  private async refreshLocked(id: string): Promise<{ refreshed: boolean; expiresAt: string | null }> {
    return this.database.db.transaction().execute(async (tx) => {
      // Serialise refreshes for this connection across every process. A rotating refresh token is
      // destroyed by a second concurrent refresh, so this lock is a correctness requirement.
      await sql`select pg_advisory_xact_lock(hashtext(${id}))`.execute(tx);

      const current = await this.vault.describe({ connectionId: id, kind: SECRET_KIND_OAUTH_ACCESS_TOKEN });
      // Another worker may have refreshed while this one waited for the lock; it then makes no call.
      if (current !== null && !needsRefresh(current.expiresAt)) return { refreshed: false, expiresAt: current.expiresAt };

      const connection = await this.require(id);
      const descriptor = this.requireProviderDescriptor(connection.providerKey);
      this.assertOAuthProvider(descriptor);
      const auth = this.authStrategy(descriptor);
      if (auth.refresh === undefined) {
        throw new ValidationError(`The ${descriptor.label} authorization strategy cannot refresh a token.`);
      }
      const refreshToken = await this.vault.read({ connectionId: id, kind: SECRET_KIND_OAUTH_REFRESH_TOKEN });
      if (refreshToken === null) {
        // A refresh with nothing to refresh is a connection a human must authorize again.
        await this.moveToReauthorization(id, 'REFRESH_TOKEN_MISSING');
        throw providerNotConnectedError('reauthorization_required');
      }
      const settings = await this.settingsService.settings();
      const storedClientId = (connection.oauthClientId ?? '').trim();
      const clientId = storedClientId !== '' ? storedClientId : this.integrationKey(settings, descriptor.key, connection.environment);
      const clientSecret = await this.vault.read({ connectionId: id, kind: SECRET_KIND_CLIENT_SECRET });
      if (clientSecret === null) {
        await this.moveToReauthorization(id, 'CLIENT_SECRET_MISSING');
        throw providerNotConnectedError('not_authorized');
      }
      let tokens: SignatureProviderTokenSet;
      try {
        tokens = await auth.refresh({
          environment: connection.environment,
          clientId,
          clientSecret,
          refreshToken,
          scopes: connection.grantedScopes,
        });
      } catch (error) {
        // `invalid_grant` here is plan §9.2's case: revoked, expired, or the account's permissions changed.
        await this.refuseGrant(connection, error, 'TOKEN_REFRESH_FAILED');
        throw toModuleError(error, connection.providerKey);
      }
      await this.storeTokens(id, tokens);
      return { refreshed: true, expiresAt: tokens.expiresAt };
    });
  }

  /** Whether a refresh recovered the connection. A failure here is an answer, not an error to report. */
  private async tryRefresh(id: string): Promise<boolean> {
    try {
      return (await this.refresh(id)).refreshed;
    } catch {
      return false;
    }
  }

  private async storeTokens(connectionId: string, tokens: SignatureProviderTokenSet): Promise<void> {
    await this.vault.store({
      connectionId,
      kind: SECRET_KIND_OAUTH_ACCESS_TOKEN,
      value: tokens.accessToken,
      expiresAt: tokens.expiresAt,
    });
    if (tokens.refreshToken !== null) {
      await this.vault.store({ connectionId, kind: SECRET_KIND_OAUTH_REFRESH_TOKEN, value: tokens.refreshToken });
    } else {
      // A rotating grant answers without a refresh token only when there is none to keep; the stale
      // value is destroyed rather than left looking usable.
      await this.vault.revoke({ connectionId, kind: SECRET_KIND_OAUTH_REFRESH_TOKEN });
    }
  }

  /**
   * Move a connection out of the usable set after the provider refused the credential.
   *
   * `authorization`, `account_mismatch` and `configuration_invalid` are the categories that mean "a
   * human must act again" (plan §9.2). A rate limit or an outage is not one of them: the grant is still
   * valid, and a request that failed for availability is not evidence about consent.
   */
  private async refuseGrant(connection: SignatureConnection, error: unknown, code: string): Promise<void> {
    await this.connections.recordError(connection.id, code);
    if (!(error instanceof ProviderError)) return;
    if (error.category !== 'authorization' && error.category !== 'account_mismatch' && error.category !== 'configuration_invalid') return;
    if (canConnectionTransition(connection.status, 'reauthorization_required')) {
      await this.connections.setStatus(connection.id, 'reauthorization_required', {
        // The stage of the flow is what an operator acts on; the provider's own code is in the audit row.
        errorCode: code,
        // A wrong client secret is an installation fault, not a revoked consent; the consent status is
        // only rewritten when the provider actually said the grant is gone.
        ...(error.category === 'configuration_invalid' ? {} : { consentStatus: 'revoked' as const }),
      });
    }
    await this.audit.append({
      // Which action was being attempted, not which one failed: a first authorization and a
      // re-authorization are different facts about the same refusal.
      action: connection.status === 'not_connected' ? 'connection.authorized' : 'connection.reauthorized',
      connectionId: connection.id,
      actor: { type: 'system', id: 'esignature-oauth' },
      outcome: 'refused',
      reasonSafe: error.category,
      detail: { providerCode: error.code },
    });
  }

  private async moveToReauthorization(id: string, errorCode: string): Promise<void> {
    const connection = await this.require(id);
    if (!canConnectionTransition(connection.status, 'reauthorization_required')) return;
    await this.connections.setStatus(id, 'reauthorization_required', { errorCode, byId: this.actorId() });
  }

  // ---------------------------------------------------------------------------
  // guards and pure helpers
  // ---------------------------------------------------------------------------

  /**
   * The four facts that must hold before a connection command runs: the capability, the module switch,
   * the `connections` feature, and `ENCRYPTION_KEY` — the last because a credential that cannot be
   * encrypted must not be accepted at all (plan §4.1).
   *
   * This is **not** `gate.assertOperation`, which additionally requires an existing usable connection.
   * Creating and authorizing the first one is exactly what has to be reachable while the gate still
   * refuses every provider operation, and that difference is ES.1's acceptance criterion in code.
   */
  private async assertControlPlane(): Promise<ESignatureSettings> {
    await this.permissions.assert('connectionManage');
    const view = await this.settingsService.read();
    if (view.settings.enabled !== true) {
      throw new ValidationError('The e-signature module is not enabled on this instance, so connections cannot be administered.');
    }
    if (view.effective.connections !== true) {
      throw new ValidationError('The provider connection feature is not enabled in the ESignature settings.');
    }
    if (!this.settingsService.encryptionConfigured()) throw encryptionKeyMissingError();
    return view.settings;
  }

  /** The public OAuth client id configured for one provider and environment. */
  private integrationKey(settings: ESignatureSettings, providerKey: string, environment: ESignatureConnectionEnvironment): string {
    return oauthClientIdFor(settings, providerKey, environment);
  }

  /** The catalog descriptor for a provider key, or a stated refusal. */
  private requireProviderDescriptor(providerKey: string): SignatureProviderDescriptor {
    const descriptor = signatureProviderDescriptor(providerKey);
    if (descriptor === undefined) {
      throw new ValidationError(`"${providerKey}" is not a signature provider this build knows.`, { providerKey });
    }
    return descriptor;
  }

  /** A provider whose adapter and strategy must both be installed before a connection may exist. */
  private connectableProvider(providerKey: string): SignatureProviderDescriptor {
    const descriptor = this.requireProviderDescriptor(providerKey);
    if (descriptor.integrationStatus !== 'available') {
      throw new ValidationError(
        `${descriptor.label} is cataloged as a planned integration, but no adapter or authorization strategy is installed in this build, so a connection cannot be created for it yet.`,
        { providerKey: descriptor.key, integrationStatus: descriptor.integrationStatus },
      );
    }
    return descriptor;
  }

  /** Refuse a provider whose grant is not an OAuth authorization-code flow. */
  private assertOAuthProvider(descriptor: SignatureProviderDescriptor): void {
    if (descriptor.authStyle !== 'oauth2_authorization_code') {
      throw new ValidationError(
        `${descriptor.label} does not use an OAuth authorization-code grant, so a connection cannot be authorized for it in this build.`,
        { providerKey: descriptor.key, authStyle: descriptor.authStyle },
      );
    }
  }

  /** The strategy bound for a provider, or a refusal that names the missing piece. */
  private authStrategy(descriptor: SignatureProviderDescriptor): SignatureProviderAuthStrategy {
    const strategy = this.authByProvider.get(descriptor.key);
    if (strategy === undefined) {
      throw new ValidationError(`No authorization strategy is installed for ${descriptor.label} in this build.`, {
        providerKey: descriptor.key,
      });
    }
    return strategy;
  }

  private async require(id: string): Promise<SignatureConnection> {
    const found = await this.connections.findById(id);
    if (found === undefined) throw new ValidationError(`No signature connection "${id}".`, { id });
    return found;
  }

  private actorId(): string | undefined {
    return this.scope.userId ?? undefined;
  }

  /** The acting principal of an audit row: a user when a session started the action, the system otherwise. */
  private actorRef(): NonNullable<AuditInput['actor']> {
    const id = this.actorId();
    return id === undefined || id === 'system' ? { type: 'system' } : { type: 'user', id };
  }
}

/**
 * The one redirect URI this module will send to DocuSign, validated.
 *
 * https always, except a loopback host on plain http, which exists only so a developer can complete a
 * callback locally — the same exception the platform's own provider HTTP gate makes. The path must be
 * this platform's callback path, no credentials may ride in the URL, and no fragment may follow it.
 * Together those four checks are plan §8.1's "validate redirect URI exactly against configured
 * allowlisted URIs": an authorization that could aim at an arbitrary endpoint is an open redirect with
 * a live consent attached to it.
 */
export function assertRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`An OAuth redirect URI must be an absolute URL naming this platform's callback path: ${ESIGNATURE_OAUTH_CALLBACK_PATH}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new ValidationError('An OAuth redirect URI must use https. Plain http is only allowed on a loopback host for local validation.');
  }
  if (url.username !== '' || url.password !== '') throw new ValidationError('An OAuth redirect URI must not carry credentials.');
  if (url.pathname !== ESIGNATURE_OAUTH_CALLBACK_PATH) {
    throw new ValidationError(`The OAuth redirect URI must point at this platform's callback path: ${ESIGNATURE_OAUTH_CALLBACK_PATH}`);
  }
  if (url.hash !== '') throw new ValidationError('An OAuth redirect URI must not carry a fragment.');
  return url.toString();
}

/** Whether a stored credential is close enough to expiry to be refreshed before a call. */
function needsRefresh(expiresAt: string | null): boolean {
  if (expiresAt === null) return true;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry - Date.now() <= REFRESH_SKEW_MS;
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower.endsWith('.localhost');
}

function toCredentialView(entry: ESignatureStoredCredential): SignatureCredentialView {
  return {
    kind: entry.kind,
    label: SECRET_KIND_LABELS[entry.kind],
    state: entry.state,
    expiresAt: entry.expiresAt,
    rotatedAt: entry.rotatedAt,
  };
}
