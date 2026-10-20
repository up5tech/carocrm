import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';
import { ConnectorExecutor } from './connector-executor.service.js';
import { IntegrationAuditService } from './integration-audit.service.js';
import { crmFieldsOf, type CrmFieldView, isLossyConversion } from './integration-fields.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { isProtectedField, protectedTargetsAmong } from './protected-fields.js';
import {
  type CompiledFieldMapping,
  compileFieldMappings,
  type FieldMappingInput,
  type TransformSpec,
  validateTransformSpec,
} from './transformation-compiler.js';

/**
 * Phase 19-INT.8 — the object and field mapping service
 * (`PLAN_Phase_19_Advanced_Integrations.md` §9; `19-INT.8`).
 *
 * A mapping says which provider object feeds which CRM entity, and how each provider field reaches
 * each CRM field. Two rules shape it:
 *
 *  1. **The transformation set is allowlisted.** A mapping may name one of the transformations in
 *     `transformation-compiler.ts` and nothing else. An expression, a script or a template is
 *     refused — a mapping is configuration, not code.
 *  2. **A mapping is versioned and published.** There is at most one *active* mapping per
 *     `(connection, object type)`. Editing an active mapping bumps its version; a run records the
 *     version it used, so a mapping change mid-run is visible afterwards instead of silently
 *     changing what a run did.
 *
 * The preview (`dryRun`) applies a mapping to a sample provider object **without writing anything**,
 * so an operator can see exactly what a sync would do before it does it.
 */

export const MAPPING_DIRECTIONS = ['inbound', 'outbound', 'bidirectional'] as const;
export type MappingDirection = (typeof MAPPING_DIRECTIONS)[number];

