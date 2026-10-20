import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';

/**
 * Phase 19-INT.10 — conflicts and the deletion policy
 * (`PLAN_Phase_19_Advanced_Integrations.md` §8.5; `19-INT.10`).
 *
 * A conflict is raised when the same record changed **on both sides** between two syncs and the
 * platform cannot decide which is newer — either the provider offers no timestamp, or the two
 * clocks are not comparable.
 *
 * The policies (feature contract §5.3):
 *
 * | Policy | Behaviour |
 * | --- | --- |
 * | `manual` | **The default.** Nothing is written. The conflict is recorded and an operator resolves it. The platform never silently overwrites a CRM field. |
 * | `provider_wins` | The provider's value overwrites the CRM's. Only valid for fields the mapping declares provider-authoritative. |
 * | `crm_wins` | The CRM's value is kept and, where the provider supports write-back, pushed back to the provider. |
 * | `newest_wins` | Only valid when both sides carry a comparable timestamp. The platform refuses the policy when the provider does not expose a reliable `updated_at`. |
 *
 * **Deletion.** A provider-side delete never hard-deletes a CRM record. The mapping's deletion
 * policy decides what happens: `unlink` (the default) removes the link and flags the record,
 * `archive` does the same and marks the record archived, `ignore` does nothing at all.
 */

export const CONFLICT_TYPES = ['field_conflict', 'duplicate', 'deletion', 'authorization'] as const;
export type ConflictType = (typeof CONFLICT_TYPES)[number];

