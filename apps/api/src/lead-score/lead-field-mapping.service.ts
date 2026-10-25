import { createHash } from 'node:crypto';

import type { FieldDefinition } from '@carocrm/metadata/schemas/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { CONVERSION_TARGETS, type ConversionTarget } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.12 — the Lead-to-target field map, and the type rules a map must obey
 * (`PLAN_Phase_19_LeadScore.md` §5.7, §7.4; audit §11 `LS.12`; contract §7).
 *
 * A mapping is configuration that **writes records**, so it is validated at two levels and neither is
 * optional:
 *
 *  - **Shape** (zod, strict): a version, a list of `from → to` pairs, and create defaults per target. An
 *    unknown key is a refusal, not a silently ignored line.
 *  - **Meaning** (metadata, this service): the source must exist on `Lead` and be allowed as a source, the
 *    target must exist on the target entity and be writable by a mapping, and the two types must be
 *    compatible. `conversion.mapping` is stored in the settings document, and the settings service calls
 *    `validateSection` **before** it saves — a map that cannot be executed must never reach a conversion
 *    (contract §7.1).
 *
 * Three classes of field are refused by policy rather than by shape, because "it type-checks" is not the
 * same as "it is data a conversion may copy":
 *
 *  - the Lead's own **outcomes and system fields** (`score*`, `converted*`, `conversionOperationId`,
 *    `status`, `name`, ids and timestamps) — copying them would let a conversion write what only the
 *    engine or the command may write;
 *  - **ownership** (`assignedUserId`, `teams`) — a copy silently widens who can read the new record
 *    (plan §7.5; contract §7.6);
 *  - the **relationship carries** (`Contact.accountId`, `Opportunity.accountId`/`contactIds`) — those are
 *    the wizard's choices, not mapped values (contract §6), and `Contact.name` is derived from `lastName`
 *    by the kernel (`apps/api/src/entity/entity.service.ts:509-519`), so mapping it could only disagree
 *    with the value the kernel re-derives.
 */

export type MappingTarget = ConversionTarget;

export interface MappingField {
  readonly from: string;
  readonly to: string;
}

export interface TargetMapping {
  readonly version: number;
  readonly fields: readonly MappingField[];
  readonly createDefaults: Readonly<Record<string, unknown>>;
}

/**
 * The recovery scan (19-LS.13, contract §11.2): a stuck `processing` row is not something the request that
 * created it can resolve, so a bounded, off-by-default job looks for them.
 */
export interface ConversionRecoverySection {
  readonly enabled: boolean;
  readonly limit: number;
  readonly chunkSize: number;
  readonly staleAfterMinutes: number;
}

export interface ConversionSection {
  readonly targets: readonly MappingTarget[];
  readonly fieldMergeAllowed: boolean;
  readonly mapping: ConversionMapping;
  readonly recovery: ConversionRecoverySection;
}

const MappingFieldSchema = z
  .object({
    from: z.string().trim().min(1).max(64),
    to: z.string().trim().min(1).max(64),
  })
  .strict();

const TargetMappingSchema = z
  .object({
    /** Raised by the operator when the map changes; a stored conversion names the version it used. */
    version: z.number().int().min(1).max(1_000_000).default(1),
    fields: z.array(MappingFieldSchema).max(64).default([]),
    /** Values a create needs and no Lead field supplies (today exactly `Opportunity.name`). */
    createDefaults: z.record(z.unknown()).default({}),
  })
  .strict();

const MappingRecordSchema = z
  .object({ Contact: TargetMappingSchema, Account: TargetMappingSchema, Opportunity: TargetMappingSchema })
  .strict();

/** The per-target maps as the settings document stores them (mutable shape, zod's own). */
export type ConversionMapping = z.infer<typeof MappingRecordSchema>;

const uniqueTargets = (values: readonly string[]): boolean => new Set(values).size === values.length;

/**
 * The map a fresh installation starts from (compat §5.2, corrected by LS.10).
 *
 * `Account.emailAddress` / `phoneNumber` are deliberately **not** here: a person's mailbox and number are
 * the person's, so they reach the Account only when the conversion creates no Contact at all (the
 * preview adds them as `contextual` entries in that case — contract §7.2).
 */
