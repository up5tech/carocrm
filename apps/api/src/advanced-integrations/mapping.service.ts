import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';
import { IntegrationRegistry } from './integration-registry.service.js';
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
  direction: string;
  position: number;
}

@Injectable()
export class MappingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
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
    return this.get(mappingId);
  }

  /** Retire a mapping. Its history stays; it simply stops being used. */
  async retire(mappingId: string): Promise<ObjectMappingView> {
    await this.requireRow(mappingId);
    const now = new Date();
    await sql`
      update integration_object_mappings set status = 'retired', modified_at = ${now} where id = ${mappingId}
    `.execute(this.database.db);
    return this.get(mappingId);
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
      })),
    );
    return buildPreview(mapping, compiled, sample);
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
      })),
    );
  }

  private async replaceFields(mappingId: string, fields: readonly MappingFieldInput[]): Promise<void> {
    await sql`delete from integration_field_mappings where mapping_id = ${mappingId}`.execute(this.database.db);
    let position = 0;
    for (const field of fields) {
      const transform = field.transform === null ? null : validateTransformSpec(field.transform);
      await sql`
        insert into integration_field_mappings
          (id, mapping_id, source_path, target_field, transform, required, direction, position)
        values
          (${randomUUID()}, ${mappingId}, ${field.sourcePath}, ${field.targetField},
           ${transform === null ? null : JSON.stringify(transform)}::jsonb,
           ${field.required}, ${field.direction ?? 'inbound'}, ${position})
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
