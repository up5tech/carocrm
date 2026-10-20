import { Inject, Injectable } from '@nestjs/common';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { runAsAdvancedIntegrationsSystem } from './advanced-integrations-authority.js';
import { ConnectionLifecycleService,CREDENTIAL_VAULT } from './connection-lifecycle.service.js';
import type { ConnectorAdapter, ConnectorContext } from './connector-adapter.port.js';
import type { CredentialVaultPort } from './credential-vault.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { ProviderError } from './provider-error.js';
import {
  type CircuitOptions,
  DEFAULT_CIRCUIT_OPTIONS,
  ProviderCircuitBreaker,
  ProviderRateLimiter,
  type RateLimitOptions,
} from './resilience.js';

/**
 * Phase 19-INT.6 / 19-INT.11 — the connector executor
 * (`PLAN_Phase_19_Advanced_Integrations.md` §11.1; `19-INT.6`, `19-INT.11`).
 *
 * The executor is the **only** path from the engine to a connector. It is where the reliability
 * rules are applied, so no engine code can accidentally call a provider without them:
 *
 *  - the connection's state is checked — a paused, revoked or reauthorization-required connection
 *    is never called;
 *  - the credential is resolved from the vault and handed to the adapter, never logged;
 *  - the **rate limiter** decides whether the call may be made at all;
 *  - the **circuit breaker** refuses the call when the provider is failing;
 *  - the outcome is reported to the breaker, so a failing provider opens the circuit.
 *
 * The executor runs background work under the documented service authority, so a job has no user
 * session and the platform's own authorization engine is not bypassed by a special case.
 */

export interface ConnectorCallOptions {
  /** The provider rate limit for this connection. */
  readonly rateLimit?: RateLimitOptions | undefined;
  /** The circuit breaker settings for this connection. */
  readonly circuit?: CircuitOptions | undefined;
}

export interface ConnectorCallResult<T> {
  readonly value: T;
}

@Injectable()
export class ConnectorExecutor {
  constructor(
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(ProviderRateLimiter) private readonly limiter: ProviderRateLimiter,
    @Inject(ProviderCircuitBreaker) private readonly breaker: ProviderCircuitBreaker,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVaultPort,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Run a provider operation with the reliability rules applied.
   *
   * The operation is a closure over a resolved context, so the caller never handles the credential
   * itself.
   */
  async call<T>(
    connectionId: string,
    operation: (context: ConnectorContext, adapter: ConnectorAdapter) => Promise<T>,
    options: ConnectorCallOptions = {},
  ): Promise<T> {
    return runAsAdvancedIntegrationsSystem(this.scope, `connector:${connectionId}`, () =>
      this.callUnderServiceAuthority(connectionId, operation, options),
    );
  }

  private async callUnderServiceAuthority<T>(
    connectionId: string,
    operation: (context: ConnectorContext, adapter: ConnectorAdapter) => Promise<T>,
    options: ConnectorCallOptions,
  ): Promise<T> {
    const connection = await this.connections.get(connectionId);
    // A paused, revoked or reauthorization-required connection is never called.
    if (connection.status !== 'connected' && connection.status !== 'degraded') {
      throw new ProviderError('CONFIGURATION_INVALID', `A connection in "${connection.status}" may not call the provider.`, {
        category: 'configuration_invalid',
        retryable: false,
        detail: `status:${connection.status}`,
      });
    }
    const definition = this.registry.requireExecutable(connection.providerKey);
    const adapter = definition.adapter;
    if (adapter === null) {
      throw new ProviderError('CONFIGURATION_INVALID', `Provider "${connection.providerKey}" has no connector bound.`, {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'no_adapter',
      });
    }

    const circuitKey = `conn:${connectionId}`;
    if (options.rateLimit) {
      const decision = await this.limiter.consume(circuitKey, options.rateLimit);
      if (!decision.allowed) {
        throw new ProviderError('RATE_LIMITED', 'The provider rate limit was reached.', {
          category: 'rate_limited',
          retryable: true,
          retryAfterMs: decision.retryAfterMs,
          detail: 'rate_limited',
        });
      }
    }
    await this.breaker.beforeRequest(circuitKey);

    const context = await this.buildContext(connectionId, connection.providerKey, connection.tenantRef);
    try {
      const value = await operation(context, adapter);
      await this.breaker.recordSuccess(circuitKey);
      return value;
    } catch (error) {
      await this.breaker.recordFailure(circuitKey, error, options.circuit ?? DEFAULT_CIRCUIT_OPTIONS);
      throw error;
    }
  }

  /**
   * Resolve the credential the adapter receives.
   *
   * The vault is the only source. The value is handed to the adapter and never logged, never
   * stored in a run row and never returned by an API.
   */
  private async buildContext(
    connectionId: string,
    providerKey: string,
    tenantRef: string | null,
  ): Promise<ConnectorContext> {
    const accessToken = await this.vault.read({ connectionId, kind: 'oauth_access_token' });
    const refreshToken = await this.vault.read({ connectionId, kind: 'oauth_refresh_token' });
    const apiKey = await this.vault.read({ connectionId, kind: 'api_key' });
    const clientSecret = await this.vault.read({ connectionId, kind: 'client_secret' });
    const access = await this.vault.describe({ connectionId, kind: 'oauth_access_token' });
    return {
      connectionId,
      providerKey,
      tenantRef,
      credential: {
        accessToken,
        refreshToken,
        apiKey,
        clientSecret,
        expiresAt: access?.expiresAt ?? null,
      },
    };
  }
}
