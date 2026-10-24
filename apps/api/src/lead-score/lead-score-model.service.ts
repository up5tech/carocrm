import { ValidationError } from '@carocrm/core/errors/index.js';
import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { ScoreableField } from './lead-score-condition.js';
import { leadScoreDraftExistsError,leadScoreInvalidStateError } from './lead-score-errors.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { runAsLeadScoreInternal } from './lead-score-internal.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import type { ModelAttributes, RuleAttributes, ValidationReport } from './lead-score-validator.js';
import { validateModel } from './lead-score-validator.js';

/**
 * Phase 19-LS.3 — the score model lifecycle
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §9.1, §16 `19-LS.3`; audit §5.1).
 *
 * This service owns the four things a record API must never decide for itself:
 *
 * - **validate** a draft: run `validateModel` over the stored model and its rules and answer with every
 *   problem, each with a stable code (plan §6.1 "Validate rules and show errors/warnings");
 * - **publish** a draft: validation must pass first, and the row becomes immutable. A published version
 *   is what a stored evaluation names as its provenance, so it must never change underneath a score
 *   (§0.1-5, §5.1);
 * - **archive** a model: the fast off-switch plan §9.3 asks for, which leaves the history alone;
 * - **create a new version** from a published or archived model: the only way to "edit" one. Rules are
 *   copied with it, so the previous version stays intact and the plan's rollback story — re-publish an
 *   earlier configuration as a *new* version — is possible without mutating history (§5.1, §6.1).
 *
 * Draft rows themselves are ordinary metadata records, edited through the generic `/api/v1/LeadScoreModel`
 * and `/api/v1/LeadScoreRule` API. This module does not fork a second CRUD layer (AGENTS.md §5.2): the
 * Entity Engine keeps validation, field ACL, audit, stream, hooks and optimistic concurrency, and the
 * guard in `lead-score-write-guard.service.ts` refuses a client write that would cross the line between
 * draft and published.
 *
 * Everything this service writes goes through `EntityCrudService` under `runAsLeadScoreInternal`, inside
 * `runInTransaction` when more than one row is involved — so the `status` and stamp fields it owns are
 * written by the only caller that is allowed to write them, and a fork is never half-copied.
 */

/** The entity the model scores. Lead Score qualifies Leads; it is not a general scoring engine (plan §1). */
const SCORED_ENTITY = 'Lead';

/**
 * Read bounds. A model past these is a configuration problem rather than a paging problem, so the read is
 * capped and the validator sees a complete set — never a silently truncated one.
 */
const MAX_RULES_PER_MODEL = 200;
const MAX_VERSIONS_PER_MODEL = 200;

