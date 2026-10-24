import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import {
  LEAD_CONVERTED_STATUS,
  LEAD_DEAD_STATUS,
  LEADSCORE_CORE_ENTITY_TYPES,
} from './lead-score-domain.js';
import { LeadScoreFeatureGate, type LeadScoreOperationAssessment } from './lead-score-feature-gate.service.js';
import { LEADSCORE_ENTITY_TYPES, SERVER_OWNED_LEAD_FIELDS } from './lead-score-internal.js';
import {
  LEADSCORE_FEATURES,
  LEADSCORE_MODULE,
  type LeadScoreFeatureDescriptor,
  type LeadScorePlatformCapability,
  OPTIONAL_INTEGRATIONS,
  type PlatformEvidence,
  REQUIRED_CAPABILITIES,
} from './lead-score-module.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { type LeadScoreSettings, LeadScoreSettingsService,type LeadScoreSettingsView } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.1 — module health, read from the running system
 * (`PLAN_Phase_19_LeadScore.md` §4.1, §15.2, §16 `19-LS.1`; audit §1, §12).
 *
 * "The module is registered, loads cleanly and does not conflict with existing Lead behavior" is only
 * honest if an operator can *see* it, so every fact here is queried: `information_schema` for the
 * tables, the metadata registry for the entities and the Lead field list, the hook registry for its
 * phases, the settings row for the switches, and the same gate that would refuse an operation. Nothing
 * is hard-coded `true`.
 *
 * Two answers are kept apart on purpose, as in `ESignature`: `ok` says the **platform foundation** and
 * the registration invariants hold — that is what a broken installation would fail. `ready` says
 * whether a Lead Score operation is admitted *today*, and it is `false` at LS.1 for the right reason:
 * the phases that implement scoring and conversion have not shipped. An operator must be able to tell
 * "a dependency is missing" from "this is not built yet".
 *
 * Nothing in this view is a secret: no Lead data, no rule bodies, no role names.
 */

export interface HealthDependency {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly evidence: readonly { readonly kind: string; readonly value: string; readonly present: boolean }[];
  readonly missing: readonly string[];
}

export interface HealthIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  readonly present: boolean;
  readonly status: 'available' | 'unavailable';
}

export interface HealthFeature {
  readonly key: string;
  readonly label: string;
  readonly settingsPath: string;
  readonly requires: readonly string[];
  /** The administrator's switch. */
  readonly enabled: boolean;
  /** Whether this build implements the feature at all. */
  readonly implemented: boolean;
  /** Enabled *and* implemented *and* its requirements satisfied — what the gate consults. */
  readonly effective: boolean;
  readonly pendingPhase: string | null;
}

export interface HealthCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface LeadScoreHealthView {
  readonly module: typeof LEADSCORE_MODULE;
  readonly ok: boolean;
  readonly ready: boolean;
  /** Why nothing is admitted yet, in one sentence an operator can act on. */
  readonly reason: string;
  readonly dependencies: readonly HealthDependency[];
  readonly optionalIntegrations: readonly HealthIntegration[];
  readonly features: readonly HealthFeature[];
  readonly capabilities: readonly { readonly key: string; readonly label: string; readonly granted: boolean }[];
  readonly operations: readonly LeadScoreOperationAssessment[];
  readonly settings: {
    readonly version: number;
    readonly enabled: boolean;
    readonly updatedAt: string | null;
    readonly updatedBy: string | null;
    readonly warnings: readonly { readonly code: string; readonly message: string }[];
  };
  readonly checks: readonly HealthCheck[];
}

/**
 * The Lead attributes this module owns, and the DDL 19-LS.2 added. Both are asserted against the running
 * system rather than reported from the plan: the fields come from the metadata registry, the indexes come
 * from `pg_indexes`. If a seed or a migration is missing on an installation, the health view says which.
 */
const LEADSCORE_OWNED_LEAD_FIELDS = SERVER_OWNED_LEAD_FIELDS;

