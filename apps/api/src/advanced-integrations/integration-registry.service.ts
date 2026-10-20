import { ValidationError } from '@carocrm/core/errors/index.js';
import { Injectable } from '@nestjs/common';

import type { ConnectorAdapter } from './connector-adapter.port.js';
import {
  assertAdapterSatisfiesCapabilities,
  type ConnectorCapabilities,
  type ConnectorOperation,
  findObjectCapability,
  supportsOperation,
  validateConnectorCapabilities,
} from './provider-capabilities.js';

/**
 * Phase 19-INT.3 — the provider registry
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.2, §5.3, §5.4; `19-INT.3`).
 *
 * The registry is the module's catalog: which connectors this installation offers, what each one
 * can do, and whether its declaration is coherent. It is **code-registered**, so a capability can
 * never drift from the adapter that implements it (ADR 0002, decision 5) and no provider row has
 * to be seeded on every start (AGENTS.md §3.3).
 *
 * Two properties matter more than the catalog itself:
 *
 *  1. **A malformed declaration is a startup failure.** An admin must never be shown a capability
 *     the connector would refuse at the first call.
 *  2. **An unknown provider key resolves to a disabled adapter** that performs no external call —
 *     the same fail-closed behaviour `VoiceProviderRegistry` and `AIProviderRegistry` already have.
 */

/** A provider key: lowercase letters, digits and hyphens. */
export const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** The provider's lifecycle in this installation. */
export const PROVIDER_STATUSES = ['available', 'disabled', 'deprecated', 'unsupported'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];



/**
 * A connector type available to administrators — the plan's §6.1 `IntegrationDefinition`.
 *
 * It is a code-registered value rather than a database row. The plan's own wording allows the
 * names to be conceptual, and the repository's precedent (`AIProviderRegistry`,
 * `VoiceProviderRegistry`) registers adapters in code.
 */
export interface IntegrationProviderDefinition {
  readonly providerKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly adapterVersion: string;
  readonly providerApiVersion: string;
  readonly status: ProviderStatus;
  readonly capabilities: ConnectorCapabilities;
  /** Scopes the provider always needs, whatever object is used. */
  readonly requiredScopes: readonly string[];
  /** Scopes that widen what may be synced but are never required. */
  readonly optionalScopes: readonly string[];
  readonly docsUrl: string | null;
  /** The translation key for the operator-facing setup instructions. */
  readonly setupInstructionsKey: string;
  /** The project-owned icon key. Never a vendor brand asset. */
  readonly iconKey: string;
  /** The adapter, when one is bound. A definition without one is described but not executable. */
  readonly adapter: ConnectorAdapter | null;
}

export interface ProviderDescription {
  readonly providerKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly adapterVersion: string;
  readonly providerApiVersion: string;
  readonly status: ProviderStatus;
  readonly capabilities: ConnectorCapabilities;
  readonly requiredScopes: readonly string[];
  readonly optionalScopes: readonly string[];
  readonly docsUrl: string | null;
  readonly setupInstructionsKey: string;
  readonly iconKey: string;
  /** Whether a connector is bound, i.e. whether the provider may actually be called. */
  readonly executable: boolean;
}

/** The fail-closed answer for a provider key nobody registered. */
export const DISABLED_PROVIDER_KEY = 'disabled';

@Injectable()
export class IntegrationRegistry {
  private readonly definitions = new Map<string, IntegrationProviderDefinition>();

  /**
   * Register a provider definition.
   *
   * The declaration is validated here, at registration, so a malformed connector is refused
   * immediately — and again at startup, so a definition that was registered after the registry was
   * validated is still checked.
   */
  register(definition: IntegrationProviderDefinition): IntegrationProviderDefinition {
    if (!PROVIDER_KEY_PATTERN.test(definition.providerKey)) {
      throw new ValidationError(
        `Provider key "${definition.providerKey}" is invalid. It starts with a letter and contains lowercase letters, digits or hyphens.`,
        { providerKey: definition.providerKey },
      );
    }
    if (this.definitions.has(definition.providerKey)) {
      throw new ValidationError(`Provider "${definition.providerKey}" is already registered.`, {
        providerKey: definition.providerKey,
      });
    }
    const capabilities = validateConnectorCapabilities(definition.capabilities);
    if (definition.adapter !== null) {
      assertAdapterSatisfiesCapabilities(capabilities, definition.adapter.operations, definition.providerKey);
      if (definition.adapter.providerKey !== definition.providerKey) {
        throw new ValidationError(
          `Provider "${definition.providerKey}" is bound to an adapter for "${definition.adapter.providerKey}".`,
          { providerKey: definition.providerKey },
        );
      }
    }
    const normalized: IntegrationProviderDefinition = { ...definition, capabilities };
    this.definitions.set(definition.providerKey, normalized);
    return normalized;
  }