export const DEFAULT_CONVERSION_MAPPING: ConversionMapping = {
  Contact: {
    version: 1,
    fields: [
      { from: 'firstName', to: 'firstName' },
      { from: 'lastName', to: 'lastName' },
      { from: 'title', to: 'title' },
      { from: 'emailAddress', to: 'emailAddress' },
      { from: 'phoneNumber', to: 'phoneNumber' },
      { from: 'source', to: 'leadSource' },
    ],
    createDefaults: {},
  },
  Account: {
    version: 1,
    fields: [
      { from: 'company', to: 'name' },
      { from: 'industry', to: 'industry' },
    ],
    createDefaults: {},
  },
  Opportunity: {
    version: 1,
    // `name` is required on Opportunity and no Lead field supplies it; the template is composed from the
    // Lead and the wizard may edit the result (contract §7.4). `{{token}}` names a Lead field.
    fields: [{ from: 'source', to: 'leadSource' }],
    createDefaults: { name: '{{lastName}} — {{company}}' },
  },
};

const ConversionRecoverySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Rows one scan may settle. The scan never touches a record, only the operation rows. */
    limit: z.number().int().min(1).max(500).default(100),
    /** Rows per transaction, so a slow scan does not hold one lock over the whole table. */
    chunkSize: z.number().int().min(1).max(50).default(25),
    /** How long a `processing` row may be silent before the scan treats it as interrupted. */
    staleAfterMinutes: z.number().int().min(5).max(1_440).default(60),
  })
  .strict()
  .default({});

export const ConversionSectionSchema = z
  .object({
    targets: z
      .array(z.enum(CONVERSION_TARGETS))
      .min(1)
      .max(CONVERSION_TARGETS.length)
      .refine(uniqueTargets, 'A conversion target may be listed once.')
      .default([...CONVERSION_TARGETS]),
    fieldMergeAllowed: z.boolean().default(false),
    mapping: MappingRecordSchema.default(DEFAULT_CONVERSION_MAPPING),
    recovery: ConversionRecoverySchema,
  })
  .strict()
  .default({});

/** Why one mapping line cannot run. Tokens the preview, the settings error and the report all share. */
export type MappingIssueCode =
  | 'source_unknown'
  | 'source_not_mappable'
  | 'target_unknown'
  | 'target_not_mappable'
  | 'type_incompatible'
  | 'duplicate_target'
  | 'template_unknown_field'
  | 'create_value_invalid'
  | 'version_not_bumped';

export interface MappingIssue {
  readonly code: MappingIssueCode;
  readonly path: string;
  readonly message: string;
}

/** A reason a preview could not propose a value. Closed list; the client keys its wording on it. */
export type SkipReason =
  | 'source_hidden'
  | 'empty_value'
  | 'target_no_such_field'
  | 'field_type_incompatible'
  | 'never_mappable'
  | 'relationship_field'
  | 'value_invalid'
  | 'target_has_value'
  | 'link_keeps_values'
  | 'person_target_present'
  | 'merge_not_allowed';

export interface ProposedField {
  readonly field: string;
  readonly value: unknown;
  readonly origin: 'mapped' | 'createDefault' | 'merge' | 'contextual';
}

export interface SkippedField {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly reason: SkipReason;
}

export interface FieldConflict {
  readonly field: string;
  /** What the linked record holds now — the "before" of the before/after the wizard must show. */
  readonly current: unknown;
  readonly proposed: unknown;
}

export interface TargetResolution {
  readonly proposed: readonly ProposedField[];
  readonly skipped: readonly SkippedField[];
  readonly required: readonly string[];
  readonly conflicts: readonly FieldConflict[];
  readonly notCopied: readonly string[];
}

export interface ResolveTargetInput {
  readonly target: MappingTarget;
  readonly action: 'create' | 'link';
  readonly mapping: TargetMapping;
  readonly lead: Readonly<Record<string, unknown>>;
  /** The Lead fields this reader may see — a hidden field is absent, which is not the same as empty. */
  readonly visibleLeadFields: ReadonlySet<string>;
  readonly merge: readonly { readonly field: string; readonly value: unknown }[];
  readonly mergeAllowed: boolean;
  readonly existing?: Readonly<Record<string, unknown>> | undefined;
  /** Whether the request also builds a Contact: it decides the Account's contextual e-mail/phone. */
  readonly personTargetPresent: boolean;
}

