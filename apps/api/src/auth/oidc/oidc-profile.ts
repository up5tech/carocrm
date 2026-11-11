/**
 * Phase 23.3 (PLAN §17.3) — the OIDC profile: what an external identity provider is, in this
 * installation.
 *
 * A profile is **configuration**, not code. Google, Microsoft and every other OpenID Connect
 * provider are the same shape with different values, so the identity service carries no
 * provider-specific logic: it reads a profile and speaks the standard protocol. (PLAN §17.3 —
 * "Use provider adapters rather than embedding provider-specific logic into the identity service.")
 *
 * The rules a profile must satisfy, checked when the configuration is read so a misconfiguration
 * refuses the boot instead of failing on the first sign-in:
 *
 *  - the endpoints are **https** and carry no credentials;
 *  - the endpoints do not point at a loopback, link-local or cloud-metadata address;
 *  - the **redirect URI is the platform's own constant**, exactly. A profile that names another
 *    redirect URI is refused: the platform would send a URI the provider does not have registered,
 *    and the callback comparison would have nothing exact to compare against;
 *  - the client id is present; the client secret is optional (a public client with PKCE needs none).
 */

import { ValidationError } from '@carocrm/core/errors/index.js';

/** The only path the provider may redirect the browser back to. */
export const OIDC_CALLBACK_PATH = '/api/v1/Oidc/callback';

/** The only redirect URI the platform will ever send to an OIDC provider. */
export const OIDC_REDIRECT_URI = OIDC_CALLBACK_PATH;

/** A profile key: lowercase letters, digits and hyphens — the same shape as a provider key. */
export const OIDC_PROFILE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** The scopes an OIDC sign-in needs when a profile does not say otherwise. */
export const DEFAULT_OIDC_SCOPES = ['openid', 'profile', 'email'] as const;

export interface OidcProfile {
  /** The profile's key, e.g. `google`. */
  readonly key: string;
  /** The name shown to a person choosing an identity provider. */
  readonly displayName: string;
  /** The exact issuer string the id_token must carry. */
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Where the signing keys are fetched from. */
  readonly jwksUri: string;
  readonly clientId: string;
  /** Absent for a public client that authenticates with PKCE alone. */
  readonly clientSecret: string | null;
  /** The redirect URI. Always `OIDC_REDIRECT_URI` — the parser refuses anything else. */
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /**
   * Whether a verified email address may bind an external identity to an **existing** local
   * account. Off by default: linking by email is a deliberate deployment decision.
   */
  readonly linkByEmail: boolean;
  /**
   * Whether an unknown external identity may create a local account. Off by default: an
   * installation that provisions accounts itself keeps full control over who may sign in.
   */
  readonly autoProvision: boolean;
  /** The roles a provisioned account receives. */
  readonly defaultRoleIds: readonly string[];
}

/** The endpoint hosts a profile may never use. */
const FORBIDDEN_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * The endpoint URL policy.
 *
 * A profile's endpoints are operator configuration, not user input, so this is not the SSRF
 * boundary of 23.5 — it is a *misconfiguration* boundary: a typo (or a copied example) must not
 * point the identity service at the loopback interface or a cloud metadata service.
 */
export function assertOidcEndpointUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`The OIDC ${label} is not a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new ValidationError(`The OIDC ${label} must use https.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ValidationError(`The OIDC ${label} must not carry credentials.`);
  }
  if (FORBIDDEN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ValidationError(`The OIDC ${label} must not target "${url.hostname}".`);
  }
  if (/^10\./.test(url.hostname) || /^192\.168\./.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) {
    throw new ValidationError(`The OIDC ${label} must not target a private network address.`);
  }
  return value;
}

interface RawProfile {
  readonly key?: unknown;
  readonly displayName?: unknown;
  readonly issuer?: unknown;
  readonly authorizationEndpoint?: unknown;
  readonly tokenEndpoint?: unknown;
  readonly jwksUri?: unknown;
  readonly clientId?: unknown;
  readonly clientSecret?: unknown;
  readonly redirectUri?: unknown;
  readonly scopes?: unknown;
  readonly linkByEmail?: unknown;
  readonly autoProvision?: unknown;
  readonly defaultRoleIds?: unknown;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`The OIDC profile is missing "${label}".`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`The OIDC profile field "${label}" must be true or false.`);
  }
  return value;
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new ValidationError(`The OIDC profile field "${label}" must be a list of non-empty strings.`);
  }
  return (value as string[]).map((entry) => entry.trim());
}

/**
 * Parse the configured profiles.
 *
 * The raw value is a JSON array of profile objects (`OIDC_PROFILES`). An empty array means the
 * installation has no external identity provider, which is the default and the safe state.
 */
export function parseOidcProfiles(raw: string): readonly OidcProfile[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ValidationError('OIDC_PROFILES must be a JSON array of profile objects.');
  }
  if (!Array.isArray(parsed)) {
    throw new ValidationError('OIDC_PROFILES must be a JSON array of profile objects.');
  }
  const profiles: OidcProfile[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ValidationError('Every OIDC profile must be an object.');
    }
    const raw = entry as RawProfile;
    const key = requireString(raw.key, 'key');
    if (!OIDC_PROFILE_KEY_PATTERN.test(key)) {
      throw new ValidationError(`The OIDC profile key "${key}" is not valid.`);
    }
    if (seen.has(key)) {
      throw new ValidationError(`The OIDC profile key "${key}" is configured twice.`);
    }
    seen.add(key);

    const redirectUri = raw.redirectUri === undefined ? OIDC_REDIRECT_URI : requireString(raw.redirectUri, 'redirectUri');
    if (redirectUri !== OIDC_REDIRECT_URI) {
      // Exact match only. The platform owns the callback path, so a profile that names another
      // redirect URI is a misconfiguration, not a feature.
      throw new ValidationError(
        `The OIDC profile "${key}" must use the platform's redirect URI "${OIDC_REDIRECT_URI}".`,
      );
    }

    const scopes = stringList(raw.scopes, 'scopes');
    const clientSecret = raw.clientSecret === undefined ? null : requireString(raw.clientSecret, 'clientSecret');

    profiles.push({
      key,
      displayName: raw.displayName === undefined ? key : requireString(raw.displayName, 'displayName'),
      issuer: assertOidcEndpointUrl(requireString(raw.issuer, 'issuer'), 'issuer'),
      authorizationEndpoint: assertOidcEndpointUrl(
        requireString(raw.authorizationEndpoint, 'authorizationEndpoint'),
        'authorization endpoint',
      ),
      tokenEndpoint: assertOidcEndpointUrl(requireString(raw.tokenEndpoint, 'tokenEndpoint'), 'token endpoint'),
      jwksUri: assertOidcEndpointUrl(requireString(raw.jwksUri, 'jwksUri'), 'JWKS URI'),
      clientId: requireString(raw.clientId, 'clientId'),
      clientSecret,
      redirectUri,
      scopes: scopes.length === 0 ? [...DEFAULT_OIDC_SCOPES] : scopes,
      linkByEmail: optionalBoolean(raw.linkByEmail, 'linkByEmail'),
      autoProvision: optionalBoolean(raw.autoProvision, 'autoProvision'),
      defaultRoleIds: stringList(raw.defaultRoleIds, 'defaultRoleIds'),
    });
  }
  return profiles;
}
