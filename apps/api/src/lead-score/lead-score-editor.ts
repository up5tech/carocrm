import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import {
  ARRAY_OPERATORS,
  LIST_OPERATORS,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LIST_VALUES,
  MAX_CONDITION_NODES,
  MAX_CONDITION_PREDICATES,
  MAX_CONDITION_VALUE_CHARS,
  NEVER_SCORABLE_FIELD_TYPES,
  OPERATORS_BY_TYPE,
  PROTECTED_FIELD_NAMES,
  type ScoreableField,
  SCORING_OUTPUT_FIELD_NAMES,
  VALUELESS_OPERATORS,
} from './lead-score-condition.js';
import { MAX_RULES_PER_MODEL, MAX_VERSIONS_PER_MODEL } from './lead-score-model.service.js';
import { MAX_PREVIEW_SAMPLE } from './lead-score-preview.service.js';
import { MAX_BATCH_CHUNK, MAX_BATCH_TOTAL } from './lead-score-recalculation.service.js';
import type { ModelAttributes } from './lead-score-validator.js';
import {
  DECAY_POLICIES,
  EVALUATION_RESULT_STATES,
  EVALUATION_STATUSES,
  EVALUATION_TRIGGERS,
  MISSING_DATA_POLICIES,
  MODEL_STATUSES,
  RULE_DIMENSIONS,
  RULE_EFFECTS,
  RULE_OUTCOMES,
  SCORE_BANDS,
  SIGNAL_SOURCES,
} from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.8 — what a model editor is allowed to offer
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §6.3, §9.4, §12, §16 `19-LS.8`; audit §5.2, §11).
 *
 * The plan's exit criterion is that an administrator can manage a deterministic model **without editing raw
 * JSON manually or running code**. A rule's condition is stored as a JSON tree (LS.2: the platform has no
 * object field type), so the honest way to meet that criterion is not a JSON textarea with a warning — it is
 * a form whose choices are the same sets the validator enforces. That makes this file the editor's contract:
 * it answers, from the module's own tables, three questions the SPA must not answer for itself.
 *
 * 1. **Which fields exist, and which of them may carry a signal at all.** The Lead's declared fields come
 *    from the metadata registry, and each is classified by the *same* three denylists the validator uses
 *    (`NEVER_SCORABLE_FIELD_TYPES`, `PROTECTED_FIELD_NAMES`, `SCORING_OUTPUT_FIELD_NAMES`). A field that is
 *    refused is returned with its reason rather than omitted, because "why can't I score on this?" is a
 *    question the screen should be able to answer, and an omission teaches nothing.
 * 2. **Which operators a field's type can answer.** `OPERATORS_BY_TYPE` is LS.3's type matrix — the thing
 *    that makes `gt` on a boolean or `contains` on an integer impossible to publish — so the editor offers
 *    exactly those operators and no others. If the SPA kept its own copy, the two would drift and the
 *    administrator would discover the drift as a publish error.
 * 3. **What the value control should be.** `valueKind` says text/number/date/datetime/boolean/options and
 *    `none` for the valueless operators, with the option list and the length bound from metadata, plus the
 *    condition's structural limits (depth, predicates, nodes, list size, value length) so the builder can
 *    stop at the same boundary the parser refuses rather than after it.
 *
 * Everything here is derived from declared metadata and from the module's own constants. It reads no Lead,
 * no score and no rule body, so it is safe to serve to anyone with the model-read right — and it is served
 * to exactly that right, because a caller who may not read models has no use for the vocabulary either.
 */

/** The entity this build scores. One constant, shared with the model service's `scoredFields()`. */
const SCORED_ENTITY = 'Lead';

/** Why a field cannot carry a signal, in the vocabulary the validator itself uses. */
export type EditorFieldRefusal = 'never_scorable_type' | 'protected' | 'scoring_output' | 'unknown_type';

export interface EditorField {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  /** Operators this field's type can answer. Empty when the field is refused. */
  readonly operators: readonly string[];
  /** Which control the value should be: also `none` when every offered operator is valueless. */
  readonly valueKind: 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'boolean' | 'option' | 'options' | 'none';
  readonly options?: readonly string[] | undefined;
  readonly maxLength?: number | undefined;
  /** `true` when a rule may read this field under the built-in policy. */
  readonly scorable: boolean;
  readonly refusal?: EditorFieldRefusal | undefined;
  /** Why it was refused, in the module's own stable code, when the refusal needs one. */
  readonly refusalCode?: string | undefined;
  /** Whether the model named in the request grants this path (absent when no model was named). */
  readonly inModelAllowlist?: boolean | undefined;
}