/** The Lead's own outcomes and system fields: never a source, whatever the types say. */
const LEAD_SOURCE_DENYLIST = new Set([
  'id',
  'name',
  'status',
  'createdAt',
  'modifiedAt',
  'createdById',
  'modifiedById',
  'deletedAt',
  'assignedUserId',
  'teams',
  'conversionOperationId',
]);

/** Target fields a mapping may never write: identity, ownership, and the derived/relationship carries. */
const TARGET_DENYLIST = new Set(['id', 'createdAt', 'modifiedAt', 'createdById', 'modifiedById', 'deletedAt', 'assignedUserId', 'teams']);
const RELATIONSHIP_FIELDS: Readonly<Record<MappingTarget, readonly string[]>> = {
  Contact: ['accountId'],
  Account: [],
  Opportunity: ['accountId', 'contactIds'],
};
/** Fields the kernel derives on create (`withName`), so writing them can only disagree with it. */
const DERIVED_FIELDS: Readonly<Record<MappingTarget, readonly string[]>> = {
  Contact: ['name'],
  Account: [],
  Opportunity: [],
};

/** Types whose values are never data a generic rule may copy (plan §5.7). */
const NEVER_MAPPABLE_TYPES = new Set(['password', 'file', 'attachment', 'attachmentMultiple', 'image', 'jsonArray', 'jsonObject', 'object', 'array']);
const TEXT_TYPES = new Set(['varchar', 'text', 'email', 'phone', 'url']);
const SPECIALISED_TEXT_TYPES = new Set(['email', 'phone', 'url']);
const NUMERIC_TYPES = new Set(['int', 'float', 'decimal', 'currency']);

/** Fields an Account receives from the Lead only when the conversion creates no Contact (contract §7.2). */
const CONTEXTUAL_ACCOUNT_FIELDS: readonly MappingField[] = [
  { from: 'emailAddress', to: 'emailAddress' },
  { from: 'phoneNumber', to: 'phoneNumber' },
];

const NOT_COPIED: Readonly<Record<MappingTarget, readonly string[]>> = {
  Contact: ['name', 'assignedUserId', 'teams'],
  Account: ['assignedUserId', 'teams'],
  Opportunity: ['assignedUserId', 'teams'],
};

/** The slice of a metadata field these rules need, so tests can state a field without inventing flags. */
export interface FieldShape {
  readonly type: string;
  readonly maxLength?: number | undefined;
  readonly entityKey?: string | undefined;
  readonly values?: readonly string[] | undefined;
  readonly enum?: readonly string[] | undefined;
}

/** Whether a Lead field may be a mapping source at all, before types are considered. */
export function isMappableSource(name: string): boolean {
  if (LEAD_SOURCE_DENYLIST.has(name)) return false;
  return !name.startsWith('score') && !name.startsWith('converted');
}

/** Whether a target field may be a mapping destination for this entity. */
export function isMappableTarget(target: MappingTarget, name: string): boolean {
  if (TARGET_DENYLIST.has(name)) return false;
  if (RELATIONSHIP_FIELDS[target].includes(name)) return false;
  if (DERIVED_FIELDS[target].includes(name)) return false;
  return !name.startsWith('score') && !name.startsWith('converted');
}

/**
 * Whether two metadata field types can carry the same value (contract §7.3).
 *
 * Strict on purpose: `text → varchar` is refused because the target's length bound would truncate, and
 * `datetime → date` because the time would vanish without anybody seeing it. Widening text (`varchar` into
 * `text`/`email`/`phone`/`url`) is allowed and the *value* is then checked by {@link valueIssue}.
 */
