import { exportJWK, generateKeyPair,SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  assertOidcEndpointUrl,
  OIDC_REDIRECT_URI,
  parseOidcProfiles,
} from '../src/auth/oidc/oidc-profile.js';
import { verifyIdToken } from '../src/auth/oidc/oidc-token.js';
import { ConfigSchemaRefined } from '../src/config.js';

/**
 * Phase 23.3 (PLAN §17.3) — the OIDC profile and the id_token verification.
 *
 * Pure logic: no database, no network, no provider. Every case here runs in the DB-free CI lane.
 */

const ISSUER = 'https://issuer.example.com';
const ENDPOINTS = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  jwksUri: `${ISSUER}/jwks`,
  clientId: 'carocrm-client',
};

function profileJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{ key: 'acme', displayName: 'Acme', ...ENDPOINTS, ...overrides }]);
}

describe('phase 23.3 OIDC profile parsing', () => {
  it('reads a well-formed profile', () => {
    const profiles = parseOidcProfiles(profileJson());
    expect(profiles).toHaveLength(1);
    const profile = profiles[0];
    expect(profile?.key).toBe('acme');
    expect(profile?.redirectUri).toBe(OIDC_REDIRECT_URI);
    expect(profile?.scopes).toEqual(['openid', 'profile', 'email']);
    expect(profile?.linkByEmail).toBe(false);
    expect(profile?.autoProvision).toBe(false);
  });

  it('treats an unset profile list as "no external provider"', () => {
    expect(parseOidcProfiles('')).toEqual([]);
    expect(parseOidcProfiles('[]')).toEqual([]);
  });

  it('refuses a malformed profile list', () => {
    expect(() => parseOidcProfiles('{')).toThrow();
    expect(() => parseOidcProfiles('{"key":"acme"}')).toThrow();
    expect(() => parseOidcProfiles('[1]')).toThrow();
  });

  it('refuses a duplicated profile key', () => {
    expect(() => parseOidcProfiles(`[${JSON.stringify({ key: 'acme', ...ENDPOINTS })},${JSON.stringify({ key: 'acme', ...ENDPOINTS })}]`)).toThrow();
  });

  it('refuses a redirect URI that is not the platform constant', () => {
    expect(() => parseOidcProfiles(profileJson({ redirectUri: 'https://evil.example/callback' }))).toThrow();
  });

  it('refuses a non-https endpoint', () => {
    expect(() => parseOidcProfiles(profileJson({ tokenEndpoint: 'http://issuer.example.com/token' }))).toThrow();
  });

  it('refuses credentials inside an endpoint URL', () => {
    expect(() => parseOidcProfiles(profileJson({ tokenEndpoint: 'https://user:pass@issuer.example.com/token' }))).toThrow();
  });

  it('refuses an endpoint that targets a loopback or a metadata service', () => {
    expect(() => parseOidcProfiles(profileJson({ tokenEndpoint: 'https://127.0.0.1/token' }))).toThrow();
    expect(() => parseOidcProfiles(profileJson({ tokenEndpoint: 'https://169.254.169.254/token' }))).toThrow();
    expect(() => parseOidcProfiles(profileJson({ tokenEndpoint: 'https://10.0.0.5/token' }))).toThrow();
  });

  it('refuses a profile without a client id', () => {
    expect(() => parseOidcProfiles(profileJson({ clientId: '' }))).toThrow();
  });

  it('a malformed profile refuses the boot', () => {
    expect(() =>
      ConfigSchemaRefined.parse({ jwtSecret: 'x'.repeat(20), oidcProfiles: '[{"key":"acme"}]' }),
    ).toThrow();
  });

  it('a valid profile does not refuse the boot', () => {
    expect(() =>
      ConfigSchemaRefined.parse({ jwtSecret: 'x'.repeat(20), oidcProfiles: profileJson() }),
    ).not.toThrow();
  });

  it('the endpoint policy is applied on its own', () => {
    expect(() => assertOidcEndpointUrl('https://issuer.example.com/token', 'token endpoint')).not.toThrow();
    expect(() => assertOidcEndpointUrl('http://issuer.example.com/token', 'token endpoint')).toThrow();
  });
});

