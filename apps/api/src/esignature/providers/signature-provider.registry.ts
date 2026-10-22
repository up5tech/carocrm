import { Inject, Injectable, Optional } from '@nestjs/common';

import { providerNotConnectedError } from '../esignature-errors.js';
import { NotSupportedByProviderError } from './signature-provider.errors.js';
import {
  adapterSupports,
  assertAdapterContract,
  type FutureSignatureProviderOperation,
  type SignatureProviderAdapter,
  type SignatureProviderCapabilities,
  type SignatureProviderOperation,
} from './signature-provider.port.js';

/**
 * Phase 19-ES.3 — the adapter registry
 * (`PLAN_Phase_19_ESignature.md` §5.2, §9.1, §9.4; audit §5.1; `19-ES.3`).
 *
 * One place decides *which* adapter answers for a provider key, and the decision has two hard edges:
 *
 * - **A fake never answers in production.** A test double that can be reached by production code is a
 *   signature request that never existed, reported as sent. The guard refuses registration, the way
 *   `VoiceProviderRegistry` fails closed to a disabled provider
 *   (`apps/api/src/voice-communications/voice-provider.ts:650-657`) and the way the connector
 *   registrar withholds its fake outside production
 *   (`apps/api/src/advanced-integrations/connector-registrar.service.ts:243`).
 * - **An unimplemented capability is refused before the call.** `assertOperation` asks the adapter's
 *   declared `capabilities` and throws `NotSupportedByProviderError`, so no code path can discover at
 *   runtime that voiding a contract "doesn't do anything" (plan §5.2).
 *
 * An adapter that declares an operation it has no method for is rejected at registration by
 * `assertAdapterContract`, which is what keeps the declaration from drifting from the implementation —
 * the same reason the connector catalog registers adapters in code rather than in configuration.
 */

export const SIGNATURE_PROVIDER_ADAPTERS = Symbol('SIGNATURE_PROVIDER_ADAPTERS');

export interface SignatureProviderDescriptor {
  readonly providerKey: string;
  readonly mode: SignatureProviderAdapter['mode'];
  readonly adapterVersion: string;
  readonly providerApiVersion: string;
  readonly capabilities: SignatureProviderCapabilities;
}

@Injectable()
export class SignatureProviderRegistry {
  private readonly adapters = new Map<string, SignatureProviderAdapter>();

  constructor(
    @Optional() @Inject(SIGNATURE_PROVIDER_ADAPTERS) injected?: readonly SignatureProviderAdapter[],
  ) {
    for (const adapter of injected ?? []) this.register(adapter);
  }

  /**
   * Register an adapter.
   *
   * Two adapters may not answer for the same provider key: a silent "last one wins" would let a test
   * double shadow a live integration depending on startup order.
   */
  register(adapter: SignatureProviderAdapter): void {
    if (isProduction() && adapter.mode === 'fake') {
      // Refusing loudly at startup beats refusing quietly at the first send.
      throw new Error(`The signature provider adapter "${adapter.providerKey}" is a fake and cannot be registered in production.`);
    }
    assertAdapterContract(adapter);
    if (this.adapters.has(adapter.providerKey)) {
      throw new Error(`A signature provider adapter for "${adapter.providerKey}" is already registered.`);
    }
    this.adapters.set(adapter.providerKey, adapter);
  }

  resolve(providerKey: string): SignatureProviderAdapter | undefined {
    return this.adapters.get(providerKey);
  }

  /**
   * The adapter for a provider, or the same stable refusal the gate produces when there is no
   * connection: a caller who cannot reach a provider should not have to know whether the missing
   * piece was a credential or an integration.
   */
  require(providerKey: string): SignatureProviderAdapter {
    const adapter = this.adapters.get(providerKey);
    if (adapter === undefined) throw providerNotConnectedError('no_connection');
    return adapter;
  }

  /** Refuses an operation the adapter does not implement, before anything is called (plan §5.2). */
  assertOperation(
    providerKey: string,
    operation: SignatureProviderOperation | FutureSignatureProviderOperation,
  ): SignatureProviderAdapter {
    const adapter = this.require(providerKey);
    if (!adapterSupports(adapter, operation)) throw new NotSupportedByProviderError(operation, providerKey);
    return adapter;
  }

  supports(providerKey: string, operation: SignatureProviderOperation | FutureSignatureProviderOperation): boolean {
    const adapter = this.resolve(providerKey);
    return adapter !== undefined && adapterSupports(adapter, operation);
  }

  keys(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** The health view's answer: which adapter is bound, in what mode, and what it declared. */
  report(): SignatureProviderDescriptor[] {
    return [...this.adapters.values()]
      .sort((left, right) => left.providerKey.localeCompare(right.providerKey))
      .map((adapter) => ({
        providerKey: adapter.providerKey,
        mode: adapter.mode,
        adapterVersion: adapter.adapterVersion,
        providerApiVersion: adapter.providerApiVersion,
        capabilities: adapter.capabilities,
      }));
  }

  /** Whether any *live* integration is bound. The fake does not count: it can sign nothing. */
  hasLiveAdapter(providerKey: string): boolean {
    return this.resolve(providerKey)?.mode === 'live';
  }

  /** Test-only reseat, so a suite can install a deterministic adapter without touching the barrel. */
  clear(): void {
    this.adapters.clear();
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