export function typeCompatible(from: FieldShape, to: FieldShape): boolean {
  if (NEVER_MAPPABLE_TYPES.has(from.type) || NEVER_MAPPABLE_TYPES.has(to.type)) return false;
  if (from.type === to.type) {
    if (from.type === 'varchar' && from.maxLength !== undefined && to.maxLength !== undefined && from.maxLength > to.maxLength) return false;
    if (from.type === 'link' || from.type === 'linkMultiple') return from.entityKey === to.entityKey;
    if (from.type === 'multiEnum') return sameValues(from, to);
    // Enumerations would need an explicit value map to be honest; this build has none, so it refuses the
    // pair rather than copying a stored label that the target's own list may not contain.
    if (from.type === 'enum') return false;
    return true;
  }
  if (TEXT_TYPES.has(from.type) && TEXT_TYPES.has(to.type)) {
    if (SPECIALISED_TEXT_TYPES.has(from.type)) return false; // an e-mail is not a URL, even though both are strings
    if (from.type === 'text') return false; // `text` has no length bound to respect, and no narrow target is safe
    if (to.type === 'varchar' && from.maxLength !== undefined && to.maxLength !== undefined && from.maxLength > to.maxLength) return false;
    return true;
  }
  if (NUMERIC_TYPES.has(from.type) && NUMERIC_TYPES.has(to.type)) return true;
  return false;
}

/**
 * Whether one value would be refused by the target field — the check that turns "types are compatible"
 * into "this value is executable" (contract §7.7's `value_invalid`).
 */
export function valueIssue(field: FieldShape, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : null;
  if (text !== null && text.trim() === '') return null;
  switch (field.type) {
    case 'email':
      return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : 'not an e-mail address';
    case 'url':
      return typeof value === 'string' && /^(https?:\/\/|www\.)\S+$/i.test(value.trim()) ? null : 'not a URL';
    case 'phone':
      return typeof value === 'string' ? null : 'not a phone number';
    case 'varchar': {
      if (typeof value !== 'string') return 'not text';
      return field.maxLength !== undefined && value.length > field.maxLength ? `longer than ${field.maxLength} characters` : null;
    }
    case 'text':
      return typeof value === 'string' ? null : 'not text';
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) ? null : 'not a whole number';
    case 'float':
    case 'decimal':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'not a number';
    case 'currency': {
      const amount = typeof value === 'number' ? value : typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['amount'] : undefined;
      return typeof amount === 'number' && Number.isFinite(amount) ? null : 'not an amount';
    }
    case 'bool':
      return typeof value === 'boolean' ? null : 'not true/false';
    case 'date':
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : 'not a date';
    case 'enum':
      return typeof value === 'string' && (field.values ?? field.enum ?? []).includes(value) ? null : 'not one of the field’s options';
    default:
      return null;
  }
}

/** `{{field}}` substitution for create defaults; unknown tokens are refused at map validation. */
export function composeTemplate(template: string, lead: Readonly<Record<string, unknown>>): string {
  const filled = template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, field: string) => {
    const value = lead[field];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
  return filled
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–-]+|[\s—–-]+$/g, '')
    .trim();
}

/** Every `{{field}}` a template names. */
export function templateTokens(template: string): string[] {
  return [...template.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map((match) => match[1] ?? '').filter((token) => token !== '');
}

/**
 * The canonical preview fingerprint (contract §8.3).
 *
 * Two components are security properties rather than bookkeeping: `leadScope` and `readerScope` are the
 * fields this actor could *see and write* when the preview was taken, so a permission change between
 * preview and confirm invalidates the fingerprint instead of letting the command write values the actor
 * can no longer read (plan §9.2 against §8.3).
 */
export interface PreviewHashInput {
  readonly leadId: string;
  readonly leadRevision: number;
  readonly targets: readonly { readonly type: MappingTarget; readonly action: 'create' | 'link'; readonly existingId: string | null }[];
  readonly mappingVersions: Readonly<Partial<Record<MappingTarget, number>>>;
  readonly fieldMerge: readonly { readonly target: MappingTarget; readonly field: string; readonly value?: unknown }[];
  readonly leadScope: readonly string[];
  readonly readerScope: Readonly<Record<string, readonly string[]>>;
  /**
   * Whether a merge may run at all on this installation right now (policy switch **and** the actor's
   * `applyFieldChanges`). Without it, two previews of the same plan — one where the merge would be applied
   * and one where it would be refused — would share a fingerprint, which is the one thing a fingerprint
   * must never do.
   */
  readonly fieldMergeAllowed: boolean;
}

export function previewHash(input: PreviewHashInput): string {
  const canonical = {
    leadId: input.leadId,
    leadRevision: input.leadRevision,
    targets: [...input.targets]
      .map((entry) => ({ type: entry.type, action: entry.action, existingId: entry.existingId }))
      .sort((left, right) => left.type.localeCompare(right.type)),
    mappingVersions: Object.fromEntries(Object.entries(input.mappingVersions).sort(([left], [right]) => left.localeCompare(right))),
    fieldMerge: [...input.fieldMerge]
      .map((entry) => ({ target: entry.target, field: entry.field, value: entry.value }))
      .sort((left, right) => `${left.target}:${left.field}`.localeCompare(`${right.target}:${right.field}`)),
    fieldMergeAllowed: input.fieldMergeAllowed,
    leadScope: [...input.leadScope].sort(),
    readerScope: Object.fromEntries(
      Object.entries(input.readerScope)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entity, fields]) => [entity, [...fields].sort()]),
    ),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