/** Every index `database/migrations/073_phase19_lead_score.sql` creates. */
const LEADSCORE_SCHEMA_INDEXES = [
  'idx_entity_records_lead_score_value',
  'idx_entity_records_lead_score_band',
  'idx_entity_records_lead_score_status',
  'idx_entity_records_lead_score_calculated',
  'idx_entity_records_lead_score_model',
  'idx_entity_records_lead_score_model_status',
  'uq_entity_records_lead_score_model_version',
  'idx_entity_records_lead_score_rule_model',
  'uq_entity_records_lead_score_rule_reason',
  'idx_entity_records_lead_score_evaluation_lead',
  'idx_entity_records_lead_score_evaluation_model',
  'uq_entity_records_lead_score_evaluation_key',
  'uq_entity_records_lead_conversion_operation_key',
  'idx_entity_records_lead_conversion_operation_lead',
  'idx_entity_records_lead_conversion_operation_status',
] as const;

/** The hook names the write guard registers; their presence is what makes the guard verifiable. */
const LEADSCORE_GUARD_HOOKS = [
  'leadScore.leadFieldGuard',
  'leadScore.LeadScoreEvaluationGuard',
  'leadScore.LeadConversionOperationGuard',
  // 19-LS.3: the lifecycle half of the guard, which is what makes a published version immutable in the
  // storage path rather than in the editor. Each owns a write hook and a delete hook, because a delete
  // never reaches `beforeValidate`.
  'leadScore.LeadScoreModelGuard',
  'leadScore.LeadScoreModelDeleteGuard',
  'leadScore.LeadScoreRuleGuard',
  'leadScore.LeadScoreRuleDeleteGuard',
] as const;

type FieldMap = Record<string, { values?: readonly unknown[]; enum?: readonly unknown[]; inEdit?: boolean; type?: string }>;