export interface EditorCatalog {
  readonly entity: string;
  readonly entityLabel: string;
  readonly fields: readonly EditorField[];
  readonly condition: {
    readonly maxDepth: number;
    readonly maxPredicates: number;
    readonly maxNodes: number;
    readonly maxListValues: number;
    readonly maxValueChars: number;
    readonly valuelessOperators: readonly string[];
    readonly listOperators: readonly string[];
    readonly arrayOperators: readonly string[];
    readonly allOperators: readonly string[];
  };
  readonly vocabularies: {
    readonly dimensions: readonly string[];
    readonly effects: readonly string[];
    readonly outcomes: readonly string[];
    readonly missingDataPolicies: readonly string[];
    readonly signalSources: readonly string[];
    readonly bands: readonly string[];
    readonly modelStatuses: readonly string[];
    readonly evaluationStatuses: readonly string[];
    readonly evaluationResultStates: readonly string[];
    readonly evaluationTriggers: readonly string[];
    readonly decayPolicies: readonly string[];
  };
  readonly limits: { readonly maxRulesPerModel: number; readonly maxVersionsPerModel: number; readonly maxPreviewSample: number; readonly maxBatchChunk: number; readonly maxBatchTotal: number };
  /** The model the catalog was asked for, when it was asked for one. */
  readonly model?: {
    readonly id: string;
    readonly name: string;
    readonly modelVersion: number;
    readonly status: string;
    readonly allowedFieldPaths: readonly string[];
    readonly blockedFieldPaths: readonly string[];
  } | undefined;
}

@Injectable()
export class LeadScoreEditorService {
  constructor(@Inject(METADATA_STORE) private readonly metadata: MetadataStoreService) {}

  /**
   * The editor's vocabulary for the scored entity.
   *
   * `model` is optional and only ever *annotates* the answer with the model's own allowlist; the built-in
   * refusals apply whether or not a model was named, because the denylists are policy and not configuration.
   */
  catalog(model?: ModelAttributes): EditorCatalog {
    const definition: EntityDefinition | undefined = this.metadata.registry.getEntity(SCORED_ENTITY);
    const allowed = model === undefined ? undefined : parsePaths(model.allowedFieldPaths);
    const blocked = model === undefined ? [] : (parsePaths(model.blockedFieldPaths) ?? []);
    const granted = allowed === undefined ? undefined : new Set(allowed);
    const fields: EditorField[] = definition === undefined ? [] : this.fieldsOf(definition, granted, blocked);
    const allOperators = [...new Set(Object.values(OPERATORS_BY_TYPE).flat())].sort();

    return {
      entity: SCORED_ENTITY,
      entityLabel: definition?.label ?? SCORED_ENTITY,
      fields,
      condition: {
        maxDepth: MAX_CONDITION_DEPTH,
        maxPredicates: MAX_CONDITION_PREDICATES,
        maxNodes: MAX_CONDITION_NODES,
        maxListValues: MAX_CONDITION_LIST_VALUES,
        maxValueChars: MAX_CONDITION_VALUE_CHARS,
        valuelessOperators: [...VALUELESS_OPERATORS].sort(),
        listOperators: [...LIST_OPERATORS].sort(),
        arrayOperators: [...ARRAY_OPERATORS].sort(),
        allOperators,
      },
      vocabularies: {
        dimensions: [...RULE_DIMENSIONS],
        effects: [...RULE_EFFECTS],
        outcomes: [...RULE_OUTCOMES],
        missingDataPolicies: [...MISSING_DATA_POLICIES],
        signalSources: [...SIGNAL_SOURCES],
        bands: [...SCORE_BANDS],
        modelStatuses: [...MODEL_STATUSES],
        evaluationStatuses: [...EVALUATION_STATUSES],
        evaluationResultStates: [...EVALUATION_RESULT_STATES],
        evaluationTriggers: [...EVALUATION_TRIGGERS],
        decayPolicies: [...DECAY_POLICIES],
      },
      limits: {
        maxRulesPerModel: MAX_RULES_PER_MODEL,
        maxVersionsPerModel: MAX_VERSIONS_PER_MODEL,
        maxPreviewSample: MAX_PREVIEW_SAMPLE,
        maxBatchChunk: MAX_BATCH_CHUNK,
        maxBatchTotal: MAX_BATCH_TOTAL,
      },
      ...(model === undefined || allowed === undefined
        ? {}
        : {
            model: {
              id: model.id,
              name: model.name,
              modelVersion: model.modelVersion,
              status: model.status,
              allowedFieldPaths: allowed,
              blockedFieldPaths: blocked,
            },
          }),
    };
  }