@Injectable()
export class LeadScoreModelService {
  constructor(
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Validate a model with its rules.
   *
   * Read-only and side-effect free: it writes nothing, changes no score and touches no Lead. An
   * administrator can call it on a half-finished draft as often as they like (plan §6.1).
   */
  async validate(modelId: string): Promise<ValidationReport> {
    await this.gate.assertOperation('validateModel');
    const { model, rules } = await this.readModel(modelId);
    return validateModel(model, rules, { fields: this.scoredFields() });
  }

  /**
   * Publish a draft as an immutable version.
   *
   * The refusal order matters. Capability first (a caller who may not manage models learns nothing about
   * the installation), then state (only a draft publishes), then content (an invalid model cannot become
   * a version). Validation is *re-run here* rather than trusted from an earlier `validate` call, because
   * a rule could have been edited in between and a published version must be a version that was valid at
   * the moment it was frozen.
   */
  async publish(modelId: string, expectedVersion?: number): Promise<Record<string, unknown>> {
    await this.gate.assertOperation('publishModel');
    const { model, rules } = await this.readModel(modelId);
    if (model.status !== 'draft') {
      throw leadScoreInvalidStateError(
        'publish',
        model.status,
        'A published version is immutable. Create a new version from it to change the rules.',
      );
    }

    const report = validateModel(model, rules, { fields: this.scoredFields() });
    if (!report.valid) {
      throw new ValidationError('This score model cannot be published.', {
        modelId,
        issues: report.errors.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message, ...(issue.ruleId !== undefined ? { ruleId: issue.ruleId } : {}) })),
      });
    }

    const now = new Date();
    const actor = this.scope.userId;
    return runAsLeadScoreInternal(() =>
      this.records.update('LeadScoreModel', modelId, {
        status: 'published',
        publishedById: actor ?? null,
        publishedAt: now,
        ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
      }),
    );
  }

  /**
   * Archive a model.
   *
   * The switch plan §9.3 asks for — "make it possible to disable a rule/model quickly without destroying
   * historic evaluations". Stored evaluations keep naming the version they came from; archiving only
   * stops it being the model a new score is read from (19-LS.4 owns that read).
   */
  async archive(modelId: string, expectedVersion?: number): Promise<Record<string, unknown>> {
    await this.gate.assertOperation('publishModel');
    const { model } = await this.readModel(modelId);
    if (model.status === 'archived') {
      throw leadScoreInvalidStateError('archive', 'archived', 'This model version is already archived.');
    }

    const now = new Date();
    const actor = this.scope.userId;
    return runAsLeadScoreInternal(() =>
      this.records.update('LeadScoreModel', modelId, {
        status: 'archived',
        archivedById: actor ?? null,
        archivedAt: now,
        ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
      }),
    );
  }

  /**
   * Open a new draft version from a published or archived one.
   *
   * Plan §5.1: "Editing a published model creates a new draft/version." The previous row is untouched,
   * its rules stay attached to it, and the copy carries the same configuration into version N+1 — which
   * is also how a rollback is performed: fork the old version and publish it forward as a new one
   * (§6.1), rather than rewriting a frozen version.
   *
   * The model row and its rules are written in one transaction, because a half-copied rule set would be
   * a draft that silently scores differently from the version it came from.
   */
  async newVersion(modelId: string): Promise<Record<string, unknown>> {
    await this.gate.assertOperation('createModelVersion');
    const { model, rules } = await this.readModel(modelId);
    if (model.status === 'draft') {
      throw leadScoreInvalidStateError('create a new version', 'draft', 'A draft is already the editable version — edit this row instead of copying it.');
    }

    const siblings = await this.siblingVersions(model.name);
    const existingDraft = siblings.find((entry) => entry.status === 'draft');
    if (existingDraft !== undefined) {
      throw leadScoreDraftExistsError(model.name, existingDraft.id);
    }
    const nextVersion = Math.max(...siblings.map((entry) => entry.modelVersion), model.modelVersion) + 1;

    const actor = this.scope.userId;
    return runAsLeadScoreInternal(() =>
      runInTransaction(this.database.db, async () => {
        const source = await this.records.get('LeadScoreModel', modelId);
        const copy = pickModelAttributes(source);
        const created = await this.records.create('LeadScoreModel', {
          ...copy,
          status: 'draft',
          modelVersion: nextVersion,
          description: typeof source['description'] === 'string' ? source['description'] : undefined,
          assignedUserId: actor ?? null,
        });
        const newId = String(created['id'] ?? '');
        for (const rule of rules) {
          await this.records.create('LeadScoreRule', {
            name: rule.name,
            description: rule.description,
            modelId: newId,
            modelVersion: nextVersion,
            reasonCode: rule.reasonCode,
            dimension: rule.dimension,
            enabled: rule.enabled,
            condition: rule.condition,
            effect: rule.effect,
            points: rule.points,
            priority: rule.priority,
            missingDataPolicy: rule.missingDataPolicy,
            signalSource: rule.signalSource,
            ...(rule.targetBand !== undefined ? { targetBand: rule.targetBand } : {}),
            ...(rule.eventType !== undefined ? { eventType: rule.eventType } : {}),
            ...(rule.lookbackDays !== undefined && rule.lookbackDays !== null ? { lookbackDays: rule.lookbackDays } : {}),
            ...(rule.decayPolicy !== undefined ? { decayPolicy: rule.decayPolicy } : {}),
            ...(rule.decayHalfLifeDays !== undefined && rule.decayHalfLifeDays !== null ? { decayHalfLifeDays: rule.decayHalfLifeDays } : {}),
            ...(actor !== undefined ? { assignedUserId: actor } : {}),
          });
        }
        return created;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /**
   * Every model version of one name.
   *
   * Read through the generic list so the record ACL applies: an administrator managing models sees the
   * versions they may see, and a version hidden by ACL cannot be used to compute the next version number
   * for a name they may not read.
   */
  async siblingVersions(name: string): Promise<{ id: string; status: string; modelVersion: number }[]> {
    await this.permissions.assert('modelRead');
    const listed = await this.records.list('LeadScoreModel', {
      where: [{ field: 'name', operator: 'equals', value: name }],
      orderBy: 'modelVersion',
      order: 'desc',
      maxSize: MAX_VERSIONS_PER_MODEL,
      total: false,
    });
    return listed.list.map((row) => ({
      id: String(row['id'] ?? ''),
      status: String(row['status'] ?? 'draft'),
      modelVersion: numberOr(row['modelVersion'], 1),
    }));
  }

  /** The scored entity's fields, as the validator needs them: type, length and option list. */
  scoredFields(): ReadonlyMap<string, ScoreableField> {
    const definition: EntityDefinition | undefined = this.metadata.registry.getEntity(SCORED_ENTITY);
    const map = new Map<string, ScoreableField>();
    if (definition === undefined) return map;
    for (const [name, field] of Object.entries(definition.fields)) {
      const options = field.values ?? field.enum;
      map.set(name, {
        name,
        type: field.type,
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        ...(options !== undefined ? { options } : {}),
      });
    }
    return map;
  }

  /**
   * The model row and the rules attached to it.
   *
   * A missing or ACL-invisible model answers `RECORD_NOT_FOUND` — the same shape as any other record read,
   * and it does not confirm that the id exists somewhere else.
   */
  async readModel(modelId: string): Promise<{ model: ModelAttributes; rules: RuleAttributes[] }> {
    const record = await this.records.get('LeadScoreModel', modelId);
    const model = toModelAttributes(modelId, record);

    // The declared `rules` oneToMany, resolved by the entity layer: same ACL, same relation predicate,
    // and no second query path that could drift from it.
    const related = await this.records.related('LeadScoreModel', modelId, 'rules', {
      orderBy: 'priority',
      order: 'asc',
      maxSize: MAX_RULES_PER_MODEL,
      total: false,
    });
    const rules = related.list.map((row) => toRuleAttributes(modelId, row));
    return { model, rules };
  }
}

export function toModelAttributes(id: string, row: Record<string, unknown>): ModelAttributes {
  return {
    id,
    name: stringOr(row['name'], ''),
    status: stringOr(row['status'], 'draft'),
    modelVersion: numberOr(row['modelVersion'], 1),
    scaleMin: numberOr(row['scaleMin'], 0),
    scaleMax: numberOr(row['scaleMax'], 100),
    baseScore: numberOr(row['baseScore'], 0),
    scoreFloor: numberOr(row['scoreFloor'], 0),
    scoreCeiling: numberOr(row['scoreCeiling'], 100),
    qualificationBands: optionalString(row['qualificationBands']),
    dimensionWeights: optionalString(row['dimensionWeights']),
    allowedFieldPaths: optionalString(row['allowedFieldPaths']),
    blockedFieldPaths: optionalString(row['blockedFieldPaths']),
    settingsJson: optionalString(row['settingsJson']),
  };
}

export function toRuleAttributes(modelId: string, row: Record<string, unknown>): RuleAttributes {
  return {
    id: String(row['id'] ?? ''),
    name: stringOr(row['name'], ''),
    description: optionalString(row['description']),
    modelId: stringOr(row['modelId'], modelId),
    modelVersion: numberOr(row['modelVersion'], 1),
    reasonCode: stringOr(row['reasonCode'], ''),
    dimension: stringOr(row['dimension'], 'fit'),
    enabled: row['enabled'] !== false,
    condition: stringOr(row['condition'], ''),
    effect: stringOr(row['effect'], 'add'),
    points: numberOr(row['points'], 0),
    priority: numberOr(row['priority'], 100),
    missingDataPolicy: stringOr(row['missingDataPolicy'], 'neutral'),
    signalSource: stringOr(row['signalSource'], 'lead'),
    targetBand: optionalString(row['targetBand']),
    eventType: optionalString(row['eventType']),
    lookbackDays: optionalNumber(row['lookbackDays']),
    decayPolicy: optionalString(row['decayPolicy']),
    decayHalfLifeDays: optionalNumber(row['decayHalfLifeDays']),
  };
}

/** The configuration a new version starts from. Stamps are excluded: they describe the old version. */
function pickModelAttributes(source: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'scaleMin', 'scaleMax', 'baseScore', 'scoreFloor', 'scoreCeiling', 'qualificationBands', 'dimensionWeights', 'allowedFieldPaths', 'blockedFieldPaths', 'settingsJson']) {
    if (source[key] !== undefined) copy[key] = source[key];
  }
  return copy;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