@Injectable()
export class LeadScoreModuleHealthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
  ) {}

  async health(): Promise<LeadScoreHealthView> {
    const schema = await this.readSchemaFacts();
    const indexes = await this.readIndexNames();
    const hookNames = new Set(this.hooks.list().map((hook) => hook.name));
    const settingsView = await this.settings.read();
    const entities = new Set(this.metadata.registry.getEntities());
    const phases = new Set<string>(this.hooks.phases());
    const leadFields: FieldMap = entities.has('Lead') ? (this.metadata.registry.getFields('Lead') as unknown as FieldMap) : {};
    const operations = await this.gate.assessAll();
    const capabilities = await this.permissions.describe();

    const dependencies: HealthDependency[] = REQUIRED_CAPABILITIES.map((capability: LeadScorePlatformCapability) => {
      const evidence = capability.evidence.map((item: PlatformEvidence) => ({
        kind: item.kind,
        value: item.value,
        present: presentEvidence(item, entities, schema, phases),
      }));
      const missing = evidence.filter((item) => !item.present).map((item) => `${item.kind}:${item.value}`);
      return { id: capability.id, label: capability.label, present: missing.length === 0, evidence, missing };
    });

    const optionalIntegrations: HealthIntegration[] = OPTIONAL_INTEGRATIONS.map((integration) => ({
      id: integration.id,
      label: integration.label,
      provides: integration.provides,
      present: entities.has(integration.markerEntity),
      status: entities.has(integration.markerEntity) ? ('available' as const) : ('unavailable' as const),
    }));

    const features = featureList(settingsView);
    const checks: HealthCheck[] = [
      coreLeadLifecycleIntact(entities, leadFields),
      ownedLeadFieldsRegistered(entities, leadFields),
      coreLeadFieldsStillEditable(leadFields),
      entityRegistration(entities),
      schemaStructures(indexes),
      writeGuardRegistered(hookNames),
      platformFoundation(dependencies),
    ];
    const ok = dependencies.every((dependency) => dependency.present) && checks.every((check) => check.ok);
    const ready = operations.some((operation) => operation.admitted);

    return {
      module: LEADSCORE_MODULE,
      ok,
      ready,
      reason: refusalReason(settingsView, features, ready),
      dependencies,
      optionalIntegrations,
      features,
      capabilities: capabilities.map((capability) => ({
        key: capability.key,
        label: capability.label,
        granted: capability.granted,
      })),
      operations,
      settings: {
        version: settingsView.version,
        enabled: settingsView.settings.enabled === true,
        updatedAt: settingsView.updatedAt,
        updatedBy: settingsView.updatedBy,
        warnings: settingsView.warnings,
      },
      checks,
    };
  }

  /** The indexes 19-LS.2 created, read back from `pg_indexes`. */
  private async readIndexNames(): Promise<Set<string>> {
    const rows = await sql<{ indexname: string }>`
      select indexname from pg_indexes
      where schemaname = current_schema() and indexname in (${sql.join([...LEADSCORE_SCHEMA_INDEXES])})
    `.execute(this.database.db);
    return new Set(rows.rows.map((row) => row.indexname));
  }

  /** The tables and columns this module builds on, read from `information_schema` rather than asserted. */
  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string> }> {
    const wantedTables = new Set<string>();
    for (const capability of REQUIRED_CAPABILITIES) {
      for (const item of capability.evidence) {
        if (item.kind === 'table') wantedTables.add(item.value);
        if (item.kind === 'column') {
          const table = item.value.split('.')[0];
          if (table !== undefined && table !== '') wantedTables.add(table);
        }
      }
    }
    const tables = new Set<string>();
    const columns = new Set<string>();
    if (wantedTables.size === 0) return { tables, columns };
    const rows = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = current_schema() and table_name in (${sql.join([...wantedTables])})
    `.execute(this.database.db);
    for (const row of rows.rows) {
      tables.add(row.table_name);
      columns.add(`${row.table_name}.${row.column_name}`);
    }
    return { tables, columns };
  }
}

function presentEvidence(item: PlatformEvidence, entities: Set<string>, schema: { tables: Set<string>; columns: Set<string> }, phases: Set<string>): boolean {
  switch (item.kind) {
    case 'entity':
      return entities.has(item.value);
    case 'table':
      return schema.tables.has(item.value);
    case 'column':
      return schema.columns.has(item.value);
    case 'hookPhase':
      return phases.has(item.value);
    default: {
      const exhaustive: never = item.kind;
      throw new Error(`Unsupported capability evidence kind "${String(exhaustive)}".`);
    }
  }
}

/** One source of truth for the feature table: the same list the settings document and the gate read. */
function featureList(view: LeadScoreSettingsView): HealthFeature[] {
  return LEADSCORE_FEATURES.map((feature: LeadScoreFeatureDescriptor) => ({
    key: feature.key,
    label: feature.label,
    settingsPath: feature.settingsPath,
    requires: feature.requires,
    enabled: featureFlag(view.settings, feature.key) === true,
    implemented: feature.pendingPhase === null,
    effective: view.effective[feature.key] === true,
    pendingPhase: feature.pendingPhase,
  }));
}

function featureFlag(settings: LeadScoreSettings, key: string): boolean | undefined {
  return settings.features[key as keyof LeadScoreSettings['features']];
}

function refusalReason(view: LeadScoreSettingsView, features: readonly HealthFeature[], ready: boolean): string {
  if (ready) return 'at least one operation is admitted for this caller';
  if (view.settings.enabled !== true) return 'the leadScore module switch is off';
  const pending = features.filter((feature) => !feature.implemented);
  if (pending.length > 0) {
    return `${pending.length} feature switch${pending.length === 1 ? '' : 'es'} name${pending.length === 1 ? 's' : ''} a sub-phase that has not shipped (earliest ${pending[0]?.pendingPhase})`;
  }
  return 'no feature is both enabled and effective';
}

/** The Lead lifecycle this module will reuse, not replace: `Converted` and `Dead` are core values (D1). */
function coreLeadLifecycleIntact(entities: Set<string>, leadFields: FieldMap): HealthCheck {
  const statusField = leadFields['status'];
  const values = ((statusField?.values ?? statusField?.enum ?? [])) as readonly string[];
  const ok = entities.has('Lead') && values.includes(LEAD_CONVERTED_STATUS) && values.includes(LEAD_DEAD_STATUS);
  return {
    name: 'core-lead-lifecycle',
    ok,
    detail: entities.has('Lead')
      ? `Lead status values: ${values.join(', ') || '(none)'}`
      : 'the core Lead entity is missing from the metadata registry',
  };
}

/**
 * The projection and the conversion references must exist on `Lead` *and* must not be editable through
 * the record API. `inEdit` keeps them out of every generated form; the write guard is what refuses a
 * direct API call, and the next check verifies that guard is actually registered.
 */
function ownedLeadFieldsRegistered(entities: Set<string>, leadFields: FieldMap): HealthCheck {
  const missing = LEADSCORE_OWNED_LEAD_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(leadFields, field));
  const editable = LEADSCORE_OWNED_LEAD_FIELDS.filter((field) => leadFields[field]?.inEdit === true);
  return {
    name: 'lead-score-fields',
    ok: entities.has('Lead') && missing.length === 0 && editable.length === 0,
    detail:
      missing.length > 0
        ? `missing on Lead: ${missing.join(', ')}`
        : editable.length > 0
          ? `server-owned fields are marked editable: ${editable.join(', ')}`
          : `${LEADSCORE_OWNED_LEAD_FIELDS.length} Lead Score attributes registered on Lead, none editable through the record API`,
  };
}

/** Registering the module must not have taken a core Lead field away or made it un-writable. */
function coreLeadFieldsStillEditable(leadFields: FieldMap): HealthCheck {
  const expectedEditable = ['name', 'firstName', 'lastName', 'title', 'emailAddress', 'phoneNumber', 'company', 'industry', 'source', 'status', 'description'];
  const lost = expectedEditable.filter((field) => leadFields[field]?.inEdit !== true);
  return {
    name: 'lead-core-fields',
    ok: lost.length === 0,
    detail: lost.length === 0 ? `${expectedEditable.length} ordinary Lead fields still editable` : `no longer editable: ${lost.join(', ')}`,
  };
}

/**
 * The four records Lead Score owns must be registered metadata entities, and nothing else may be
 * claimed as owned. This is the check 19-LS.1 pinned to the empty set; it now asserts the registration,
 * so a seed that did not run reports a failure instead of an unchecked promise.
 */
function entityRegistration(entities: Set<string>): HealthCheck {
  const owned = new Set<string>(LEADSCORE_MODULE.entityTypes);
  const registered = LEADSCORE_ENTITY_TYPES.filter((entity) => entities.has(entity));
  const unexpected = registered.filter((entity) => !owned.has(entity));
  const missing = [...owned].filter((entity) => !entities.has(entity));
  return {
    name: 'entity-registration',
    ok: unexpected.length === 0 && missing.length === 0 && registered.length === owned.size,
    detail:
      missing.length > 0
        ? `not registered in the metadata store: ${missing.join(', ')}`
        : `${[...owned].join(', ')} registered, extending ${LEADSCORE_CORE_ENTITY_TYPES.join('/')} without owning them`,
  };
}

/** The DDL behind the entities, read back rather than assumed. */
function schemaStructures(indexes: Set<string>): HealthCheck {
  const missing = LEADSCORE_SCHEMA_INDEXES.filter((name) => !indexes.has(name));
  return {
    name: 'schema-indexes',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${LEADSCORE_SCHEMA_INDEXES.length} indexes from 073_phase19_lead_score.sql present, including the operation-key and reason-code uniques`
        : `missing: ${missing.join(', ')}`,
  };
}

function writeGuardRegistered(hookNames: Set<string>): HealthCheck {
  const missing = LEADSCORE_GUARD_HOOKS.filter((name) => !hookNames.has(name));
  return {
    name: 'write-guard',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${LEADSCORE_GUARD_HOOKS.length} guards registered on the phases every write passes through`
        : `not registered: ${missing.join(', ')}`,
  };
}

function platformFoundation(dependencies: readonly HealthDependency[]): HealthCheck {
  const missing = dependencies.filter((dependency) => !dependency.present);
  return {
    name: 'platform-foundation',
    ok: missing.length === 0,
    detail: missing.length === 0 ? `${dependencies.length} required capabilities verified` : `missing: ${missing.map((entry) => entry.id).join(', ')}`,
  };
}
