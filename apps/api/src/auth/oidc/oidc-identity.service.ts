/**
 * Phase 23.3 (PLAN §17.3) — the generic OpenID Connect sign-in.
 *
 * The platform owns the protocol; the provider owns nothing but its endpoints. A **profile** says
 * which provider is meant (issuer, endpoints, client id, redirect URI), so Google, Microsoft and
 * every other OpenID Connect provider are configuration, not code.
 *
 * The rules this service implements:
 *
 *  - **The state is single-use and stored hashed.** The row is consumed atomically, so a replayed
 *    callback finds nothing. A database read does not yield a usable callback token.
 *  - **The nonce is checked.** The id_token must carry the nonce this sign-in generated, so an
 *    id_token minted for another flow — or replayed from another flow — is refused.
 *  - **The redirect URI is compared exactly**, against the value the platform sent, *before* the
 *    code is exchanged. A callback for a different redirect is refused without a token request.
 *  - **PKCE is always used.** The verifier never leaves the server; only its S256 challenge goes
 *    to the provider.
 *  - **The id_token is verified** (signature, issuer, audience, expiry, nonce) before the platform
 *    believes anything in it.
 *  - **The account-linking rule is explicit** (see `resolveUser`).
 *  - **The session is the platform's own.** The OIDC sign-in ends in the same session issuance as
 *    the password sign-in, so every 23.2 rule (single-session policy, MFA policy, revocation,
 *    rotation) applies unchanged.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { JWK } from 'jose';
import { sql } from 'kysely';

import { type AppConfig,CONFIG_TOKEN } from '../../config.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService, type AuthTokens } from '../auth.service.js';
import { OIDC_HTTP_PORT, type OidcHttpPort } from './oidc-http.port.js';
import {
  OIDC_REDIRECT_URI,
  type OidcProfile,
  parseOidcProfiles,
} from './oidc-profile.js';
import { verifyIdToken } from './oidc-token.js';

/** How long a sign-in attempt stays usable. */
const DEFAULT_STATE_TTL_SECONDS = 600;

/** How long a provider's signing keys are cached. */
const JWKS_TTL_MS = 10 * 60 * 1000;

export interface OidcProviderSummary {
  readonly key: string;
  readonly displayName: string;
}

