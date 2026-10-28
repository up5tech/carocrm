import { ValidationError } from '@carocrm/core/errors/index.js';

import {
  FUTURE_SIGNATURE_PROVIDER_OPERATIONS,
  SIGNATURE_PROVIDER_OPERATIONS,
  type SignatureProviderAdapter,
  type SignatureProviderOperation,
} from './signature-provider.port.js';

/**
 * Phase 22.6 — the reusable signature-provider conformance suite
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §11 task 7).
 *
 * `advanced-integrations/connector-contract.ts` already answers "what is a correct connector?" once,
 * as data, so a seventh connector does not repeat ten assertions. The signature providers had no
 * equivalent: `signature-provider.port.ts` declares the port and `assertAdapterContract()` checks the
 * *minimum* an adapter must implement, but nothing states the rules an adapter has to honour as a
 * whole. The rules therefore live here, once, and every adapter — the fake, DocuSign, Dropbox Sign —
 * is checked against the same list.
 *
 * Two shapes, one rule set:
 *
 *  - `runSignatureProviderContract()` **reports**: it returns every failure, so a test can assert on
 *    the failures of a deliberately broken adapter.
 *  - `assertSignatureProviderContract()` **refuses**: it throws a `ValidationError` listing every
 *    failure, so a registration path can decline a broken adapter before an operator ever sees it.
 *
 * Nothing here throws because of a broken adapter: a broken adapter is the subject under test, not an
 * exceptional condition of the checker.
 */

/** One failed rule. */
export interface SignatureProviderContractFailure {
  /** The stable name of the rule, so a test can assert on *which* rule failed. */
  readonly check: string;
  /** A human-readable explanation of the failure. */
  readonly message: string;
}

/**
 * A provider key: a lowercase, stable string.
 *
 * The signature module's keys are `docusign` and `dropbox_sign`, so the underscore belongs here —
 * the connector registry's hyphen-only pattern is a *different* convention for a *different* family
 * of keys and must not be copied here.
 */
const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

/** The method the port uses for an operation. */
const METHOD_FOR: Readonly<Record<string, string>> = {
  connectionStatus: 'connectionStatus',
  accountContext: 'accountContext',
  listTemplates: 'listTemplates',
  templateDetails: 'templateDetails',
  prepareEnvelope: 'prepareEnvelope',
  sendEnvelope: 'sendEnvelope',
  sendNewEnvelope: 'sendNewEnvelope',
  envelopeStatus: 'envelopeStatus',
  listRecipients: 'listRecipients',
  recipientView: 'recipientView',
  resendNotifications: 'resendNotifications',
  voidEnvelope: 'voidEnvelope',
  downloadCompletedDocuments: 'downloadCompletedDocuments',
  downloadCompletionEvidence: 'downloadCompletionEvidence',
  verifyWebhook: 'verifyAndParseWebhook',
};

