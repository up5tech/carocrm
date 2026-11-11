import { exportJWK, generateKeyPair,SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FetchOidcHttp,OIDC_HTTP_PORT } from '../src/auth/oidc/oidc-http.port.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 23.3 (PLAN §17.3) — the generic OIDC sign-in, end to end against a **fake** provider.
 *
 * No live token endpoint, no provider credentials, no network: the outbound HTTP port is replaced
 * with a fake that answers with a token this test signs itself.
 *
 * The cases the plan names: valid, invalid, stale, mismatched-redirect, replayed and malformed.
 */

const ISSUER = 'https://idp.example.com';
const PROFILE_KEY = 'fake-idp';
/**
 * A run marker. Every account this suite creates carries it, so a run never collides with the
 * records of an earlier one and every record can be positively identified for cleanup
 * (AGENTS.MD §3.3).
 */
const runId = Date.now().toString(36);

process.env.OIDC_PROFILES = JSON.stringify([
  {
    key: PROFILE_KEY,
    displayName: 'Fake IdP',
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/jwks`,
    clientId: 'carocrm-test-client',
    linkByEmail: true,
    autoProvision: true,
    defaultRoleIds: [],
  },
]);

interface FakeProvider {
  readonly postForm: (url: string, form: Readonly<Record<string, string>>) => Promise<{ status: number; json: unknown }>;
  readonly getJson: (url: string) => Promise<{ status: number; json: unknown }>;
}

let ctx: ApiContext;
let keys: { jwk: unknown; privateKey: CryptoKey };
let fake: FakeProvider;
let issuedIdToken = '';
let tokenRequests = 0;
const createdUserIds: string[] = [];

async function mintIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

function startUrl(): string {
  return `/api/v1/Oidc/start?profile=${PROFILE_KEY}`;
}

async function beginSignIn(): Promise<{ state: string; nonce: string }> {
  const res = await ctx.app.inject({ method: 'GET', url: startUrl() });
  expect(res.statusCode).toBe(302);
  const location = res.headers['location'] ?? '';
  const url = new URL(String(location));
  const state = url.searchParams.get('state');
  const nonce = url.searchParams.get('nonce');
  expect(state).toBeTruthy();
  expect(nonce).toBeTruthy();
  return { state: String(state), nonce: String(nonce) };
}

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const cookies = response.headers['set-cookie'];
  const list = Array.isArray(cookies) ? cookies : cookies === undefined ? [] : [String(cookies)];
  return list
    .map((entry) => String(entry).split(';')[0] ?? '')
    .filter((entry) => entry !== '')
    .join('; ');
}

beforeAll(async () => {
  ctx = await bootApi();
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  keys = { jwk: { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }, privateKey: pair.privateKey };

  const http = ctx.app.get<FetchOidcHttp>(OIDC_HTTP_PORT);
  fake = {
    postForm: async () => {
      tokenRequests += 1;
      return { status: 200, json: { id_token: issuedIdToken } };
    },
    getJson: async () => ({ status: 200, json: { keys: [keys.jwk] } }),
  };
  Object.assign(http, fake);
});

afterAll(async () => {
  // Clean up only what this run created (AGENTS.MD §3.3). Every account and every identity this
  // suite creates carries the run marker, so the cleanup is exact and never touches a record of
  // another run.
  const db = ctx.database.db;
  for (const userId of createdUserIds) {
    await db.deleteFrom('users').where('id', '=', userId).execute();
  }
  // The accounts the platform provisions itself are named after the run marker — the email of a
  // provisioned account, or `fake-idp-<subject>` — so they are found by that marker rather than by
  // a captured id.
  await db.deleteFrom('users').where('user_name', 'like', `%${runId}`).execute();
  await db
    .deleteFrom('oidc_identities')
    .where('provider_key', '=', PROFILE_KEY)
    .where('subject', 'like', `%-${runId}`)
    .execute();
  await db.deleteFrom('oidc_signin_states').where('profile_key', '=', PROFILE_KEY).execute();
  await shutdownApi();
});

describe('phase 23.3 OIDC sign-in — the provider list', () => {
  it('offers the configured providers without a secret', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/Oidc/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { list: { key: string; displayName: string }[] };
    expect(body.list.map((entry) => entry.key)).toContain(PROFILE_KEY);
    expect(JSON.stringify(body)).not.toContain('clientSecret');
    expect(JSON.stringify(body)).not.toContain('carocrm-test-client');
  });

  it('refuses an unknown provider', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/Oidc/start?profile=nope' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('phase 23.3 OIDC sign-in — the callback', () => {
  it('completes a valid sign-in and issues the session cookies', async () => {
    const { state, nonce } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-valid-${runId}`,
      nonce,
      email: `oidc-valid-${runId}@example.com`,
      email_verified: true,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toBe('/');
    const cookies = cookieHeader(res);
    expect(cookies).toContain('CRM-SESSION=');
    expect(cookies).toContain('CRM-REFRESH=');
    expect(cookies).toContain('CRM-CSRF=');

    // The provisioned account can use the session the way the SPA does.
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: { cookie: cookies } });
    expect(me.statusCode).toBe(200);
    const principal = me.json() as { userName: string };
    expect(principal.userName).toBe(`oidc-valid-${runId}@example.com`);
    const row = await ctx.database.db
      .selectFrom('users')
      .select('id')
      .where('user_name', '=', `oidc-valid-${runId}@example.com`)
      .executeTakeFirst();
    if (row !== undefined) createdUserIds.push(row.id);
  });

  it('refuses a stale state', async () => {
    const { state, nonce } = await beginSignIn();
    await ctx.database.db
      .updateTable('oidc_signin_states')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('id', '=', await stateId(state))
      .execute();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-stale-${runId}`,
      nonce,
    });
    const before = tokenRequests;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toContain('oidc_error=');
    // A stale state never reaches the token endpoint.
    expect(tokenRequests).toBe(before);
  });

  it('refuses a replayed state', async () => {
    const { state, nonce } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-replay-${runId}`,
      nonce,
    });
    const first = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    expect(first.statusCode).toBe(302);
    expect(String(first.headers['location'] ?? '')).toBe('/');
    const second = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    expect(second.statusCode).toBe(302);
    expect(String(second.headers['location'] ?? '')).toContain('oidc_error=');
    expect(cookieHeader(second)).not.toContain('CRM-SESSION=');
  });

  it('refuses a mismatched redirect URI before exchanging the code', async () => {
    const { state, nonce } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-redirect-${runId}`,
      nonce,
    });
    const before = tokenRequests;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code&redirect_uri=${encodeURIComponent('https://evil.example/callback')}`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toContain('oidc_error=');
    // The refusal happens **before** the code is exchanged.
    expect(tokenRequests).toBe(before);
  });

  it('accepts the exact redirect URI the platform sent', async () => {
    const { state, nonce } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-redirect-ok-${runId}`,
      nonce,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code&redirect_uri=${encodeURIComponent('/api/v1/Oidc/callback')}`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toBe('/');
  });

  it('refuses a malformed callback', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/Oidc/callback' });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toContain('oidc_error=');
    expect(cookieHeader(res)).not.toContain('CRM-SESSION=');
  });

  it('refuses a provider error without echoing it', async () => {
    const { state } = await beginSignIn();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=${encodeURIComponent('the provider said no')}`,
    });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers['location'] ?? '');
    expect(location).toContain('oidc_error=');
    expect(location).not.toContain('access_denied');
    expect(location).not.toContain('the provider said no');
  });

  it('refuses an id_token minted for another nonce', async () => {
    const { state } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-nonce-${runId}`,
      nonce: 'another-nonce',
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toContain('oidc_error=');
    expect(cookieHeader(res)).not.toContain('CRM-SESSION=');
  });

  it('refuses an id_token with another audience', async () => {
    const { state, nonce } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'another-client',
      sub: `subject-audience-${runId}`,
      nonce,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toContain('oidc_error=');
  });
});