export const MAPPING_STATUSES = ['draft', 'active', 'retired'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export const SYNC_MODES = ['full', 'incremental'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const CONFLICT_POLICIES = ['provider_wins', 'crm_wins', 'manual', 'newest_wins'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export const DELETION_POLICIES = ['unlink', 'archive', 'ignore'] as const;
export type DeletionPolicy = (typeof DELETION_POLICIES)[number];

export interface FieldMappingView {
  readonly id: string;
  readonly sourcePath: string;
  readonly targetField: string;
  readonly transform: TransformSpec | null;
  readonly required: boolean;
  /**
   * Whether this mapping may write a **protected** CRM field.
   *
   * A protected field decides who may act on a record or what the record means financially or
   * for consent. The flag is the "explicit reviewed mapping" of plan §14.2, and it is per field.
   */
  readonly allowProtected: boolean;
  readonly direction: MappingDirection;
  readonly position: number;
}

export interface ObjectMappingView {
  readonly id: string;
  readonly connectionId: string;
  readonly providerKey: string;
  readonly objectType: string;
  readonly crmEntityType: string;
  readonly direction: MappingDirection;
  readonly mappingVersion: number;
  readonly status: MappingStatus;
  readonly syncMode: SyncMode;
  readonly conflictPolicy: ConflictPolicy;
  readonly deletionPolicy: DeletionPolicy;
  readonly fieldAuthority: Readonly<Record<string, string>>;
  readonly fields: readonly FieldMappingView[];
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/**
 * One field of a mapping.
 *
 * It extends the compiler's input with the **direction** the field participates in, because the
 * same field may be written *from* the provider (inbound) and *to* the provider (outbound), and
 * the outbound path selects its fields by that flag.
 */
export interface MappingFieldInput extends FieldMappingInput {
  readonly direction?: MappingDirection;
  /** Whether this mapping may write a protected CRM field. The reviewed-mapping escape hatch. */
  readonly allowProtected?: boolean | undefined;
}

export interface ProviderFieldView {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly unique: boolean;
  readonly identifier: boolean;
  readonly sensitive: boolean;
}

export interface MappingWarning {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface MappingFieldsView {
  readonly mappingId: string;
  readonly mappingVersion: number;
  readonly crmEntityType: string;
  readonly objectType: string;
  readonly direction: string;
  readonly providerFields: readonly ProviderFieldView[];
  readonly crmFields: readonly CrmFieldView[];
  readonly fields: readonly FieldMappingView[];
  readonly warnings: readonly MappingWarning[];
}

export interface ObjectMappingCreateInput {
  readonly connectionId: string;
  readonly objectType: string;
  readonly crmEntityType: string;
  readonly direction?: MappingDirection;
  readonly syncMode?: SyncMode;
  readonly conflictPolicy?: ConflictPolicy;
  readonly deletionPolicy?: DeletionPolicy;
  readonly fieldAuthority?: Readonly<Record<string, string>>;
  readonly fields?: readonly MappingFieldInput[];
}

export interface PreviewResult {
  readonly mappingId: string;
  readonly mappingVersion: number;
  /** The values the mapping would write, keyed by CRM field. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The CRM fields a required source path did not produce. */
  readonly missingRequired: readonly string[];
  /** The source paths that produced nothing. */
  readonly emptySources: readonly string[];
  /** Nothing was written. */
  readonly dryRun: true;
}

interface MappingRow {
  id: string;
  connection_id: string;
  provider_key: string;
  object_type: string;
  crm_entity_type: string;
  direction: string;
  mapping_version: number;
  status: string;
  sync_mode: string;
  conflict_policy: string;
  deletion_policy: string;
  field_authority: unknown;
  created_at: Date;
  modified_at: Date;
}

interface FieldRow {
  id: string;
  mapping_id: string;
  source_path: string;
  target_field: string;
  transform: unknown;
  required: boolean;
  /** Whether the mapping was reviewed to allow writing a protected CRM field. */
  allow_protected: boolean;
  direction: string;
  position: number;
}

@Injectable()
export class MappingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(IntegrationAuditService) private readonly audit: IntegrationAuditService,
    @Inject(ConnectorExecutor) private readonly executor: ConnectorExecutor,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  /** Every mapping of a connection. */
  async list(connectionId: string): Promise<readonly ObjectMappingView[]> {
    await this.connections.get(connectionId);
    const rows = await sql<MappingRow>`
      select * from integration_object_mappings
      where connection_id = ${connectionId}
      order by object_type asc
    `.execute(this.database.db);
    const views: ObjectMappingView[] = [];
    for (const row of rows.rows) {
      views.push(await this.toView(row));
    }
    return views;
  }

  /** One mapping, with its fields. */
  async get(mappingId: string): Promise<ObjectMappingView> {
    const row = await this.requireRow(mappingId);
    await this.connections.get(row.connection_id);
    return this.toView(row);
  }

  /** The **active** mapping for a provider object type, or `null`. */
  async findActive(connectionId: string, objectType: string): Promise<ObjectMappingView | null> {
    await this.connections.get(connectionId);
    const rows = await sql<MappingRow>`
      select * from integration_object_mappings
      where connection_id = ${connectionId} and object_type = ${objectType} and status = 'active'
      limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    return row ? this.toView(row) : null;
  }

  /** Every **active** mapping in the installation. */
  async listAllActive(): Promise<readonly ObjectMappingView[]> {
    const rows = await sql<MappingRow>`
      select * from integration_object_mappings where status = 'active' order by connection_id asc
    `.execute(this.database.db);
    const views: ObjectMappingView[] = [];
    for (const row of rows.rows) {
      views.push(await this.toView(row));
    }
    return views;
  }

  /**
   * The **active** mappings that write a CRM entity back to a provider.
   *
   * The outbound path needs exactly this set — a CRM record changed, and every mapping that
   * writes it back must see the change. The filter is in the query, not in memory: the outbound
   * path runs on every domain event, so loading the whole catalog would be wasteful.
   */
  async listActiveForEntity(entityType: string): Promise<readonly ObjectMappingView[]> {
    const rows = await sql<MappingRow>`
      select * from integration_object_mappings
      where status = 'active'
        and crm_entity_type = ${entityType}
        and direction in ('outbound', 'bidirectional')
      order by connection_id asc
    `.execute(this.database.db);
    const views: ObjectMappingView[] = [];
    for (const row of rows.rows) {
      views.push(await this.toView(row));
    }
    return views;
  }

  /**
   * Create a mapping in the `draft` state.
   *
   * The provider object type must be one the connector actually declares, and the connector must
   * be able to read it — a mapping for an object the connector does not offer would fail at the
   * first sync instead of at configuration time.
   */
  async create(input: ObjectMappingCreateInput): Promise<ObjectMappingView> {
    const connection = await this.connections.get(input.connectionId);
    const provider = this.registry.require(connection.providerKey);
    const object = provider.capabilities.objects.find((entry) => entry.objectType === input.objectType);
    if (!object) {
      throw new ValidationError(
        `Provider "${connection.providerKey}" does not offer the object "${input.objectType}".`,
        { providerKey: connection.providerKey, objectType: input.objectType },
      );
    }
    if (!object.read) {
      throw new ValidationError(
        `The object "${input.objectType}" cannot be read, so it cannot be mapped.`,
        { objectType: input.objectType },
      );
    }
    if (input.crmEntityType.trim() === '') {
      throw new ValidationError('A mapping needs a CRM entity type.');
    }
    const fields = input.fields ?? [];
    // The field mappings are compiled now, so an invalid transformation is refused at
    // configuration time rather than at the first sync.
    compileFieldMappings(fields);

    const now = new Date();
    const id = randomUUID();
    await sql`
      insert into integration_object_mappings
        (id, connection_id, provider_key, object_type, crm_entity_type, direction, mapping_version,
         status, sync_mode, conflict_policy, deletion_policy, field_authority,
         created_at, modified_at, created_by_id, modified_by_id)
      values
        (${id}, ${input.connectionId}, ${connection.providerKey}, ${input.objectType},
         ${input.crmEntityType}, ${input.direction ?? 'inbound'}, 1, 'draft',
         ${input.syncMode ?? 'incremental'}, ${input.conflictPolicy ?? 'manual'},
         ${input.deletionPolicy ?? 'unlink'},
         ${JSON.stringify(input.fieldAuthority ?? {})}::jsonb, ${now}, ${now}, null, null)
    `.execute(this.database.db);
    await this.replaceFields(id, fields);
    await this.audit.record({
      action: 'mapping.created',
      connectionId: input.connectionId,
      entityType: 'IntegrationObjectMapping',
      entityId: id,
      detail: { objectType: input.objectType, crmEntityType: input.crmEntityType },
    });
    return this.get(id);
  }

  /**
   * Update a mapping's fields and options.
   *
   * The version is bumped: a run that used version *n* and a run that used version *n+1* are
   * distinguishable afterwards.
   */
  async update(
    mappingId: string,
    patch: {
      readonly crmEntityType?: string | undefined;
      readonly direction?: MappingDirection | undefined;
      readonly syncMode?: SyncMode | undefined;
      readonly conflictPolicy?: ConflictPolicy | undefined;
      readonly deletionPolicy?: DeletionPolicy | undefined;
      readonly fieldAuthority?: Readonly<Record<string, string>> | undefined;
      readonly fields?: readonly MappingFieldInput[] | undefined;
    },
  ): Promise<ObjectMappingView> {
    const row = await this.requireRow(mappingId);
    await this.connections.get(row.connection_id);
    if (patch.fields !== undefined) {
      compileFieldMappings(patch.fields);
      await this.replaceFields(mappingId, patch.fields);
    }
    const now = new Date();
    await sql`
      update integration_object_mappings set
        crm_entity_type = ${patch.crmEntityType ?? row.crm_entity_type},
        direction = ${patch.direction ?? row.direction},
        sync_mode = ${patch.syncMode ?? row.sync_mode},
        conflict_policy = ${patch.conflictPolicy ?? row.conflict_policy},
        deletion_policy = ${patch.deletionPolicy ?? row.deletion_policy},
        field_authority = ${patch.fieldAuthority === undefined ? row.field_authority : JSON.stringify(patch.fieldAuthority)}::jsonb,
        mapping_version = mapping_version + 1,
        modified_at = ${now}
      where id = ${mappingId}
    `.execute(this.database.db);
    return this.get(mappingId);
  }

  /**
   * Activate a mapping.
   *
   * Only one mapping per `(connection, object type)` may be active, so activating one **retires**
   * the previous one rather than leaving two active mappings that would both write.
   */
  async activate(mappingId: string): Promise<ObjectMappingView> {
    const row = await this.requireRow(mappingId);
    await this.connections.get(row.connection_id);
    // A mapping that writes a protected CRM field without a recorded review never goes live.
    // The review is the `allowProtected` flag on the field; without it the payload would be able
    // to assign an owner, a team or a payment state (plan §14.2).
    const unreviewed = await this.unreviewedProtectedTargets(mappingId);
    if (unreviewed.length > 0) {
      throw new ValidationError(
        `The mapping writes protected field${unreviewed.length === 1 ? '' : 's'} that were not reviewed: ${unreviewed.join(', ')}. Mark them as reviewed before activating the mapping.`,
        { protectedFields: [...unreviewed] },
      );
    }
    const now = new Date();
    await sql`
      update integration_object_mappings
      set status = 'retired', modified_at = ${now}
      where connection_id = ${row.connection_id} and object_type = ${row.object_type}
        and status = 'active' and id <> ${mappingId}
    `.execute(this.database.db);
    await sql`
      update integration_object_mappings set status = 'active', modified_at = ${now} where id = ${mappingId}
    `.execute(this.database.db);
    await this.audit.record({
      action: 'mapping.published',
      connectionId: row.connection_id,
      entityType: 'IntegrationObjectMapping',
      entityId: mappingId,
      detail: { objectType: row.object_type, crmEntityType: row.crm_entity_type },
    });
    return this.get(mappingId);
  }

  /** Retire a mapping. Its history stays; it simply stops being used. */
  async retire(mappingId: string): Promise<ObjectMappingView> {
    const row = await this.requireRow(mappingId);
    const now = new Date();
    await sql`
      update integration_object_mappings set status = 'retired', modified_at = ${now} where id = ${mappingId}
    `.execute(this.database.db);
    await this.audit.record({
      action: 'mapping.retired',
      connectionId: row.connection_id,
      entityType: 'IntegrationObjectMapping',
      entityId: mappingId,
    });
    return this.get(mappingId);
  }

  /**
   * The protected fields a mapping targets without a recorded review.
   *
   * A mapping that names one of them is a mapping that would let an imported payload decide who
   * owns a record or what it means financially. The review is the field's own flag, so this is a
   * per-field question and not a global one.
   */
  private async unreviewedProtectedTargets(mappingId: string): Promise<readonly string[]> {
    const rows = await sql<{ target_field: string }>`
      select target_field from integration_field_mappings
      where mapping_id = ${mappingId} and allow_protected = false
    `.execute(this.database.db);
    return protectedTargetsAmong(rows.rows.map((row) => row.target_field));
  }

  /**
   * Apply a mapping to a sample provider object **without writing anything**.
   *
   * This is the dry run an operator uses before enabling a mapping: it shows exactly which CRM
   * fields would be written, and which required fields the provider object does not carry.
   */
  async preview(mappingId: string, sample: Readonly<Record<string, unknown>>): Promise<PreviewResult> {
    const mapping = await this.get(mappingId);
    const compiled = compileFieldMappings(
      mapping.fields.map((field) => ({
        sourcePath: field.sourcePath,
        targetField: field.targetField,
        transform: field.transform,
        required: field.required,
        allowProtected: field.allowProtected,
      })),
    );
    const preview = buildPreview(mapping, compiled, sample);
    await this.audit.record({
      action: 'mapping.previewed',
      connectionId: mapping.connectionId,
      entityType: 'IntegrationObjectMapping',
      entityId: mapping.id,
      detail: { missingRequired: preview.missingRequired.length, emptySources: preview.emptySources.length },
    });
    return preview;
  }

  /** The compiled field mappings of a mapping. */
  async compile(mappingId: string): Promise<readonly CompiledFieldMapping[]> {
    const mapping = await this.get(mappingId);
    return compileFieldMappings(
      mapping.fields.map((field) => ({
        sourcePath: field.sourcePath,
        targetField: field.targetField,
        transform: field.transform,
        required: field.required,
        allowProtected: field.allowProtected,
      })),
    );
  }

  /**
   * The field catalogue of a mapping: the provider's fields, the CRM's fields, and what an
   * operator should look at before publishing.
   *
   * The warnings are the reason this exists. An unmapped required field, a lossy conversion and a
   * sensitive target are all things that should be seen **before** a mapping goes live, not
   * discovered by the first sync.
   */
  async listFields(mappingId: string): Promise<MappingFieldsView> {
    const mapping = await this.get(mappingId);
    const crmFields = crmFieldsOf(this.metadata, mapping.crmEntityType);
    const providerFields = await this.providerFields(mapping);

    const warnings: MappingWarning[] = [];
    const mappedTargets = new Set(mapping.fields.map((field) => field.targetField));
    const crmFieldByName = new Map(crmFields.map((field) => [field.name, field]));
    const providerFieldByName = new Map(providerFields.map((field) => [field.name, field]));

    for (const field of crmFields) {
      if (field.required && !mappedTargets.has(field.name)) {
        warnings.push({
          code: 'REQUIRED_FIELD_UNMAPPED',
          severity: 'error',
          message: `"${field.label}" is required by ${mapping.crmEntityType} and nothing writes to it.`,
        });
      }
    }

    for (const field of mapping.fields) {
      const crmField = crmFieldByName.get(field.targetField);
      if (crmField === undefined) {
        warnings.push({
          code: 'TARGET_FIELD_UNKNOWN',
          severity: 'error',
          message: `"${field.targetField}" is not a field of ${mapping.crmEntityType}. The mapping will fail at run time.`,
        });
        continue;
      }
      if (crmField.sensitive) {
        warnings.push({
          code: 'SENSITIVE_TARGET',
          severity: 'warning',
          message: `"${crmField.label}" holds sensitive data. Check that the provider is allowed to receive it.`,
        });
      }
      const providerField = providerFieldByName.get(field.sourcePath);
      if (providerField !== undefined && isLossyConversion(providerField.type, crmField.type)) {
        warnings.push({
          code: 'LOSSY_CONVERSION',
          severity: 'warning',
          message: `"${field.sourcePath}" is a ${providerField.type} and "${crmField.label}" is a ${crmField.type}. Some values cannot be represented.`,
        });
      }
      if (isProtectedField(field.targetField) && !field.allowProtected) {
        warnings.push({
          code: 'PROTECTED_TARGET',
          severity: 'error',
          message: `"${crmField.label}" is a protected field. An imported payload may not write it unless the mapping records the review, and the mapping cannot be activated until it does.`,
        });
      } else if (isProtectedField(field.targetField)) {
        warnings.push({
          code: 'PROTECTED_TARGET_REVIEWED',
          severity: 'warning',
          message: `"${crmField.label}" is a protected field and this mapping writes it. The review is recorded; the owning domain's rules still apply.`,
        });
      }
    }

    if (providerFields.length === 0) {
      warnings.push({
        code: 'NO_PROVIDER_FIELDS',
        severity: 'info',
        message: 'This connector does not publish its field list, so the mapping cannot be checked field by field.',
      });
    }

    return {
      mappingId: mapping.id,
      mappingVersion: mapping.mappingVersion,
      crmEntityType: mapping.crmEntityType,
      objectType: mapping.objectType,
      direction: mapping.direction,
      providerFields,
      crmFields,
      fields: mapping.fields,
      warnings,
    };
  }

  /**
   * The provider's field list, read through the connector.
   *
   * A connector that does not publish its fields yields an empty list, not an error — the builder
   * must still render.
   */
  private async providerFields(mapping: ObjectMappingView): Promise<readonly ProviderFieldView[]> {
    const connection = await this.connections.get(mapping.connectionId);
    if (connection.status !== 'connected' && connection.status !== 'degraded') return [];
    try {
      return await this.executor.call(mapping.connectionId, async (context, adapter) => {
        if (adapter.listFields === undefined) return [];
        return adapter.listFields(context, mapping.objectType);
      });
    } catch {
      // A connector that cannot be reached simply publishes no fields right now.
      return [];
    }
  }

  private async replaceFields(mappingId: string, fields: readonly MappingFieldInput[]): Promise<void> {
    await sql`delete from integration_field_mappings where mapping_id = ${mappingId}`.execute(this.database.db);
    let position = 0;
    for (const field of fields) {
      const transform = field.transform === null ? null : validateTransformSpec(field.transform);
      await sql`
        insert into integration_field_mappings
          (id, mapping_id, source_path, target_field, transform, required, direction, position,
           allow_protected)
        values
          (${randomUUID()}, ${mappingId}, ${field.sourcePath}, ${field.targetField},
           ${transform === null ? null : JSON.stringify(transform)}::jsonb,
           ${field.required}, ${field.direction ?? 'inbound'}, ${position},
           ${field.allowProtected === true})
      `.execute(this.database.db);
      position += 1;
    }
  }

  private async requireRow(mappingId: string): Promise<MappingRow> {
    const rows = await sql<MappingRow>`
      select * from integration_object_mappings where id = ${mappingId} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError(`Mapping "${mappingId}" does not exist.`);
    return row;
  }

  private async toView(row: MappingRow): Promise<ObjectMappingView> {
    const fieldRows = await sql<FieldRow>`
      select * from integration_field_mappings where mapping_id = ${row.id} order by position asc
    `.execute(this.database.db);
    return {
      id: row.id,
      connectionId: row.connection_id,
      providerKey: row.provider_key,
      objectType: row.object_type,
      crmEntityType: row.crm_entity_type,
      direction: row.direction as MappingDirection,
      mappingVersion: row.mapping_version,
      status: row.status as MappingStatus,
      syncMode: row.sync_mode as SyncMode,
      conflictPolicy: row.conflict_policy as ConflictPolicy,
      deletionPolicy: row.deletion_policy as DeletionPolicy,
      fieldAuthority: parseStringRecord(row.field_authority),
      fields: fieldRows.rows.map((field) => ({
        id: field.id,
        sourcePath: field.source_path,
        targetField: field.target_field,
        transform: field.transform === null ? null : (validateTransformSpec(field.transform) as TransformSpec),
        required: field.required,
        allowProtected: field.allow_protected === true,
        direction: field.direction as MappingDirection,
        position: field.position,
      })),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }
}

/** Build a preview from compiled mappings and a sample. Nothing is written. */
function buildPreview(
  mapping: ObjectMappingView,
  compiled: readonly CompiledFieldMapping[],
  sample: Readonly<Record<string, unknown>>,
): PreviewResult {
  const values: Record<string, unknown> = {};
  const missingRequired: string[] = [];
  const emptySources: string[] = [];
  for (const field of compiled) {
    const value = field.apply(sample);
    if (value === undefined || value === null) {
      emptySources.push(field.targetField);
      if (field.required) missingRequired.push(field.targetField);
      continue;
    }
    values[field.targetField] = value;
  }
  return {
    mappingId: mapping.id,
    mappingVersion: mapping.mappingVersion,
    values,
    missingRequired,
    emptySources,
    dryRun: true,
  };
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}
