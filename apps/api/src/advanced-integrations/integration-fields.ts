import type { MetadataStoreService } from '../metadata/metadata-store.service.js';

/**
 * Phase 19-INT.15 — the field catalogue
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.4).
 *
 * The mapping builder shows two lists side by side: the provider's fields and the CRM's. The
 * provider's come from the connector; the CRM's come from the metadata registry. This module is
 * the single place that turns a metadata entity into that list, so the builder and the warnings
 * agree on what a field is.
 */

/**
 * Whether a CRM field holds sensitive data.
 *
 * The metadata does not carry a "sensitive" flag for every entity, so the field **name** is the
 * signal. The list is deliberately short and explicit: a field whose name is not on it is not
 * flagged, because a false positive would train an operator to ignore the warning.
 */
const SENSITIVE_FIELD_NAMES: readonly string[] = [
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'address',
  'ssn',
  'bankaccount',
  'iban',
  'creditcard',
  'password',
  'secret',
  'dob',
  'dateofbirth',
  'taxid',
];

export function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.includes(name.toLowerCase().replaceAll(/[^a-z]/g, ''));
}

export interface CrmFieldView {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly identifier: boolean;
  readonly sensitive: boolean;
}

/**
 * The fields of a CRM entity.
 *
 * An entity the metadata does not know yields an empty list rather than an error: the mapping
 * builder must still render, with a warning, when the target entity has been renamed.
 */
export function crmFieldsOf(metadata: MetadataStoreService, entityType: string): readonly CrmFieldView[] {
  const document = metadata.getMetadata();
  const entity = document[entityType] as { fields?: Record<string, unknown> } | undefined;
  const fields = entity?.fields ?? {};
  return Object.entries(fields).map(([name, definition]) => {
    const field = (definition ?? {}) as {
      type?: string;
      label?: string;
      required?: boolean;
      unique?: boolean;
      entityKey?: string;
    };
    return {
      name,
      label: field.label ?? name,
      type: field.type ?? 'varchar',
      required: field.required === true,
      identifier: field.unique === true || field.entityKey !== undefined,
      sensitive: isSensitiveField(name),
    };
  });
}

/**
 * Whether a provider type can be written into a CRM type without losing information.
 *
 * The rule is deliberately conservative: a conversion is lossy unless the target can hold every
 * value the source can produce. A number into a string is safe; a string into a number is not.
 */
export function isLossyConversion(providerType: string, crmType: string): boolean {
  const source = normalizeType(providerType);
  const target = normalizeType(crmType);
  if (source === target) return false;
  if (source === 'bool' && (target === 'varchar' || target === 'text')) return false;
  if (source === 'int' && (target === 'varchar' || target === 'text' || target === 'double')) return false;
  if (source === 'double' && (target === 'varchar' || target === 'text')) return false;
  if (source === 'datetime' && (target === 'varchar' || target === 'text')) return false;
  if (source === 'enum' && (target === 'varchar' || target === 'text')) return false;
  if (source === 'varchar' && target === 'text') return false;
  if (source === 'text' && target === 'varchar') return true;
  return true;
}

function normalizeType(type: string): string {
  const lower = type.toLowerCase();
  if (lower === 'int' || lower === 'integer' || lower === 'number' || lower === 'float') return 'int';
  if (lower === 'double' || lower === 'decimal') return 'double';
  if (lower === 'bool' || lower === 'boolean') return 'bool';
  if (lower === 'date' || lower === 'datetime' || lower === 'timestamp') return 'datetime';
  if (lower === 'text' || lower === 'longtext') return 'text';
  if (lower === 'enum') return 'enum';
  return 'varchar';
}