/** Every operation an adapter may declare, including the future ones. */
const KNOWN_OPERATIONS: readonly string[] = [
  ...SIGNATURE_PROVIDER_OPERATIONS,
  ...FUTURE_SIGNATURE_PROVIDER_OPERATIONS,
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Collect every contract failure of an adapter.
 *
 * This is the single rule set; both public entry points delegate to it.
 */
function collectContractFailures(adapter: SignatureProviderAdapter): readonly SignatureProviderContractFailure[] {
  const failures: SignatureProviderContractFailure[] = [];
  const fail = (check: string, message: string): void => {
    failures.push({ check, message });
  };
  const methods = adapter as unknown as Record<string, unknown>;

  // ---- 1. the provider key must be a usable key. ----
  if (!isNonEmptyString(adapter.providerKey) || !PROVIDER_KEY_PATTERN.test(adapter.providerKey)) {
    fail(
      'providerKey',
      `The provider key "${String(adapter.providerKey)}" is invalid. It starts with a letter and contains lowercase letters, digits, hyphens or underscores.`,
    );
  }

  // ---- 2. both versions must be pinned, so an operator can tell which build is answering. ----
  if (!isNonEmptyString(adapter.adapterVersion)) {
    fail('adapterVersion', 'The adapter must declare a non-empty adapter version.');
  }
  if (!isNonEmptyString(adapter.providerApiVersion)) {
    fail('providerApiVersion', 'The adapter must declare a non-empty provider API version.');
  }

  // ---- 3. the mode must say whether this is a live integration. ----
  if (adapter.mode !== 'live' && adapter.mode !== 'fake' && adapter.mode !== 'disabled') {
    fail('mode', `The adapter mode "${String(adapter.mode)}" is invalid. It is "live", "fake" or "disabled".`);
  }

  // ---- 4. the drafting mode must be one the request service knows how to drive. ----
  if (adapter.envelopeDrafting !== 'draft' && adapter.envelopeDrafting !== 'direct') {
    fail(
      'envelopeDrafting',
      `The drafting mode "${String(adapter.envelopeDrafting)}" is invalid. It is "draft" or "direct".`,
    );
  }

  // ---- 5. the capability declaration must answer for every known operation. ----
  const capabilities = adapter.capabilities as unknown as Record<string, unknown>;
  if (typeof capabilities !== 'object' || capabilities === null) {
    fail('capabilities', 'The adapter must declare its capabilities.');
  } else {
    for (const operation of KNOWN_OPERATIONS) {
      if (typeof capabilities[operation] !== 'boolean') {
        fail(
          'capabilities.operations',
          `The capability declaration does not answer for "${operation}". An unanswered operation is read as "not supported", which hides a mistake behind a refusal.`,
        );
      }
    }
    for (const operation of Object.keys(capabilities)) {
      if (!KNOWN_OPERATIONS.includes(operation)) {
        fail(
          'capabilities.unknownOperation',
          `The capability declaration names "${operation}", which is not an operation of this contract.`,
        );
      }
    }
  }

  // ---- 6. every declared operation must be one the adapter implements. ----
  for (const operation of SIGNATURE_PROVIDER_OPERATIONS) {
    if (adapter.capabilities[operation as SignatureProviderOperation] !== true) continue;
    const method = METHOD_FOR[operation];
    if (method === undefined || typeof methods[method] !== 'function') {
      fail(
        `capabilities.${operation}`,
        `The adapter declares "${operation}" but implements no ${String(method)}().`,
      );
    }
  }

  // ---- 7. webhook verification is declared, so the method has to exist. ----
  if (adapter.capabilities.verifyWebhook === true && typeof adapter.verifyAndParseWebhook !== 'function') {
    fail('capabilities.verifyWebhook', 'The adapter declares webhook verification but implements no verifyAndParseWebhook().');
  }

  // ---- 8. the drafting mode and the declared operations must agree. ----
  if (adapter.envelopeDrafting === 'direct') {
    if (typeof adapter.sendNewEnvelope !== 'function') {
      fail('envelopeDrafting.direct', 'The adapter sends directly but implements no sendNewEnvelope().');
    }
    if (adapter.capabilities.sendNewEnvelope !== true) {
      fail(
        'envelopeDrafting.direct',
        'The adapter sends directly but does not declare the "sendNewEnvelope" capability, so the send would be refused at the last moment.',
      );
    }
  }

  // ---- 9. a draft provider has to be able to send the draft it prepared. ----
  if (adapter.envelopeDrafting === 'draft' && adapter.capabilities.sendEnvelope !== true) {
    fail(
      'envelopeDrafting.draft',
      'The adapter prepares a draft but does not declare the "sendEnvelope" capability, so a prepared envelope could never be sent.',
    );
  }

  return failures;
}

/**
 * Run the conformance suite and report every failure.
 *
 * The result is empty when the adapter honours the contract. It never throws because of a broken
 * adapter — a broken adapter is the subject under test.
 */
export function runSignatureProviderContract(adapter: SignatureProviderAdapter): readonly SignatureProviderContractFailure[] {
  return collectContractFailures(adapter);
}

/**
 * Run the conformance suite and refuse an adapter that fails it.
 *
 * Used by a registration path: an adapter that breaks the contract must not reach an operator.
 */
export function assertSignatureProviderContract(adapter: SignatureProviderAdapter): void {
  const failures = collectContractFailures(adapter);
  if (failures.length === 0) return;
  const summary = failures.map((failure) => `${failure.check}: ${failure.message}`).join(' ');
  throw new ValidationError(
    `The signature provider adapter "${adapter.providerKey}" does not honour the provider contract. ${summary}`,
    {
      providerKey: adapter.providerKey,
      failures: failures.map((failure) => ({ check: failure.check, message: failure.message })),
    },
  );
}
