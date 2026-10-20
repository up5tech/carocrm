import { ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-INT.2 — the `AdvancedIntegrations` domain vocabulary
 * (`PLAN_Phase_19_Advanced_Integrations.md` §6, §7.1; `19-INT.2`).
 *
 * The module owns the *control plane* of connectivity: which providers exist, how a connection is
 * configured, how it is authorized, and what it is allowed to do. It does not own the CRM records
 * a connection syncs.
 *
 * Two decisions shape everything here:
 *
 *  1. **Connections are control-plane state, not CRM records.** They live in their own table, not
 *     in `entity_records`. A metadata entity is reachable through the generic `/api/v1/:entity`
 *     API, and a `PATCH /api/v1/IntegrationConnection/:id` would move a connection between states
 *     without passing the state machine below. That is why the platform's ACL resources here are
 *     *synthetic* names — the same pattern `VoiceProviderAccount` already uses.
 *  2. **A secret is referenced, never embedded.** A connection carries a credential reference id;
 *     the ciphertext lives in its own table behind a vault port (ADR 0001). Nothing in this file
 *     ever holds a plaintext credential.
 *
 * The state machine is explicit and validated. `paused`, `revoked` and `reauthorization_required`
 * are **not** permission to call the provider — a job must not read them as "retry later".
 */

/** The module key. Used for the settings row, the catalog key and the log namespace. */
export const ADVANCED_INTEGRATIONS_MODULE_KEY = 'AdvancedIntegrations';

/**
 * ACL resources.
 *
 * These are *synthetic* permission resources: the platform has one authorization engine, and a
 * module right is an ACL resource evaluated by `AclApiService`, so the request-scoped role
 * snapshot, the `sysAdmin` bypass and the wildcard rule all apply unchanged (the pattern
 * `apps/api/src/ai-agents/ai-agents-permission.service.ts` established).
 *
 * No role is created by this module. `sysAdmin` holds the platform wildcard `*` and therefore every
 * capability; the default user role holds `{}` and therefore none. A non-administrator cannot list
 * providers, read connections, or start an OAuth flow even when a connector is registered.
 */
export const INTEGRATION_PERMISSION_ENTITY = 'AdvancedIntegrations';
export const INTEGRATION_PROVIDER_PERMISSION_ENTITY = 'IntegrationProvider';
export const INTEGRATION_CREDENTIAL_PERMISSION_ENTITY = 'IntegrationCredential';
export const INTEGRATION_CONNECTION_PERMISSION_ENTITY = 'IntegrationConnection';
export const INTEGRATION_SETTINGS_PERMISSION_ENTITY = 'AdvancedIntegrationsSettings';
/**
 * The redacted diagnostics (plan §14.1 `advancedIntegrations.viewLogs`).
 *
 * Its own resource, because the diagnostics are **more sensitive** than the module's own read
 * capability: they show what a provider sent, and the plan asks for them to be visible only to an
 * administrator who holds a diagnostic right.
 */
export const INTEGRATION_DIAGNOSTIC_PERMISSION_ENTITY = 'IntegrationDiagnostic';

// ---------------------------------------------------------------------------
// connection lifecycle
// ---------------------------------------------------------------------------

export const CONNECTION_STATUSES = [
  'draft',
  'pending_authorization',
  'connected',
  'degraded',
  'reauthorization_required',
  'paused',
  'revoked',
  'error',
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_OWNER_TYPES = ['organization', 'user'] as const;
export type ConnectionOwnerType = (typeof CONNECTION_OWNER_TYPES)[number];

/**
 * The state machine (feature contract §5.1).
 *
 * A transition that is not listed here is refused. `revoked` is terminal for provider calls and
 * may only move to `deleted`.
 */
export const CONNECTION_TRANSITIONS: Readonly<Record<ConnectionStatus, readonly ConnectionStatus[]>> = {
  draft: ['pending_authorization', 'revoked', 'error'],
  // An authorization that comes back with insufficient scopes leaves the connection needing
  // reauthorization, so that move must be legal.
  pending_authorization: ['connected', 'reauthorization_required', 'draft', 'error', 'revoked'],
  connected: ['degraded', 'reauthorization_required', 'paused', 'revoked', 'error'],
  degraded: ['connected', 'reauthorization_required', 'paused', 'revoked', 'error'],
  reauthorization_required: ['connected', 'pending_authorization', 'revoked', 'error'],
  paused: ['connected', 'revoked', 'error'],
  revoked: [],
  error: ['draft', 'pending_authorization', 'revoked'],
};

/**
 * States in which the platform must **not** call the provider.
 *
 * `paused` is paused on purpose, `revoked` means the grant is gone, and
 * `reauthorization_required` means the credential is no longer usable. A job that treats any of
 * them as "retry later" would hammer a provider the operator deliberately stopped.
 */
export const NON_CALLABLE_CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'draft',
  'pending_authorization',
  'paused',
  'revoked',
  'reauthorization_required',
];

export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return typeof value === 'string' && (CONNECTION_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return CONNECTION_TRANSITIONS[from].includes(to);
}

/** Validates a transition, or refuses it with the states that *would* be legal. */
export function assertTransition(from: ConnectionStatus, to: ConnectionStatus): void {
  if (canTransition(from, to)) return;
  const allowed = CONNECTION_TRANSITIONS[from];
  throw new ValidationError(
    allowed.length === 0
      ? `A connection in "${from}" cannot change state any further.`
      : `A connection in "${from}" cannot move to "${to}". Allowed: ${allowed.join(', ')}.`,
    { from, to, allowed: [...allowed] },
  );
}

/** Refuses a connection whose state does not permit a provider call. */
export function assertCallable(status: ConnectionStatus): void {
  if (!NON_CALLABLE_CONNECTION_STATUSES.includes(status)) return;
  throw new ValidationError(
    `A connection in "${status}" may not call the provider.`,
    { status, nonCallable: [...NON_CALLABLE_CONNECTION_STATUSES] },
  );
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

export const SECRET_KINDS = [
  'oauth_access_token',
  'oauth_refresh_token',
  'client_secret',
  'api_key',
  'webhook_secret',
  'signing_secret',
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

export const CREDENTIAL_STATES = ['active', 'revoked'] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

/**
 * A key whose value is a credential.
 *
 * Used twice: to refuse a plaintext credential smuggled through an ordinary configuration field
 * (the platform's existing convention in `VoiceProviderAccountsService`), and to redact a payload
 * before it is logged or returned.
 */
export const SECRET_KEY_PATTERN =
  /secret|token|password|credential|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?id|authorization|cookie|session/i;

/** True when a configuration key looks like it holds a credential. */
export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * A short, non-secret hint that lets an operator recognise a credential without disclosing it.
 *
 * The first and last two characters survive; everything between is masked. A credential shorter
 * than eight characters is masked completely — there is nothing safe to reveal about it.
 */
export function secretHint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length < 8) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${'*'.repeat(Math.min(8, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

/**
 * Deeply replaces credential-shaped values with a marker.
 *
 * Only the value of a **credential-shaped key** is replaced; every other value is preserved. A
 * payload's ordinary text is often the useful part of a diagnostic, and blanking it would make
 * the redaction useless.
 *
 * Applied where a value crosses a trust boundary — a structured log payload, a response body —
 * rather than at each call site, so a new call site cannot forget to redact.
 */
export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return redactContainer(value, 0) as T;
}

const MAX_REDACTION_DEPTH = 12;

function redactContainer(container: object, depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) return '[truncated]';
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(container as Record<string, unknown>)) {
    out[key] = looksLikeSecretKey(key) ? '[redacted]' : redactEntry(entry, depth + 1);
  }
  return out;
}

function redactEntry(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactEntry(entry, depth + 1));
  return redactContainer(value, depth);
}

/**
 * The value a configuration field may hold.
 *
 * A field whose *key* looks like a credential may not hold one: credentials belong in the vault.
 * This is the platform's existing rule, applied here to the module's own configuration objects.
 */
export function assertConfigIsSafe(config: Record<string, unknown>): void {
  for (const key of Object.keys(config)) {
    if (!looksLikeSecretKey(key)) continue;
    throw new ValidationError(
      `"${key}" looks like a credential and cannot be stored as configuration. Store it as a credential instead.`,
      { key },
    );
  }
}
