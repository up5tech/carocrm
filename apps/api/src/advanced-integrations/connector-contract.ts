import { ValidationError } from '@carocrm/core/errors/index.js';

import type { ConnectorAdapter } from './connector-adapter.port.js';
import type { ConnectorCapabilities } from './provider-capabilities.js';
import { assertAdapterSatisfiesCapabilities, CONNECTOR_CAPABILITY_SCHEMA_VERSION, validateConnectorCapabilities } from './provider-capabilities.js';

/**
 * Phase 19-INT.6 — the reusable connector conformance suite
 * (`PLAN_Phase_19_Advanced_Integrations.md` §17.1, §17.2, §19-INT.6 acceptance; `19-INT.6`).
 *
 * The plan asks for *"adapter contract tests"*. A test file per connector does not scale: the
 * seventh connector repeats the same ten assertions, and a reviewer has to read all of them to
 * learn what "a correct connector" means. So the rules live here, **once**, as data.
 *
 * The suite is deliberately **generic**: it knows nothing about the fake provider, and it must
 * pass for a real vendor connector as well. It reads only the adapter's own declaration — the
 * same declaration the registry validates and the admin UI reads — and compares it against the
 * operations the adapter actually implements.
 *
 * Two shapes, one rule set:
 *
 *  - `runConnectorContract()` **reports**. It returns every failure it found, so a test can
 *    assert on the failures of a deliberately broken connector.
 *  - `assertConnectorContract()` **refuses**. It throws a `ValidationError` listing every failure,
 *    so a registration path can decline a broken connector before an administrator ever sees it.
 *
 * Nothing here throws because of a broken connector: a broken connector is the subject under test,
 * not an exceptional condition of the checker.
 */

/** One failed rule. */
export interface ConnectorContractFailure {
  /** The stable name of the rule, so a test can assert on *which* rule failed. */
  readonly check: string;
  /** A human-readable explanation of the failure. */
  readonly message: string;
}

/** A provider key: lowercase letters, digits and hyphens, starting with a letter. */
const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** An object type: a letter, then letters, digits or underscores. */
const OBJECT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Collect every contract failure of an adapter.
 *
 * This is the single rule set; both public entry points delegate to it.
 */