  /**
   * Validate every registered definition.
   *
   * Called when the module initializes. A definition that cannot be honoured stops the module from
   * loading, because a half-valid catalog is worse than a refusal.
   */
  validateAll(): readonly string[] {
    const validated: string[] = [];
    for (const [key, definition] of this.definitions) {
      const capabilities = validateConnectorCapabilities(definition.capabilities);
      if (definition.adapter !== null) {
        assertAdapterSatisfiesCapabilities(capabilities, definition.adapter.operations, key);
      }
      validated.push(key);
    }
    return validated;
  }

  /** The definition, or `undefined` when the provider is not registered. */
  find(providerKey: string): IntegrationProviderDefinition | undefined {
    return this.definitions.get(providerKey);
  }

  /**
   * The definition for `providerKey`, or a refusal.
   *
   * An unknown key is an error, not an empty object: a caller must not be able to believe it
   * configured a connector that does not exist.
   */
  require(providerKey: string): IntegrationProviderDefinition {
    const found = this.definitions.get(providerKey);
    if (!found) {
      throw new ValidationError(`Provider "${providerKey}" is not registered.`, { providerKey });
    }
    if (found.status === 'unsupported') {
      throw new ValidationError(`Provider "${providerKey}" is not supported by this installation.`, {
        providerKey,
      });
    }
    return found;
  }

  /** The definition, only when it may actually be called. */
  requireExecutable(providerKey: string): IntegrationProviderDefinition {
    const found = this.require(providerKey);
    if (found.adapter === null) {
      throw new ValidationError(`Provider "${providerKey}" has no connector bound and cannot be used.`, {
        providerKey,
      });
    }
    return found;
  }

  /** Every registered provider, in a stable order. */
  all(): readonly IntegrationProviderDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.providerKey.localeCompare(right.providerKey));
  }

  /** The operator-facing catalog. Never contains a secret. */
  describeAll(): readonly ProviderDescription[] {
    return this.all().map((definition) => this.describe(definition));
  }

  describe(definition: IntegrationProviderDefinition): ProviderDescription {
    return {
      providerKey: definition.providerKey,
      displayName: definition.displayName,
      description: definition.description,
      category: definition.category,
      adapterVersion: definition.adapterVersion,
      providerApiVersion: definition.providerApiVersion,
      status: definition.status,
      capabilities: definition.capabilities,
      requiredScopes: definition.requiredScopes,
      optionalScopes: definition.optionalScopes,
      docsUrl: definition.docsUrl,
      setupInstructionsKey: definition.setupInstructionsKey,
      iconKey: definition.iconKey,
      executable: definition.adapter !== null,
    };
  }

  /**
   * Whether the connector may perform `operation` on `objectType`.
   *
   * The dispatcher calls this **before** a provider call, so an unsupported operation is refused
   * with a precise message instead of failing inside the adapter.
   */
  supports(providerKey: string, objectType: string, operation: ConnectorOperation): boolean {
    const definition = this.definitions.get(providerKey);
    if (!definition) return false;
    return supportsOperation(definition.capabilities, objectType, operation);
  }

  /** The capability declaration for one object, or `undefined` when the provider does not offer it. */
  objectCapability(providerKey: string, objectType: string) {
    const definition = this.definitions.get(providerKey);
    if (!definition) return undefined;
    return findObjectCapability(definition.capabilities, objectType);
  }
}

export type {
  ConnectorAdapter,
  ConnectorContext,
  ConnectorCredential,
} from './connector-adapter.port.js';