@Injectable()
export class LeadFieldMappingService {
  constructor(@Inject(METADATA_STORE) private readonly metadata: MetadataStoreService) {}

  /** Semantic validation of a conversion section, before the settings service stores it. */
  validateSection(section: ConversionSection): MappingIssue[] {
    const issues: MappingIssue[] = [];
    const lead = this.fieldsOf('Lead');
    if (lead === undefined) {
      issues.push({ code: 'source_unknown', path: 'conversion.mapping', message: 'The Lead entity is not registered.' });
      return issues;
    }
    for (const target of CONVERSION_TARGETS) {
      const mapping = section.mapping[target];
      if (mapping === undefined) continue;
      const targetFields = this.fieldsOf(target);
      if (targetFields === undefined) {
        issues.push({ code: 'target_unknown', path: `conversion.mapping.${target}`, message: `Entity "${target}" is not registered.` });
        continue;
      }
      const used = new Set<string>();
      for (const [index, entry] of mapping.fields.entries()) {
        const path = `conversion.mapping.${target}.fields.${index}`;
        if (used.has(entry.to)) {
          issues.push({ code: 'duplicate_target', path, message: `Two mapping lines write "${target}.${entry.to}".` });
          continue;
        }
        used.add(entry.to);
        const source = lead[entry.from];
        if (source === undefined) {
          issues.push({ code: 'source_unknown', path, message: `Lead has no field "${entry.from}".` });
          continue;
        }
        if (!isMappableSource(entry.from)) {
          issues.push({ code: 'source_not_mappable', path, message: `"${entry.from}" is a Lead outcome or system field and is never copied.` });
          continue;
        }
        const destination = targetFields[entry.to];
        if (destination === undefined) {
          issues.push({ code: 'target_unknown', path, message: `${target} has no field "${entry.to}".` });
          continue;
        }
        if (!isMappableTarget(target, entry.to)) {
          issues.push({ code: 'target_not_mappable', path, message: `"${target}.${entry.to}" is a relationship, derived or ownership field and is never mapped.` });
          continue;
        }
        if (!typeCompatible(source, destination)) {
          issues.push({
            code: 'type_incompatible',
            path,
            message: `A ${source.type} cannot be copied into ${target}.${entry.to} (${destination.type}).`,
          });
        }
      }
      for (const [field, value] of Object.entries(mapping.createDefaults)) {
        const path = `conversion.mapping.${target}.createDefaults.${field}`;
        const destination = targetFields[field];
        if (destination === undefined) {
          issues.push({ code: 'target_unknown', path, message: `${target} has no field "${field}".` });
          continue;
        }
        if (!isMappableTarget(target, field)) {
          issues.push({ code: 'target_not_mappable', path, message: `"${target}.${field}" is never written by a mapping.` });
          continue;
        }
        // A template is checked for its tokens here and for its *value* at preview time, when the Lead's
        // real values are known; a literal is checked now.
        const tokens = typeof value === 'string' ? templateTokens(value) : [];
        for (const token of tokens) {
          if (lead[token] === undefined) issues.push({ code: 'template_unknown_field', path, message: `The template names "{{${token}}}", which Lead has no field for.` });
        }
        if (tokens.length === 0) {
          const problem = valueIssue(destination, value);
          if (problem !== null) issues.push({ code: 'create_value_invalid', path, message: `The default for "${field}" is ${problem}.` });
        }
      }
    }
    return issues;
  }