function collectContractFailures(adapter: ConnectorAdapter): readonly ConnectorContractFailure[] {
  const failures: ConnectorContractFailure[] = [];
  const fail = (check: string, message: string): void => {
    failures.push({ check, message });
  };

  // ---- 1. the provider key must be a usable key. ----
  if (!isNonEmptyString(adapter.providerKey) || !PROVIDER_KEY_PATTERN.test(adapter.providerKey)) {
    fail(
      'providerKey',
      `The provider key "${String(adapter.providerKey)}" is invalid. It starts with a letter and contains lowercase letters, digits or hyphens.`,
    );
  }

  // ---- 2. both versions must be pinned. ----
  if (!isNonEmptyString(adapter.adapterVersion)) {
    fail('adapterVersion', 'The adapter must declare a non-empty adapter version.');
  }
  if (!isNonEmptyString(adapter.providerApiVersion)) {
    fail('providerApiVersion', 'The adapter must declare a non-empty provider API version.');
  }

  // ---- 3. the declaration must be one the platform accepts. ----
  let raw: unknown;
  try {
    raw = adapter.getCapabilities();
  } catch (error) {
    fail('capabilities', `The capability declaration could not be read: ${messageOf(error)}`);
    raw = undefined;
  }

  let validated: ConnectorCapabilities | undefined;
  if (raw !== undefined) {
    try {
      validated = validateConnectorCapabilities(raw);
    } catch (error) {
      fail('capabilities', `The capability declaration is invalid: ${messageOf(error)}`);
    }
  }

  const rawRecord = isRecord(raw) ? raw : null;

  // ---- 4. the schema version must be the one this platform understands. ----
  if (rawRecord) {
    const schemaVersion = rawRecord['schemaVersion'];
    if (schemaVersion !== CONNECTOR_CAPABILITY_SCHEMA_VERSION) {
      fail(
        'capabilities.schemaVersion',
        `The capability declaration uses schema version ${String(schemaVersion)}. This platform understands version ${String(CONNECTOR_CAPABILITY_SCHEMA_VERSION)}.`,
      );
    }
  }

  // ---- 5. the declaration must not promise more than the adapter implements. ----
  if (validated) {
    try {
      assertAdapterSatisfiesCapabilities(validated, adapter.operations, adapter.providerKey);
    } catch (error) {
      fail('capabilities.operations', messageOf(error));
    }
  }

  // ---- 6. a connector that declares no object cannot be used. ----
  const rawObjects = rawRecord && Array.isArray(rawRecord['objects']) ? (rawRecord['objects'] as readonly unknown[]) : null;
  if (rawObjects && rawObjects.length === 0) {
    fail(
      'capabilities.objects',
      'The capability declaration names no object. A connector without a readable object cannot be used.',
    );
  }

  // ---- 7. every object type must be a usable identifier. ----
  if (rawObjects) {
    for (const entry of rawObjects) {
      if (!isRecord(entry)) continue;
      const objectType = entry['objectType'];
      if (!isNonEmptyString(objectType) || !OBJECT_TYPE_PATTERN.test(objectType)) {
        fail(
          'capabilities.objects.objectType',
          `The object type "${String(objectType)}" is invalid. It starts with a letter and contains letters, digits or underscores.`,
        );
      }
    }
  }

  // ---- 8-11, 16. every declared operation must be one the adapter implements. ----
  if (rawObjects) {
    for (const entry of rawObjects) {
      if (!isRecord(entry)) continue;
      const objectType = isNonEmptyString(entry['objectType']) ? entry['objectType'] : '<unnamed object>';

      if (entry['read'] === true) {
        if (!adapter.operations.implementsFetch) {
          fail('capabilities.objects.read', `The object "${objectType}" is readable but the adapter implements no fetch operation.`);
        }
        const externalIdFields = entry['externalIdFields'];
        if (!Array.isArray(externalIdFields) || externalIdFields.length === 0) {
          fail(
            'capabilities.objects.externalIdFields',
            `The object "${objectType}" is readable but names no external identifier, so a record cannot be correlated across syncs.`,
          );
        }
      }

      if (entry['create'] === true || entry['update'] === true || entry['upsert'] === true) {
        if (!adapter.operations.implementsWrite) {
          fail(
            'capabilities.objects.write',
            `The object "${objectType}" is writable but the adapter implements no write operation.`,
          );
        }
      }

      if (entry['delete'] === true && !adapter.operations.implementsDelete) {
        fail(
          'capabilities.objects.delete',
          `The object "${objectType}" is deletable but the adapter implements no delete operation.`,
        );
      }

      if (entry['webhook'] === true) {
        if (!adapter.operations.implementsWebhook) {
          fail(
            'capabilities.objects.webhook',
            `The object "${objectType}" is pushed by webhook but the adapter implements no webhook verification.`,
          );
        }
        if (!webhookSupported(rawRecord)) {
          fail(
            'capabilities.webhook.supported',
            `The object "${objectType}" is pushed by webhook but the declaration does not support webhooks.`,
          );
        }
      }
    }
  }

  // ---- 12. an OAuth connector authorizes; any other connector does not. ----
  const authentication = rawRecord ? rawRecord['authentication'] : undefined;
  if (authentication === 'oauth') {
    if (!adapter.supportsAuthorization) {
      fail('supportsAuthorization', 'The connector authenticates with OAuth but does not implement the authorization operation.');
    }
  } else if (adapter.supportsAuthorization) {
    fail(
      'supportsAuthorization',
      `The connector implements the authorization operation but declares the authentication type "${String(authentication)}".`,
    );
  }

  // ---- 13. only an OAuth connector can refresh. ----
  if (adapter.supportsRefresh && authentication !== 'oauth') {
    fail(
      'supportsRefresh',
      `The connector refreshes its credential but declares the authentication type "${String(authentication)}". Only an OAuth connector can refresh.`,
    );
  }

  // ---- 14. only an OAuth connector can revoke. ----
  if (adapter.supportsRevocation && authentication !== 'oauth') {
    fail(
      'supportsRevocation',
      `The connector revokes its credential but declares the authentication type "${String(authentication)}". Only an OAuth connector can revoke.`,
    );
  }

  // ---- 15. no webhook implementation means no webhook support. ----
  if (!adapter.operations.implementsWebhook && webhookSupported(rawRecord)) {
    fail(
      'capabilities.webhook.supported',
      'The declaration supports webhooks but the adapter implements no webhook verification.',
    );
  }

  return failures;
}

/**
 * Whether the declaration says webhooks are supported.
 */
function webhookSupported(raw: Record<string, unknown> | null): boolean {
  if (!raw) return false;
  const webhook = raw['webhook'];
  if (!isRecord(webhook)) return false;
  return webhook['supported'] === true;
}

/**
 * Run the conformance suite and report every failure.
 *
 * The result is empty when the connector honours the contract. It never throws because of a
 * broken connector — a broken connector is the subject under test.
 */
export async function runConnectorContract(adapter: ConnectorAdapter): Promise<readonly ConnectorContractFailure[]> {
  return collectContractFailures(adapter);
}

/**
 * Run the conformance suite and refuse a connector that fails it.
 *
 * Used by a registration path: a connector that breaks the contract must not reach the admin UI.
 */
export function assertConnectorContract(adapter: ConnectorAdapter): void {
  const failures = collectContractFailures(adapter);
  if (failures.length === 0) return;
  const summary = failures.map((failure) => `${failure.check}: ${failure.message}`).join(' ');
  throw new ValidationError(`The connector "${adapter.providerKey}" does not honour the connector contract. ${summary}`, {
    providerKey: adapter.providerKey,
    failures: failures.map((failure) => ({ check: failure.check, message: failure.message })),
  });
}
