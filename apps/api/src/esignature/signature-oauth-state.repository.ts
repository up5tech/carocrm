import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { type ESignatureConnectionEnvironment } from './esignature-domain.js';
import { hashOAuthState, pkceChallengeFor } from './providers/docusign/docusign-oauth.js';

/**
 * Phase 19-ES.4 — the in-flight authorization state
 * (`PLAN_Phase_19_ESignature.md` §8.1, §9.2; `19-ES.4` task
 * "handle state verification, redirect allowlists, reauthorization … ").
 *
 * An authorization state answers one question: *is this callback the completion of a request this
 * installation started?* Four properties make that answer trustworthy, and all four live in this file
 * so no caller has to remember them:
 *
 *  - **Unguessable and short-lived.** 256 bits from `randomBytes(32)`, and a TTL. A state that has
 *    expired is not consumed, it is refused.
 *  - **Stored hashed.** The row's primary key is the SHA-256 of the state, so a database read — a
 *    backup, an analyst, a leaked dump — does not yield something to present to the callback.
 *  - **Single-use, atomically.** `consume` sets `consumed_at` in the same statement that returns the
 *    row, with `consumed_at is null` in the predicate. Two concurrent callbacks with the same state
 *    serialise on that row and exactly one of them gets it.
 *  - **Bound.** It names the connection, the provider, the **environment**, the redirect URI and the
 *    PKCE verifier. The callback derives the connection from the state — never from the request — so
 *    a callback cannot be aimed at somebody else's connection, and a state started against demo cannot
 *    complete against production (plan §9.4).
 *
 * The PKCE verifier is the one genuinely secret-shaped value in this table. It is bound to one
 * request, is only ever sent back to the identity host that issued the challenge, and disappears when
 * the row does — it is not a credential and does not go in the vault.
 */

/** How long an authorization request stays completable. Short on purpose: nobody leaves a DocuSign
 *  consent screen open for an hour. */
export const OAUTH_STATE_TTL_SECONDS = 300;

export interface NewOAuthState {
  /** The value that goes to the provider and comes back on the callback. Never persisted. */
  readonly state: string;
  readonly codeChallenge: string;
  readonly expiresAt: string;
}

export interface ConsumedOAuthState {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly environment: ESignatureConnectionEnvironment;
  readonly initiatedBy: string;
  readonly codeVerifier: string | null;
  readonly redirectUri: string;
  readonly requestedScopes: readonly string[];
  readonly expiresAt: string;
}

interface StateRow {
  id: string;
  connection_id: string;
  provider_key: string;
  environment: string;
  initiated_by: string;
  code_verifier: string | null;
  redirect_uri: string;
  requested_scopes: unknown;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

@Injectable()
export class SignatureOAuthStateRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Start a flow: generate the state and the PKCE pair, and bind them to this connection.
   *
   * Any state that is still pending for the same connection is dropped first, so re-authorizing does
   * not leave a trail of half-finished flows — and, more importantly, so an old state cannot be
   * completed after the operator started a new one.
   */
  async start(input: {
    connectionId: string;
    providerKey: string;
    environment: ESignatureConnectionEnvironment;
    initiatedBy: string;
    redirectUri: string;
    requestedScopes: readonly string[];
    ttlSeconds?: number;
  }): Promise<NewOAuthState> {
    const ttlSeconds = input.ttlSeconds ?? OAUTH_STATE_TTL_SECONDS;
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = pkceChallengeFor(codeVerifier);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // First forget the states this connection left unfinished, so re-authorizing does not leave a
    // trail of live one-shot tokens — and so an old state cannot be completed after a new one.
    await this.discardPending(input.connectionId);

    await sql`
      insert into esignature_oauth_states
        (id, connection_id, provider_key, environment, initiated_by, code_verifier, redirect_uri,
         requested_scopes, created_at, expires_at)
      values
        (${hashOAuthState(state)}, ${input.connectionId}, ${input.providerKey}, ${input.environment},
         ${input.initiatedBy}, ${codeVerifier}, ${input.redirectUri}, ${JSON.stringify([...input.requestedScopes])}::jsonb,
         ${now}, ${expiresAt})
    `.execute(this.database.db);

    return { state, codeChallenge, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Consume a state, or return `null`.
   *
   * `null` covers every refusal the callback must make indistinguishably: never issued, already used,
   * expired. The response says nothing about *which*, because that is exactly the information an
   * attacker probing the endpoint wants (plan §8.1 "callback responses must not leak").
   */
  async consume(state: string): Promise<ConsumedOAuthState | null> {
    const trimmed = state.trim();
    if (trimmed === '') return null;
    const rows = await sql<StateRow>`
      update esignature_oauth_states
      set consumed_at = now()
      where id = ${hashOAuthState(trimmed)}
        and consumed_at is null
        and expires_at >= now()
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      connectionId: row.connection_id,
      providerKey: row.provider_key,
      environment: row.environment as ESignatureConnectionEnvironment,
      initiatedBy: row.initiated_by,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
      requestedScopes: Array.isArray(row.requested_scopes) ? row.requested_scopes.filter((entry): entry is string => typeof entry === 'string') : [],
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /** Whether a connection has an authorization in flight — the admin view shows it as pending. */
  async countPending(connectionId: string): Promise<number> {
    const rows = await sql<{ n: string }>`
      select count(*)::text as n from esignature_oauth_states
      where connection_id = ${connectionId} and consumed_at is null and expires_at >= now()
    `.execute(this.database.db);
    return Number.parseInt(rows.rows[0]?.n ?? '0', 10) || 0;
  }

  /**
   * Forget every unfinished state of a connection.
   *
   * Called when a flow is superseded and when a connection is disconnected: an unfinished state is a
   * live one-shot token, and disconnecting must not leave one behind.
   */
  async discardPending(connectionId: string): Promise<number> {
    const result = await sql`
      delete from esignature_oauth_states
      where connection_id = ${connectionId} and consumed_at is null
    `.execute(this.database.db);
    return Number(result.numAffectedRows ?? 0n);
  }
}