  /**
   * A changed map must raise its own version.
   *
   * Stored conversions name the version they used, and a preview fingerprint includes it — so an edit
   * that kept the number would make an old preview look current and make two different policies share
   * one name (contract §7.1).
   */
  validateVersionBump(previous: ConversionSection, next: ConversionSection): MappingIssue[] {
    const issues: MappingIssue[] = [];
    for (const target of CONVERSION_TARGETS) {
      const before = previous.mapping[target];
      const after = next.mapping[target];
      if (before === undefined || after === undefined) continue;
      const changed = JSON.stringify(before.fields) !== JSON.stringify(after.fields) || JSON.stringify(before.createDefaults) !== JSON.stringify(after.createDefaults);
      if (changed && after.version <= before.version) {
        issues.push({
          code: 'version_not_bumped',
          path: `conversion.mapping.${target}.version`,
          message: `The ${target} map changed, so its version must increase (it is ${String(before.version)}).`,
        });
      }
    }
    return issues;
  }

  /**
   * What a conversion would write for one target, and everything it would not write.
   *
   * `create` proposes the mapped values plus the defaults; `link` proposes nothing except explicit merges,
   * because a link is a reference and the target keeps its own values unless a person asks for a merge
   * (contract §6.1, §7.5). Every value that could not be used carries a reason, and every linked value that
   * differs from what the record already holds becomes a `conflict` — the before/after the wizard shows.
   */
  resolveTarget(input: ResolveTargetInput): TargetResolution {
    const targetFields = this.fieldsOf(input.target) ?? {};
    const leadFields = this.fieldsOf('Lead') ?? {};
    const proposed = new Map<string, ProposedField>();
    const skipped: SkippedField[] = [];

    const entries: { from: string; to: string; origin: 'mapped' | 'contextual' }[] = [
      ...input.mapping.fields.map((entry) => ({ ...entry, origin: 'mapped' as const })),
      ...(input.target === 'Account' && !input.personTargetPresent
        ? CONTEXTUAL_ACCOUNT_FIELDS.map((entry) => ({ ...entry, origin: 'contextual' as const }))
        : []),
    ];

    for (const entry of entries) {
      if (!input.visibleLeadFields.has(entry.from)) {
        skipped.push({ from: entry.from, to: entry.to, reason: 'source_hidden' });
        continue;
      }
      const value = input.lead[entry.from];
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
        skipped.push({ from: entry.from, to: entry.to, reason: 'empty_value' });
        continue;
      }
      const destination = targetFields[entry.to];
      if (destination === undefined) {
        skipped.push({ from: entry.from, to: entry.to, reason: 'target_no_such_field' });
        continue;
      }
      if (isMappableTarget(input.target, entry.to) === false) {
        skipped.push({ from: entry.from, to: entry.to, reason: RELATIONSHIP_FIELDS[input.target].includes(entry.to) ? 'relationship_field' : 'never_mappable' });
        continue;
      }
      const source = leadFields[entry.from];
      if (source === undefined || !typeCompatible(source, destination)) {
        skipped.push({ from: entry.from, to: entry.to, reason: 'field_type_incompatible' });
        continue;
      }
      const problem = valueIssue(destination, value);
      if (problem !== null) {
        skipped.push({ from: entry.from, to: entry.to, reason: 'value_invalid' });
        continue;
      }
      if (input.action === 'link') {
        skipped.push({ from: entry.from, to: entry.to, reason: 'link_keeps_values' });
        continue;
      }
      proposed.set(entry.to, { field: entry.to, value, origin: entry.origin });
    }