  private fieldsOf(definition: EntityDefinition, granted: ReadonlySet<string> | undefined, blocked: readonly string[]): EditorField[] {
    const blockedSet = new Set(blocked);
    return Object.entries(definition.fields)
      .map(([name, field]) => {
        const options = field.values ?? field.enum;
        const entry: ScoreableField = {
          name,
          type: field.type,
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(options !== undefined ? { options } : {}),
        };
        const refusal = refusalOf(entry);
        const operators = refusal === undefined ? [...(OPERATORS_BY_TYPE[field.type] ?? [])] : [];
        const valueKind = refusal === undefined ? valueKindOf(field.type, operators) : 'none';
        return {
          name,
          label: field.label && field.label.trim() !== '' ? field.label : humanize(name),
          type: field.type,
          operators,
          valueKind,
          ...(options === undefined ? {} : { options: [...options] }),
          ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
          scorable: refusal === undefined,
          ...(refusal === undefined ? {} : { refusal }),
          ...(refusal === undefined ? {} : { refusalCode: refusalCodeOf(refusal, field.type) }),
          // The annotation answers "would a rule be able to read this if the model granted it": a field the
          // built-in denylists refuse is never in the grant, so a screen cannot offer what the validator
          // will reject (plan §0.1-6, §10.4).
          ...(granted === undefined ? {} : { inModelAllowlist: refusal === undefined && granted.has(name) && !blockedSet.has(name) }),
        } satisfies EditorField;
      })
      .sort((left, right) => Number(right.scorable) - Number(left.scorable) || left.label.localeCompare(right.label));
  }
}

/**
 * The stored allowlist is a JSON array in a text attribute (LS.2), and a draft may hold anything in it
 * until validation runs. A value that is not a list of names is reported as no grant at all rather than
 * thrown: this endpoint annotates the catalog, it does not validate the model, and `action/model/validate`
 * is where a malformed list is named with its code.
 */
function parsePaths(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return undefined;
  }
}

/** The validator's own three denylists, in the order it applies them. */
function refusalOf(field: ScoreableField): EditorFieldRefusal | undefined {
  if (NEVER_SCORABLE_FIELD_TYPES.has(field.type)) return 'never_scorable_type';
  if (PROTECTED_FIELD_NAMES.includes(field.name)) return 'protected';
  if (SCORING_OUTPUT_FIELD_NAMES.includes(field.name)) return 'scoring_output';
  // A type the matrix has never heard of is refused rather than guessed at: an unknown type would otherwise
  // be offered with no operators and look like a policy refusal when it is a metadata gap.
  return OPERATORS_BY_TYPE[field.type] === undefined ? 'unknown_type' : undefined;
}

function refusalCodeOf(refusal: EditorFieldRefusal, type: string): string {
  if (refusal === 'never_scorable_type') return 'LS_CONDITION_FIELD_NEVER_SCORABLE';
  if (refusal === 'protected') return 'LS_CONDITION_FIELD_PROTECTED';
  if (refusal === 'scoring_output') return 'LS_CONDITION_FIELD_IS_SCORING_OUTPUT';
  return `LS_CONDITION_NO_OPERATOR_FOR_${type.toUpperCase()}`;
}

/**
 * What the value control should be — derived from the operators on offer, not from the type name alone,
 * because a link field whose only legal operators are `isEmpty`/`isNotEmpty` needs no value at all.
 */
function valueKindOf(type: string, operators: readonly string[]): EditorField['valueKind'] {
  if (operators.length > 0 && operators.every((operator) => VALUELESS_OPERATORS.has(operator))) return 'none';
  if (type === 'enum') return operators.some((operator) => LIST_OPERATORS.has(operator)) ? 'options' : 'option';
  if (type === 'multiEnum') return 'options';
  if (type === 'bool') return 'boolean';
  if (type === 'int' || type === 'float' || type === 'decimal' || type === 'currency' || type === 'aggregationCount') return 'number';
  if (type === 'date') return 'date';
  if (type === 'datetime') return 'datetime';
  if (type === 'text') return 'textarea';
  return 'text';
}

/** The platform's own humanization, matching `fieldLabel` in the SPA, so a label is never a surprise. */
function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