export interface OidcSignInStart {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export type OidcSignInOutcome =
  | { readonly kind: 'session'; readonly tokens: AuthTokens }
  | { readonly kind: 'challenge'; readonly challengeId: string };

interface StateRow {
  id: string;
  profile_key: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  expires_at: Date;
}

@Injectable()
export class OidcIdentityService {
  private readonly jwksCache = new Map<string, { readonly keys: readonly JWK[]; readonly expiresAt: number }>();

  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OIDC_HTTP_PORT) private readonly http: OidcHttpPort,
  ) {}

  /** The configured profiles. Parsed on read, so a malformed profile refuses the request. */
  profiles(): readonly OidcProfile[] {
    return parseOidcProfiles(this.config.oidcProfiles);
  }

  /** The profiles a person may be offered. Never a secret — a key and a display name. */
  list(): { readonly list: readonly OidcProviderSummary[] } {
    return { list: this.profiles().map((profile) => ({ key: profile.key, displayName: profile.displayName })) };
  }

  private profile(key: string): OidcProfile {
    const found = this.profiles().find((profile) => profile.key === key);
    if (found === undefined) {
      throw new ValidationError('That identity provider is not configured.');
    }
    return found;
  }

  /**
   * Start a sign-in.
   *
   * The authorization URL carries the client id, the exact redirect URI, the state, the nonce and
   * the PKCE challenge. The verifier and the nonce stay on the server.
   */
  async start(profileKey: string): Promise<OidcSignInStart> {
    const profile = this.profile(profileKey);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = pkceChallenge(codeVerifier);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.stateTtlSeconds() * 1000);

    await this.database.db
      .insertInto('oidc_signin_states')
      .values({
        id: hashState(state),
        profile_key: profile.key,
        nonce,
        code_verifier: codeVerifier,
        redirect_uri: OIDC_REDIRECT_URI,
        created_at: now,
        expires_at: expiresAt,
        consumed_at: null,
      })
      .execute();

    const url = new URL(profile.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', profile.clientId);
    url.searchParams.set('redirect_uri', OIDC_REDIRECT_URI);
    url.searchParams.set('scope', profile.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
  }

  /**
   * Finish a sign-in.
   *
   * The order is the point: the state is consumed, the redirect URI is compared and the nonce is
   * checked **before** any business decision is made about the person.
   */
  async complete(input: {
    state: string;
    code: string;
    redirectUri?: string | null;
    error?: string | null;
    ip?: string | undefined;
  }): Promise<OidcSignInOutcome> {
    if (input.error !== undefined && input.error !== null && input.error !== '') {
      // The provider's own text is never echoed back (Phase 23.1 / G52).
      throw new ValidationError('The identity provider refused the sign-in.');
    }
    if (input.state.trim() === '') {
      throw new ValidationError('The sign-in response carried no state.');
    }
    if (input.code.trim() === '') {
      throw new ValidationError('The sign-in response carried no code.');
    }

    const row = await this.consumeState(input.state);
    if (row === null) {
      throw new ValidationError('The sign-in request is no longer valid. It may have expired or already been used.');
    }

    // The platform's own redirect URI, exactly. A callback for a different redirect is refused
    // before a code is exchanged (Phase 23.3 / G51).
    if (row.redirect_uri !== OIDC_REDIRECT_URI) {
      throw new ValidationError('The sign-in response was not made for this installation.');
    }
    if (input.redirectUri !== undefined && input.redirectUri !== null && input.redirectUri !== '') {
      if (!constantTimeEquals(input.redirectUri, row.redirect_uri)) {
        throw new ValidationError('The sign-in response was not made for this installation.');
      }
    }

    const profile = this.profile(row.profile_key);
    const tokens = await this.exchangeCode(profile, row, input.code);
    const jwks = await this.jwks(profile);
    const verified = await verifyIdToken(tokens.idToken, profile, jwks, row.nonce);
    const user = await this.resolveUser(profile, verified);
    return this.auth.sessionForExternalSignIn(user.id, user.userType, input.ip);
  }

  /** Exchange the authorization code for the provider's tokens. */
  private async exchangeCode(
    profile: OidcProfile,
    row: StateRow,
    code: string,
  ): Promise<{ readonly idToken: string }> {
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: row.redirect_uri,
      client_id: profile.clientId,
      code_verifier: row.code_verifier,
    };
    if (profile.clientSecret !== null) {
      form['client_secret'] = profile.clientSecret;
    }
    const response = await this.http.postForm(profile.tokenEndpoint, form);
    if (response.status !== 200 || typeof response.json !== 'object' || response.json === null) {
      throw new ValidationError('The identity provider refused the sign-in.');
    }
    const payload = response.json as Record<string, unknown>;
    const idToken = payload['id_token'];
    if (typeof idToken !== 'string' || idToken === '') {
      throw new ValidationError('The identity provider did not return an identity token.');
    }
    return { idToken };
  }

  /** The provider's signing keys, cached for a short while. */
  private async jwks(profile: OidcProfile): Promise<{ readonly keys: readonly JWK[] }> {
    const cached = this.jwksCache.get(profile.key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return { keys: cached.keys };
    }
    const response = await this.http.getJson(profile.jwksUri);
    if (response.status !== 200 || typeof response.json !== 'object' || response.json === null) {
      throw new ValidationError('The identity provider could not be reached.');
    }
    const keys = (response.json as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new ValidationError('The identity provider published no signing keys.');
    }
    this.jwksCache.set(profile.key, { keys: keys as JWK[], expiresAt: Date.now() + JWKS_TTL_MS });
    return { keys: keys as JWK[] };
  }

  /**
   * The account-linking rule (PLAN §17.3).
   *
   * It is explicit, and it is the same for every provider:
   *
   *  1. **An existing link wins.** The (provider, subject) pair is already bound to a local user.
   *  2. **Linking by email is a deployment decision** (`linkByEmail`). When it is on, an external
   *     identity whose email address the provider marks as verified may bind to an existing local
   *     account with that address — and only when exactly one account matches, so an address can
   *     never pick a victim.
   *  3. **Provisioning is a deployment decision** (`autoProvision`). When it is on, an unknown
   *     external identity creates a local account with the profile's default roles.
   *  4. **Otherwise the sign-in is refused.** No link, no account, no session.
   */
  private async resolveUser(
    profile: OidcProfile,
    verified: { readonly subject: string; readonly email: string | null; readonly emailVerified: boolean },
  ): Promise<{ readonly id: string; readonly userType: 'admin' | 'regular' }> {
    const db = this.database.db;
    const identity = await db
      .selectFrom('oidc_identities')
      .selectAll()
      .where('provider_key', '=', profile.key)
      .where('subject', '=', verified.subject)
      .executeTakeFirst();
    if (identity !== undefined) {
      const user = await this.activeUser(identity.user_id);
      await db
        .updateTable('oidc_identities')
        .set({ last_sign_in_at: new Date() })
        .where('id', '=', identity.id)
        .execute();
      return user;
    }

    if (profile.linkByEmail && verified.email !== null && verified.emailVerified) {
      const matches = await db
        .selectFrom('users')
        .select(['id', 'type', 'is_admin', 'is_active', 'is_deleted'])
        .where(sql`lower(email_address)`, '=', verified.email.toLowerCase())
        .where('is_deleted', '=', false)
        .execute();
      const active = matches.filter((row) => row.is_active);
      if (active.length > 1) {
        throw new ValidationError('That external account matches more than one user here. An administrator must link it.');
      }
      if (active.length === 1) {
        const user = active[0];
        if (user === undefined) {
          throw new ValidationError('That external account is not linked to a user here.');
        }
        await this.link(profile.key, verified.subject, user.id);
        return { id: user.id, userType: user.type === 'admin' || user.is_admin ? 'admin' : 'regular' };
      }
    }

    if (profile.autoProvision) {
      const created = await this.provision(profile, verified);
      await this.link(profile.key, verified.subject, created.id);
      return created;
    }

    throw new ValidationError('That external account is not linked to a user here.');
  }

  /** Bind an external identity to a local user. The (provider, subject) pair is unique. */
  private async link(providerKey: string, subject: string, userId: string): Promise<void> {
    await this.database.db
      .insertInto('oidc_identities')
      .values({
        id: randomUUID(),
        provider_key: providerKey,
        subject,
        user_id: userId,
        created_at: new Date(),
        last_sign_in_at: new Date(),
      })
      .onConflict((oc) => oc.columns(['provider_key', 'subject']).doNothing())
      .execute();
  }

  /** Create a local account for an external identity (only when the profile allows it). */
  private async provision(
    profile: OidcProfile,
    verified: { readonly subject: string; readonly email: string | null },
  ): Promise<{ readonly id: string; readonly userType: 'admin' | 'regular' }> {
    const db = this.database.db;
    const id = randomUUID();
    const userName = verified.email ?? `${profile.key}-${verified.subject}`;
    const exists = await db.selectFrom('users').select('id').where('user_name', '=', userName).executeTakeFirst();
    if (exists !== undefined) {
      throw new ValidationError('That external account cannot be provisioned here.');
    }
    await db
      .insertInto('users')
      .values({
        id,
        user_name: userName,
        email_address: verified.email,
        is_admin: false,
        is_active: true,
        type: 'regular',
        auth_method: 'oidc',
        password: null,
        assigned_role_ids: JSON.stringify(profile.defaultRoleIds),
        portal_types: JSON.stringify([]),
        totp_enabled: false,
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    return { id, userType: 'regular' };
  }

  /** The linked user, if it may still sign in. */
  private async activeUser(userId: string): Promise<{ readonly id: string; readonly userType: 'admin' | 'regular' }> {
    const row = await this.database.db
      .selectFrom('users')
      .select(['id', 'type', 'is_admin', 'is_active', 'is_deleted'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (row === undefined || !row.is_active || row.is_deleted) {
      throw new ValidationError('That user account may not sign in.');
    }
    return { id: row.id, userType: row.type === 'admin' || row.is_admin ? 'admin' : 'regular' };
  }

  /** Consume the state: single-use, hashed, expiring. */
  private async consumeState(state: string): Promise<StateRow | null> {
    const rows = await sql<StateRow>`
      update oidc_signin_states
      set consumed_at = now()
      where id = ${hashState(state)}
        and consumed_at is null
        and expires_at > now()
      returning *
    `.execute(this.database.db);
    return rows.rows[0] ?? null;
  }

  /** Remove the expired and consumed sign-in rows. */
  async purgeExpiredStates(): Promise<number> {
    const result = await sql`
      delete from oidc_signin_states
      where expires_at < now() or consumed_at is not null
    `.execute(this.database.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  private stateTtlSeconds(): number {
    return this.config.oidcStateTtlSeconds > 0 ? this.config.oidcStateTtlSeconds : DEFAULT_STATE_TTL_SECONDS;
  }
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}
