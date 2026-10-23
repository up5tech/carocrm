import { Inject, Injectable } from '@nestjs/common';

import { ESIGNATURE_MODULE_KEY, PROVIDER_KEY_DOCUSIGN } from './esignature-domain.js';
import {
  encryptionKeyMissingError,
  notSupportedByProviderError,
  providerNotConnectedError,
  signatureModuleDisabledError,
} from './esignature-errors.js';
import { type ESignatureFeatureDescriptor, type ESignatureProviderCapabilityKey } from './esignature-module.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { signatureProviderDescriptor } from './providers/signature-provider.catalog.js';
import { SignatureProviderRegistry } from './providers/signature-provider.registry.js';
import { SignatureConnectionRepository } from './signature-connection.repository.js';

/**
 * Phase 19-ES.1 — the single gate in front of every provider operation
 * (`PLAN_Phase_19_ESignature.md` §4.1, §5.2, §8.2, §12; `19-ES.1` acceptance
 * "no provider operations are possible before a connection is enabled").
 *
 * One place answers three questions, in this order, and nothing else may answer them:
 *
 * 1. **Is the module switched on for this caller?** The capability, then the *effective* feature —
 *    enabled *and* implemented. A flag whose infrastructure arrives in a later sub-phase does not
 *    open the gate; the settings view reports it as pending, and this refuses it.
 * 2. **Does the provider support the operation?** Capability flags, not a silent no-op
 *    (plan §5.2): a provider that cannot do it says so with `NOT_SUPPORTED_BY_PROVIDER`.   * 3. **Is there a connection in the only state that permits it?** `connected`, `isActive`, **on the
   *    provider the request names** — and `ENCRYPTION_KEY` configured, because a connection whose
   *    credential cannot be decrypted is a connection that must not be used (plan §4.1, §9.2). The
   *    answer comes from `SignatureConnectionRepository`, so the gate and the records agree by
   *    construction rather than by two queries that can drift.
 *
 * Answer 3 is currently "no" for a real reason: a connection row exists only once an administrator
 * authorizes one (ES.4), and the reason is reported as `no_enabled_connection` rather than hidden
 * behind a generic failure. Every command endpoint of ES.6–ES.16 calls `assertOperation` before it touches an adapter, so a
 * send, a view, a download or a correction can never be reached while the connection is missing,
 * disabled, or awaiting reauthorization.
 */

/** The adapter operations the gate may be asked to admit (plan §5.2). */
export const ESIGNATURE_OPERATIONS = [
  'testConnection',
  'listTemplates',
  'templateDetails',
  'prepareEnvelope',
  'sendEnvelope',
  'envelopeStatus',
  'listRecipients',
  'recipientView',
  'resendNotifications',
  'voidEnvelope',
  'correctEnvelope',
  'downloadCompletedDocuments',
  'downloadCompletionEvidence',
  'reconcile',
] as const;
export type ESignatureOperation = (typeof ESIGNATURE_OPERATIONS)[number];

interface OperationRule {
  /** The capability the caller must hold (plan §12). */
  readonly capability: Parameters<ESignaturePermissionService['assert']>[0];
  /** The feature flag that must be effective, when the operation belongs to one. */
  readonly feature?: ESignatureFeatureDescriptor['key'];
  /** The provider capability the adapter must declare (plan §5.2). */
  readonly providerCapability: ESignatureProviderCapabilityKey;
  /**
   * A second capability that satisfies the same product action.
   *
   * Sending is one action with two provider shapes: a provider that sends a prepared draft
   * (`sendEnvelope`) and one that creates and sends in one call (`sendNewEnvelope`). The gate asks for
   * the action, so it accepts either shape; the request service then dispatches to the one the
   * adapter actually declares.
   */
  readonly alternateProviderCapabilities?: readonly ESignatureProviderCapabilityKey[];
  /** Whether the provider is contacted at all; a local command never passes the connection check. */
  readonly reachesProvider: boolean;
}

/**
 * The matrix. A new command endpoint names its row here rather than improvising a check, which is
 * what keeps the plan's permission table and the actual enforcement from drifting apart.
 */