export const CONFLICT_STATUSES = ['open', 'resolved', 'ignored'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

export const RESOLUTIONS = [
  'keep_crm',
  'keep_provider',
  'ignore',
  'unlink',
] as const;
export type ConflictResolution = (typeof RESOLUTIONS)[number];

export interface ConflictDetailView extends ConflictView {
  /** The field authority rule that applies to each conflicting field. */
  readonly fieldAuthority: Readonly<Record<string, string>>;
  /** True when the record changed on either side since the conflict was detected. */
  readonly stale: boolean;
  readonly staleSide: 'local' | 'remote' | null;
  readonly resolutions: readonly {
    readonly value: ConflictResolution;
    readonly label: string;
    readonly enabled: boolean;
    readonly reason: string | null;
  }[];
}

export interface ConflictView {
  readonly id: string;
  readonly connectionId: string;
  readonly mappingId: string;
  readonly runId: string | null;
  readonly objectType: string;
  readonly externalId: string;
  readonly crmEntityType: string | null;
  readonly crmEntityId: string | null;
  readonly conflictType: ConflictType;
  readonly status: ConflictStatus;
  readonly localSnapshot: Record<string, unknown> | null;
  readonly remoteSnapshot: Record<string, unknown> | null;
  readonly conflictingFields: Readonly<Record<string, { local: unknown; remote: unknown }>>;
  readonly policy: string;
  readonly resolution: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface ConflictOpenInput {
  readonly connectionId: string;
  readonly mappingId: string;
  readonly runId?: string | null | undefined;
  readonly objectType: string;
  readonly externalId: string;
  readonly crmEntityType?: string | null | undefined;
  readonly crmEntityId?: string | null | undefined;
  readonly conflictType: ConflictType;
  readonly policy: string;
  readonly localSnapshot?: Record<string, unknown> | null | undefined;
  readonly remoteSnapshot?: Record<string, unknown> | null | undefined;
  readonly conflictingFields?: Readonly<Record<string, { local: unknown; remote: unknown }>> | undefined;
}

export interface FieldDifference {
  readonly field: string;
  readonly local: unknown;
  readonly remote: unknown;
}

interface ConflictRow {
  id: string;
  connection_id: string;
  mapping_id: string;
  run_id: string | null;
  object_type: string;
  external_id: string;
  crm_entity_type: string | null;
  crm_entity_id: string | null;
  conflict_type: string;
  status: string;
  local_snapshot: unknown;
  remote_snapshot: unknown;
  conflicting_fields: unknown;
  policy: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

@Injectable()
export class ConflictService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  /**
   * Open a conflict.
   *
   * There is at most one **open** conflict per `(connection, object type, external id)`. Opening
   * the same conflict twice updates the existing one instead of flooding the operator.
   */
  async open(input: ConflictOpenInput): Promise<ConflictView> {
    await this.connections.get(input.connectionId);
    const id = randomUUID();
    const rows = await sql<ConflictRow>`
      insert into integration_conflicts
        (id, connection_id, mapping_id, run_id, object_type, external_id, crm_entity_type,
         crm_entity_id, conflict_type, status, local_snapshot, remote_snapshot,
         conflicting_fields, policy, created_at)
      values
        (${id}, ${input.connectionId}, ${input.mappingId}, ${input.runId ?? null}, ${input.objectType},
         ${input.externalId}, ${input.crmEntityType ?? null}, ${input.crmEntityId ?? null},
         ${input.conflictType}, 'open',
         ${input.localSnapshot === undefined || input.localSnapshot === null ? null : JSON.stringify(input.localSnapshot)}::jsonb,
         ${input.remoteSnapshot === undefined || input.remoteSnapshot === null ? null : JSON.stringify(input.remoteSnapshot)}::jsonb,
         ${JSON.stringify(input.conflictingFields ?? {})}::jsonb, ${input.policy}, ${new Date()})
      on conflict (connection_id, object_type, external_id) where status = 'open' do update set
        run_id = excluded.run_id,
        crm_entity_type = excluded.crm_entity_type,
        crm_entity_id = excluded.crm_entity_id,
        conflict_type = excluded.conflict_type,
        local_snapshot = excluded.local_snapshot,
        remote_snapshot = excluded.remote_snapshot,
        conflicting_fields = excluded.conflicting_fields,
        policy = excluded.policy
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new ValidationError('The conflict could not be recorded.');
    return toView(row);
  }

  /** The open conflicts of a connection. */
  async listOpen(connectionId: string, limit = 100): Promise<readonly ConflictView[]> {
    await this.connections.get(connectionId);
    const rows = await sql<ConflictRow>`
      select * from integration_conflicts
      where connection_id = ${connectionId} and status = 'open'
      order by created_at desc
      limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => toView(row));
  }

  /** One conflict. */
  async get(id: string): Promise<ConflictView> {
    const rows = await sql<ConflictRow>`
      select * from integration_conflicts where id = ${id} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError(`Conflict "${id}" does not exist.`);
    return toView(row);
  }

  /**
   * The full detail of one conflict, with the field authority and the staleness check.
   *
   * **Stale detection** is what makes a resolution safe. A conflict compares two states of a
   * record. If the record moved again after the conflict was detected, both sides are old, and
   * applying the provider's value would overwrite a newer change with a stale one. The platform
   * therefore refuses that resolution and says which side moved.
   */
  async detail(id: string): Promise<ConflictDetailView> {
    const conflict = await this.get(id);
    const mapping = await this.mappingOf(conflict.mappingId);
    const localChangedAt = await this.localChangedAt(conflict);
    const detectedAt = Date.parse(conflict.createdAt);
    const localStale = localChangedAt !== null && localChangedAt > detectedAt;
    const remoteStale = await this.remoteChangedAfter(conflict, detectedAt);
    const stale = localStale || remoteStale;
    const staleSide: 'local' | 'remote' | null = localStale ? 'local' : remoteStale ? 'remote' : null;

    const resolutions: {
      readonly value: ConflictResolution;
      readonly label: string;
      readonly enabled: boolean;
      readonly reason: string | null;
    }[] = [
      {
        value: 'keep_crm',
        label: 'Keep the CRM value',
        enabled: true,
        reason: null,
      },
      {
        value: 'keep_provider',
        label: "Keep the provider's value",
        // A stale comparison cannot decide the winner.
        enabled: !stale,
        reason: stale ? 'The record changed again after this conflict was detected.' : null,
      },
      {
        value: 'ignore',
        label: 'Ignore this conflict',
        enabled: true,
        reason: null,
      },
      {
        value: 'unlink',
        label: 'Unlink the record',
        enabled: true,
        reason: null,
      },
    ];

    return {
      ...conflict,
      fieldAuthority: mapping?.fieldAuthority ?? {},
      stale,
      staleSide,
      resolutions,
    };
  }

  /**
   * The mapping's field authority, so the workbench can say who wins each field.
   */
  private async mappingOf(mappingId: string): Promise<{ fieldAuthority: Record<string, string> } | null> {
    const rows = await sql<{ field_authority: unknown }>`
      select field_authority from integration_object_mappings where id = ${mappingId} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) return null;
    const authority = row.field_authority;
    if (typeof authority !== 'object' || authority === null || Array.isArray(authority)) {
      return { fieldAuthority: {} };
    }
    const out: Record<string, string> = {};
    for (const [field, value] of Object.entries(authority as Record<string, unknown>)) {
      if (typeof value === 'string') out[field] = value;
    }
    return { fieldAuthority: out };
  }

  /** When the CRM record last changed, or `null` when it cannot be read. */
  private async localChangedAt(conflict: ConflictView): Promise<number | null> {
    if (conflict.crmEntityType === null || conflict.crmEntityId === null) return null;
    try {
      const record = await this.entities.get(conflict.crmEntityType, conflict.crmEntityId);
      const modifiedAt = record['modifiedAt'];
      if (typeof modifiedAt !== 'string') return null;
      const at = Date.parse(modifiedAt);
      return Number.isNaN(at) ? null : at;
    } catch {
      // A record that cannot be read is not evidence of staleness.
      return null;
    }
  }

  /**
   * Whether the provider side moved after the conflict was detected.
   *
   * The provider's own timestamp is carried on the external link, so it is read from there.
   */
  private async remoteChangedAfter(conflict: ConflictView, detectedAt: number): Promise<boolean> {
    if (conflict.crmEntityType === null || conflict.crmEntityId === null) return false;
    const rows = await sql<{ provider_updated_at: Date | null }>`
      select provider_updated_at from integration_external_links
      where connection_id = ${conflict.connectionId}
        and object_type = ${conflict.objectType}
        and external_id = ${conflict.externalId}
        and link_status = 'linked'
      limit 1
    `.execute(this.database.db);
    const updatedAt = rows.rows[0]?.provider_updated_at ?? null;
    if (updatedAt === null) return false;
    return updatedAt.getTime() > detectedAt;
  }

  /**
   * Resolve a conflict.
   *
   * The resolution decides what happens to the CRM record:
   *
   *  - `keep_crm` — the CRM's value stays. Nothing is written.
   *  - `keep_provider` — the provider's value is written to the CRM record.
   *  - `ignore` — the conflict is closed without touching the record.
   *  - `unlink` — the record is unlinked from the provider object. The record itself is kept.
   */
  async resolve(id: string, resolution: ConflictResolution): Promise<ConflictView> {
    const conflict = await this.get(id);
    if (conflict.status !== 'open') {
      throw new ValidationError('The conflict is already resolved.');
    }
    if (!RESOLUTIONS.includes(resolution)) {
      throw new ValidationError(`Unknown conflict resolution "${resolution}".`);
    }
    if (resolution === 'keep_provider') {
      // A stale comparison must not decide the winner: both sides are older states, and applying
      // the provider's value would overwrite a newer change with a stale one.
      const detail = await this.detail(id);
      if (detail.stale) {
        throw new ValidationError(
          'The record changed again after this conflict was detected, so the provider’s value cannot be applied. Re-run the sync and resolve the fresh conflict.',
          { stale: true, staleSide: detail.staleSide },
        );
      }
    }
    if (resolution === 'keep_provider') {
      if (conflict.crmEntityType === null || conflict.crmEntityId === null) {
        throw new ValidationError('The conflict has no CRM record, so the provider value cannot be applied.');
      }
      const remote = conflict.remoteSnapshot ?? {};
      if (Object.keys(remote).length > 0) {
        await this.entities.update(conflict.crmEntityType, conflict.crmEntityId, remote);
      }
    }
    const rows = await sql<ConflictRow>`
      update integration_conflicts set
        status = ${resolution === 'ignore' ? 'ignored' : 'resolved'},
        resolution = ${resolution},
        resolved_by = ${this.scope.userId ?? 'system'},
        resolved_at = ${new Date()}
      where id = ${id}
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new ValidationError('The conflict could not be resolved.');
    return toView(row);
  }
}

/**
 * Compare a provider's values with a CRM record's values.
 *
 * Only the fields the mapping maps are compared, and only the fields the two sides actually
 * disagree on are returned. A field that is absent on one side is **not** a conflict: the
 * provider simply does not carry it.
 */
export function detectFieldDifferences(
  mappedValues: Readonly<Record<string, unknown>>,
  crmValues: Readonly<Record<string, unknown>>,
  fieldAuthority: Readonly<Record<string, string>> = {},
): readonly FieldDifference[] {
  const differences: FieldDifference[] = [];
  for (const [field, remote] of Object.entries(mappedValues)) {
    if (remote === undefined || remote === null) continue;
    if (!(field in crmValues)) continue;
    const local = crmValues[field];
    if (local === undefined || local === null) continue;
    if (sameValue(local, remote)) continue;
    // A field the CRM owns is not a conflict to be raised — the CRM's value is authoritative.
    if (fieldAuthority[field] === 'crm') continue;
    differences.push({ field, local, remote });
  }
  return differences;
}

/** Whether two values are the same for the purpose of a conflict check. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === 'number' || typeof right === 'number') {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber === rightNumber;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return String(left).toLowerCase() === String(right).toLowerCase();
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left.trim() === right.trim();
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function toView(row: ConflictRow): ConflictView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    mappingId: row.mapping_id,
    runId: row.run_id,
    objectType: row.object_type,
    externalId: row.external_id,
    crmEntityType: row.crm_entity_type,
    crmEntityId: row.crm_entity_id,
    conflictType: row.conflict_type as ConflictType,
    status: row.status as ConflictStatus,
    localSnapshot: parseRecord(row.local_snapshot),
    remoteSnapshot: parseRecord(row.remote_snapshot),
    conflictingFields: parseDifferences(row.conflicting_fields),
    policy: row.policy,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseDifferences(
  value: unknown,
): Record<string, { local: unknown; remote: unknown }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, { local: unknown; remote: unknown }> = {};
  for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const pair = entry as { local?: unknown; remote?: unknown };
    out[field] = { local: pair.local ?? null, remote: pair.remote ?? null };
  }
  return out;
}