describe('phase 23.3 OIDC account linking', () => {
  it('links an external identity to an existing account by a verified email', async () => {
    const created = await ctx.database.db
      .insertInto('users')
      .values({
        id: `oidc_link_${runId}`,
        user_name: `oidc_link_${runId}`,
        email_address: `oidc-linked-${runId}@example.com`,
        is_admin: false,
        is_active: true,
        type: 'regular',
        auth_method: 'password',
        password: null,
        assigned_role_ids: JSON.stringify([]),
        portal_types: JSON.stringify([]),
        totp_enabled: false,
        is_deleted: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .returning('id')
      .executeTakeFirst();
    const userId = created?.id ?? '';
    createdUserIds.push(userId);

    const { state, nonce } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-linked-${runId}`,
      nonce,
      email: `oidc-linked-${runId}@example.com`,
      email_verified: true,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'] ?? '')).toBe('/');

    const identity = await ctx.database.db
      .selectFrom('oidc_identities')
      .selectAll()
      .where('provider_key', '=', PROFILE_KEY)
      .where('subject', '=', `subject-linked-${runId}`)
      .executeTakeFirst();
    expect(identity?.user_id).toBe(userId);
  });

  it('refuses an unverified email that matches an account', async () => {
    const { state, nonce } = await beginSignIn();
    issuedIdToken = await mintIdToken({
      iss: ISSUER,
      aud: 'carocrm-test-client',
      sub: `subject-unverified-${runId}`,
      nonce,
      email: `oidc-linked-${runId}@example.com`,
      email_verified: false,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Oidc/callback?state=${encodeURIComponent(state)}&code=the-code`,
    });
    // The email is not verified, so the identity cannot be bound to that account; the profile
    // provisions its own account instead of taking over the existing one.
    expect(res.statusCode).toBe(302);
    const identity = await ctx.database.db
      .selectFrom('oidc_identities')
      .select('user_id')
      .where('provider_key', '=', PROFILE_KEY)
      .where('subject', '=', `subject-unverified-${runId}`)
      .executeTakeFirst();
    // The account that was linked before — the one an attacker would try to take over.
    const existing = await ctx.database.db
      .selectFrom('users')
      .select('id')
      .where('user_name', '=', `oidc_link_${runId}`)
      .executeTakeFirst();
    expect(identity?.user_id).not.toBe(existing?.id);
    // The identity got an account of its own instead.
    expect(identity?.user_id).toBeTruthy();
    if (identity !== undefined) {
      const row = await ctx.database.db.selectFrom('users').select('id').where('id', '=', identity.user_id).executeTakeFirst();
      if (row !== undefined) createdUserIds.push(row.id);
    }
  });
});

/** The state row id is the SHA-256 of the state. */
async function stateId(state: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(state).digest('hex');
}