    if (input.action === 'create') {
      for (const [field, raw] of Object.entries(input.mapping.createDefaults)) {
        if (proposed.has(field)) continue;
        const destination = targetFields[field];
        if (destination === undefined) {
          skipped.push({ to: field, reason: 'target_no_such_field' });
          continue;
        }
        const value = typeof raw === 'string' && templateTokens(raw).length > 0 ? composeTemplate(raw, input.lead) : raw;
        const problem = valueIssue(destination, value);
        if (problem !== null) {
          skipped.push({ to: field, reason: 'value_invalid' });
          continue;
        }
        proposed.set(field, { field, value, origin: 'createDefault' });
      }
    }

    for (const merge of input.merge) {
      const destination = targetFields[merge.field];
      if (destination === undefined) {
        skipped.push({ to: merge.field, reason: 'target_no_such_field' });
        continue;
      }
      if (!isMappableTarget(input.target, merge.field)) {
        skipped.push({ to: merge.field, reason: RELATIONSHIP_FIELDS[input.target].includes(merge.field) ? 'relationship_field' : 'never_mappable' });
        continue;
      }
      if (!input.mergeAllowed) {
        skipped.push({ to: merge.field, reason: 'merge_not_allowed' });
        continue;
      }
      const problem = valueIssue(destination, merge.value);
      if (problem !== null) {
        skipped.push({ to: merge.field, reason: 'value_invalid' });
        continue;
      }
      proposed.set(merge.field, { field: merge.field, value: merge.value, origin: 'merge' });
    }

    const conflicts: FieldConflict[] = [];
    if (input.action === 'link' && input.existing !== undefined) {
      const seen = new Set<string>();
      // A requested merge shows its own before/after, because that is the write the person asked for.
      for (const [field, candidate] of proposed) {
        const current = input.existing[field];
        if (current === null || current === undefined || current === '' || JSON.stringify(current) === JSON.stringify(candidate.value)) continue;
        conflicts.push({ field, current, proposed: candidate.value });
        seen.add(field);
      }
      // And every mapped value that *could* have been applied but differs is shown too: the wizard has to
      // say "these are not being applied, and here is what the record holds instead" (plan §7.4, §11.4).
      for (const [field, value] of this.differingMappedValues(input, targetFields, leadFields)) {
        if (seen.has(field)) continue;
        conflicts.push({ field, current: input.existing[field], proposed: value });
      }
    }

    const required = input.action === 'create'
      ? Object.entries(targetFields)
          // `Contact.name` is derived from `lastName` by the kernel, so reporting it beside `lastName` would
          // name the same gap twice; every other required field — Account/Opportunity `name` included — is
          // a real blocking value the wizard has to fill.
          .filter(([field, definition]) => definition.required === true && !proposed.has(field) && !(input.target === 'Contact' && field === 'name'))
          .map(([field]) => field)
      : [];

    return {
      proposed: [...proposed.values()],
      skipped,
      required,
      conflicts,
      notCopied: NOT_COPIED[input.target],
    };
  }

  /** Mapped values a link would not apply, paired with what the linked record holds, for the conflict list. */
  private differingMappedValues(
    input: ResolveTargetInput,
    targetFields: Readonly<Record<string, FieldDefinition>>,
    leadFields: Readonly<Record<string, FieldDefinition>>,
  ): [string, unknown][] {
    const out: [string, unknown][] = [];
    const existing = input.existing ?? {};
    for (const entry of input.mapping.fields) {
      if (!input.visibleLeadFields.has(entry.from)) continue;
      const value = input.lead[entry.from];
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) continue;
      const destination = targetFields[entry.to];
      const source = leadFields[entry.from];
      if (destination === undefined || source === undefined || !typeCompatible(source, destination)) continue;
      if (valueIssue(destination, value) !== null) continue;
      const current = existing[entry.to];
      if (current === null || current === undefined || current === '') continue;
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      out.push([entry.to, value]);
    }
    return out;
  }

  private fieldsOf(entity: string): Record<string, FieldDefinition> | undefined {
    return this.metadata.registry.getEntity(entity)?.fields;
  }
}

function sameValues(left: FieldShape, right: FieldShape): boolean {
  const a = [...(left.values ?? left.enum ?? [])].sort();
  const b = [...(right.values ?? right.enum ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