describe('phase 23.3 id_token verification', () => {
  async function keyPair() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    return { jwk: { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }, privateKey };
  }

  async function mint(
    privateKey: CryptoKey,
    claims: Record<string, unknown>,
    header: Record<string, unknown> = { alg: 'RS256', kid: 'test-key' },
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader(header)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  const profile = {
    key: 'acme',
    displayName: 'Acme',
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/jwks`,
    clientId: 'carocrm-client',
    clientSecret: null,
    redirectUri: OIDC_REDIRECT_URI,
    scopes: ['openid'],
    linkByEmail: false,
    autoProvision: false,
    defaultRoleIds: [],
  };

  it('accepts a valid token', async () => {
    const { jwk, privateKey } = await keyPair();
    const token = await mint(privateKey, {
      iss: ISSUER,
      aud: 'carocrm-client',
      sub: 'user-1',
      nonce: 'the-nonce',
      email: 'person@example.com',
      email_verified: true,
    });
    const verified = await verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce');
    expect(verified.subject).toBe('user-1');
    expect(verified.email).toBe('person@example.com');
    expect(verified.emailVerified).toBe(true);
  });

  it('refuses a token signed by another key', async () => {
    const { jwk } = await keyPair();
    const other = await keyPair();
    const token = await mint(other.privateKey, {
      iss: ISSUER,
      aud: 'carocrm-client',
      sub: 'user-1',
      nonce: 'the-nonce',
    });
    await expect(verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses another issuer', async () => {
    const { jwk, privateKey } = await keyPair();
    const token = await mint(privateKey, {
      iss: 'https://evil.example.com',
      aud: 'carocrm-client',
      sub: 'user-1',
      nonce: 'the-nonce',
    });
    await expect(verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses another audience', async () => {
    const { jwk, privateKey } = await keyPair();
    const token = await mint(privateKey, {
      iss: ISSUER,
      aud: 'another-client',
      sub: 'user-1',
      nonce: 'the-nonce',
    });
    await expect(verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses an expired token', async () => {
    const { jwk, privateKey } = await keyPair();
    const token = await new SignJWT({
      iss: ISSUER,
      aud: 'carocrm-client',
      sub: 'user-1',
      nonce: 'the-nonce',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(privateKey);
    await expect(verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses another nonce', async () => {
    const { jwk, privateKey } = await keyPair();
    const token = await mint(privateKey, {
      iss: ISSUER,
      aud: 'carocrm-client',
      sub: 'user-1',
      nonce: 'another-nonce',
    });
    await expect(verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses a token with no nonce at all', async () => {
    const { jwk, privateKey } = await keyPair();
    const token = await mint(privateKey, { iss: ISSUER, aud: 'carocrm-client', sub: 'user-1' });
    await expect(verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses an unsigned token', async () => {
    const { jwk } = await keyPair();
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: 'carocrm-client', sub: 'user-1', nonce: 'the-nonce' }),
    ).toString('base64url');
    await expect(verifyIdToken(`${header}.${payload}.`, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses a token with several audiences and no authorized party', async () => {
    const { jwk, privateKey } = await keyPair();
    const token = await mint(privateKey, {
      iss: ISSUER,
      aud: ['carocrm-client', 'another-client'],
      sub: 'user-1',
      nonce: 'the-nonce',
    });
    await expect(verifyIdToken(token, profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });

  it('refuses a malformed token', async () => {
    const { jwk } = await keyPair();
    await expect(verifyIdToken('not-a-jwt', profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
    await expect(verifyIdToken('', profile, { keys: [jwk] }, 'the-nonce')).rejects.toThrow();
  });
});