const OPERATION_RULES: Record<ESignatureOperation, OperationRule> = {
  testConnection: { capability: 'connectionManage', feature: 'connections', providerCapability: 'connectionStatus', reachesProvider: true },
  listTemplates: { capability: 'templateMappingManage', feature: 'templates', providerCapability: 'listTemplates', reachesProvider: true },
  templateDetails: { capability: 'templateMappingManage', feature: 'templates', providerCapability: 'templateDetails', reachesProvider: true },
  prepareEnvelope: { capability: 'manageDraft', feature: 'send', providerCapability: 'prepareEnvelope', reachesProvider: true },
  sendEnvelope: {
    capability: 'send',
    feature: 'send',
    providerCapability: 'sendEnvelope',
    alternateProviderCapabilities: ['sendNewEnvelope'],
    reachesProvider: true,
  },
  envelopeStatus: { capability: 'use', feature: 'webhooks', providerCapability: 'envelopeStatus', reachesProvider: true },
  listRecipients: { capability: 'use', feature: 'webhooks', providerCapability: 'listRecipients', reachesProvider: true },
  // A recipient view is generated for the signer, not for the sender: the caller needs to read the
  // request (and the service proves the caller is the named recipient), not the send right.
  recipientView: { capability: 'use', feature: 'embeddedSigning', providerCapability: 'recipientView', reachesProvider: true },
  resendNotifications: { capability: 'send', feature: 'send', providerCapability: 'resendNotifications', reachesProvider: true },
  voidEnvelope: { capability: 'void', feature: 'send', providerCapability: 'voidEnvelope', reachesProvider: true },
  correctEnvelope: { capability: 'correct', feature: 'send', providerCapability: 'correctEnvelope', reachesProvider: true },
  downloadCompletedDocuments: { capability: 'downloadCompleted', feature: 'artifacts', providerCapability: 'downloadCompletedDocuments', reachesProvider: true },
  downloadCompletionEvidence: { capability: 'downloadCompleted', feature: 'artifacts', providerCapability: 'downloadCompletionEvidence', reachesProvider: true },
  reconcile: { capability: 'connectionManage', feature: 'webhooks', providerCapability: 'envelopeStatus', reachesProvider: true },
};

export interface GateAssessment {
  /** True only when a caller could actually reach a provider right now. */
  readonly ready: boolean;
  readonly moduleEnabled: boolean;
  readonly connectionsEnabled: boolean;
  readonly encryptionConfigured: boolean;
  readonly enabledConnections: number;
  /** A stable, non-revealing reason the gate is closed. */
  readonly reason: 'ready' | 'module_disabled' | 'connections_disabled' | 'encryption_key_missing' | 'no_enabled_connection';
  /** What an administrator must do next, in one line. Never a secret, never a provider body. */
  readonly detail: string;
}

@Injectable()
export class ESignatureConnectionGate {
  constructor(
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(SignatureConnectionRepository) private readonly connections: SignatureConnectionRepository,
    @Inject(SignatureProviderRegistry) private readonly providers: SignatureProviderRegistry,
  ) {}

  rule(operation: ESignatureOperation): OperationRule {
    const found = OPERATION_RULES[operation];
    if (found === undefined) throw new Error(`Unknown ESignature operation "${String(operation)}".`);
    return found;
  }

  /**
   * Admit `operation` for the current caller or throw a stable failure.
   *
   * Order matters for information leakage: the capability is checked first, so a caller who may not
   * act learns only that; the connection state is reported to a caller who *may* act, because that
   * is the operator who needs to know why a send is refused (plan §12.1, §12.5).
   */
  async assertOperation(operation: ESignatureOperation, providerKey: string = PROVIDER_KEY_DOCUSIGN): Promise<void> {
    const rule = this.rule(operation);
    await this.permissions.assert(rule.capability);
    const settingsView = await this.settings.read();

    // The module switch closes everything, whatever the per-feature flags say.
    if (settingsView.settings.enabled !== true) {
      throw signatureModuleDisabledError(ESIGNATURE_MODULE_KEY);
    }
    if (rule.feature !== undefined && settingsView.effective[rule.feature] !== true) {
      throw signatureModuleDisabledError(`${ESIGNATURE_MODULE_KEY}.${rule.feature}`);
    }
    if (!this.supportedAnyOnProvider([rule.providerCapability, ...(rule.alternateProviderCapabilities ?? [])], providerKey)) {
      throw notSupportedByProviderError(rule.providerCapability, providerKey);
    }
    if (!rule.reachesProvider) return;

    if (settingsView.effective.connections !== true) throw signatureModuleDisabledError(`${ESIGNATURE_MODULE_KEY}.connections`);
    if (!this.settings.encryptionConfigured()) throw encryptionKeyMissingError();

    const enabledConnections = await this.connections.countUsable(providerKey);
    if (enabledConnections === 0) {
      throw providerNotConnectedError('no_connection');
    }
  }

  /**
   * Whether the provider can perform an operation.
   *
   * The bound adapter is authoritative once one exists (plan §5.2's contract), because a declaration
   * that drifts from an implementation is exactly the silent no-op the plan forbids. With no adapter
   * registered the declared contract answers, so an operation of a later sub-phase is refused here
   * rather than admitted and then failing inside an adapter.
   */
  supportedOnProvider(capability: ESignatureProviderCapabilityKey, providerKey: string = PROVIDER_KEY_DOCUSIGN): boolean {
    return this.supportedAnyOnProvider([capability], providerKey);
  }

  /** Whether the provider declares at least one of the shapes a single product action may take. */
  supportedAnyOnProvider(
    capabilities: readonly ESignatureProviderCapabilityKey[],
    providerKey: string = PROVIDER_KEY_DOCUSIGN,
  ): boolean {
    const adapter = this.providers.resolve(providerKey);
    if (adapter !== undefined) return capabilities.some((capability) => adapter.capabilities[capability] === true);
    // No adapter: the catalog's declaration answers, so an operation a planned provider does not
    // implement is refused here rather than admitted and failing inside a nonexistent adapter.
    const declared = signatureProviderDescriptor(providerKey)?.capabilities;
    return declared !== undefined && capabilities.some((capability) => declared[capability] === true);
  }

  /** The health endpoint's answer: what the gate would decide, with no side effect and no secret. */
  async assessment(): Promise<GateAssessment> {
    const settingsView = await this.settings.read();
    const encryptionConfigured = this.settings.encryptionConfigured();
    const enabledConnections = await this.connections.countUsable();

    const closed = (reason: GateAssessment['reason'], detail: string, flags: Partial<GateAssessment>): GateAssessment => ({
      ready: false,
      moduleEnabled: false,
      connectionsEnabled: false,
      encryptionConfigured: false,
      enabledConnections,
      reason,
      detail,
      ...flags,
    });

    if (settingsView.settings.enabled !== true) {
      return closed('module_disabled', 'The module is switched off, so nothing can reach a provider.', {
        moduleEnabled: false,
      });
    }
    if (settingsView.effective.connections !== true) {
      return closed('connections_disabled', 'The connection control plane is not enabled, so no provider operation is possible.', {
        moduleEnabled: true,
      });
    }
    if (!encryptionConfigured) {
      return closed('encryption_key_missing', 'ENCRYPTION_KEY is not configured, so a stored credential cannot be read and no provider operation is possible.', {
        moduleEnabled: true,
        connectionsEnabled: true,
        encryptionConfigured: false,
      });
    }
    if (enabledConnections === 0) {
      return closed('no_enabled_connection', 'No connection is connected and active, so every provider operation is refused.', {
        moduleEnabled: true,
        connectionsEnabled: true,
        encryptionConfigured: true,
      });
    }
    return {
      ready: true,
      moduleEnabled: true,
      connectionsEnabled: true,
      encryptionConfigured: true,
      enabledConnections,
      reason: 'ready',
      detail: 'An enabled connection exists, so authorized provider operations are admitted.',
    };
  }
}


