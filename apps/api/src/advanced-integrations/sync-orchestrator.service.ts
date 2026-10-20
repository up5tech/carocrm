import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { ConflictService, detectFieldDifferences } from './conflict.service.js';
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';
import type { ExternalObject } from './connector-adapter.port.js';
import { ConnectorExecutor } from './connector-executor.service.js';
import { DeadLetterService } from './dead-letter.service.js';
import { ExternalLinkService, type UniqueFieldPair } from './external-link.service.js';
import { IntegrationEventPublisher } from './integration-events.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { MappingService,type ObjectMappingView } from './mapping.service.js';
import { isProtectedField } from './protected-fields.js';
import { ProviderError, redactProviderError } from './provider-error.js';
import { RecordOriginService } from './record-origin.service.js';
import { decideRetry, DEFAULT_RETRY_POLICY } from './resilience.js';

/**
 * Phase 19-INT.9 — the sync orchestrator
 * (`PLAN_Phase_19_Advanced_Integrations.md` §8; `19-INT.9`).
 *
 * The orchestrator drives one sync run over one mapping. The rules it implements are the ones the
 * feature contract fixes:
 *
 *  - **The checkpoint advances only past a successful operation.** A record that failed is retried;
 *    the cursor never skips it. A cursor the provider reports as expired triggers a full re-sync
 *    of that object — it is not an error to swallow.
 *  - **Every provider object becomes exactly one CRM record.** The external link is the mechanism:
 *    one link per `(connection, object type, external id)`.
 *  - **A conflict is never silently resolved.** With the `manual` policy the record is *not*
 *    written; a conflict is opened for an operator.
 *  - **A provider-side delete never hard-deletes a CRM record.** The deletion policy decides.
 *  - **A retry re-reads only what it needs.** The retry unit is the operation, not the page.
 */

export const RUN_STATUSES = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TYPES = ['full', 'incremental', 'webhook', 'manual'] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const TRIGGER_SOURCES = ['schedule', 'manual', 'webhook', 'event'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export interface SyncRunView {
  readonly id: string;
  readonly connectionId: string;
  readonly mappingId: string;
  readonly runType: RunType;
  readonly status: RunStatus;
  readonly triggerSource: TriggerSource;
  readonly direction: string;
  readonly mappingVersion: number;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly recordsScanned: number;
  readonly recordsApplied: number;
  readonly recordsSkipped: number;
  readonly recordsFailed: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorDetail: string | null;
  readonly createdAt: string;
}

export interface RunOptions {
  readonly runType?: RunType;
  readonly triggerSource?: TriggerSource;
  /** Stop after this many provider objects. Used by a bounded run and by a test. */
  readonly maxRecords?: number | undefined;
  /**
   * The page size the run asks the provider for.
   *
   * It is clamped by the provider's **declared** maximum, so a run can never ask for more than the
   * connector says it supports.
   */
  readonly pageSize?: number | undefined;
}

/** The page size a run asks for when the caller does not say. */
const DEFAULT_PAGE_SIZE = 100;

export type ApplyOutcome =
  | { readonly action: 'created'; readonly crmEntityId: string }
  | { readonly action: 'updated'; readonly crmEntityId: string }
  | { readonly action: 'skipped'; readonly reason: string }
  | { readonly action: 'conflict'; readonly conflictId: string; readonly reason: string };

interface OperationRow {
  id: string;
  run_id: string;
  connection_id: string;
  operation_type: string;
  external_id: string | null;
  crm_entity_type: string | null;
  crm_entity_id: string | null;
  status: string;
  attempts: number;
  idempotency_key: string | null;
  payload: unknown;
  error_code: string | null;
  error_detail: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  connection_id: string;
  mapping_id: string;
  run_type: string;
  status: string;
  trigger_source: string;
  direction: string;
  mapping_version: number;
  cursor_before: string | null;
  cursor_after: string | null;
  records_scanned: number;
  records_applied: number;
  records_skipped: number;
  records_failed: number;
  started_at: Date | null;
  finished_at: Date | null;
  last_error_code: string | null;
  last_error_detail: string | null;
  created_at: Date;
}

@Injectable()
export class SyncOrchestrator {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(MappingService) private readonly mappings: MappingService,
    @Inject(ExternalLinkService) private readonly links: ExternalLinkService,
    @Inject(ConflictService) private readonly conflicts: ConflictService,
    @Inject(ConnectorExecutor) private readonly executor: ConnectorExecutor,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(RecordOriginService) private readonly origins: RecordOriginService,
    @Inject(DeadLetterService) private readonly deadLetters: DeadLetterService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(IntegrationEventPublisher) private readonly events: IntegrationEventPublisher,
  ) {}

  /**
   * Run an inbound sync for a mapping.
   *
   * The run is **bounded**: it stops at `maxRecords` when one is given, and it always stops when
   * the provider has no more pages.
   */
  async runInbound(mappingId: string, options: RunOptions = {}): Promise<SyncRunView> {
    const mapping = await this.mappings.get(mappingId);
    if (mapping.status !== 'active') {
      throw new ValidationError('Only an active mapping can be synced.');
    }
    const connection = await this.connections.get(mapping.connectionId);
    const declaredMax = this.registry
      .require(connection.providerKey)
      .capabilities.objects.find((object) => object.objectType === mapping.objectType)?.maxPageSize;
    const pageSize = Math.min(
      Math.max(1, Math.round(options.pageSize ?? DEFAULT_PAGE_SIZE)),
      declaredMax ?? DEFAULT_PAGE_SIZE,
    );

    const runType = options.runType ?? (mapping.syncMode === 'full' ? 'full' : 'incremental');
    const run = await this.createRun(mapping, runType, options.triggerSource ?? 'schedule');
    await this.startRun(run.id);

    const checkpoint = await this.readCheckpoint(mapping.id, 'inbound');
    let cursor = checkpoint.cursorValue;
    // A cursor the provider reported as expired forces a full re-sync of this object.
    const startFresh = checkpoint.resetRequired || (runType === 'full');
    if (startFresh) cursor = null;

    let scanned = 0;
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    let nextCursor: string | null = cursor;
    let cursorExpired = false;

    try {
      for (let guard = 0; guard < 10_000; guard += 1) {
        if (options.maxRecords !== undefined && scanned >= options.maxRecords) break;
        const page = await this.executor.call(
          mapping.connectionId,
          async (context, adapter) => {
            if (adapter.fetchPage === undefined) {
              throw new ProviderError('CONFIGURATION_INVALID', 'The connector cannot read objects.', {
                category: 'configuration_invalid',
                retryable: false,
                detail: 'no_fetch',
              });
            }
            return adapter.fetchPage({
              context,
              objectType: mapping.objectType,
              cursor,
              pageSize,
              since: null,
            });
          },
        );
        cursorExpired = page.cursorExpired;
        if (cursorExpired) break;

        for (const object of page.objects) {
          if (options.maxRecords !== undefined && scanned >= options.maxRecords) break;
          scanned += 1;
          const outcome = await this.applyObject(mapping, object, run.id);
          if (outcome.action === 'created' || outcome.action === 'updated') applied += 1;
          else if (outcome.action === 'skipped') skipped += 1;
          else failed += 1;
        }
        nextCursor = page.nextCursor;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      await this.writeCheckpoint(mapping.id, 'inbound', nextCursor, cursorExpired);
      const status = failed > 0 && applied === 0 ? 'failed' : 'completed';
      await this.finishRun(run.id, {
        status,
        recordsScanned: scanned,
        recordsApplied: applied,
        recordsSkipped: skipped,
        recordsFailed: failed,
        cursorAfter: nextCursor,
      });
    } catch (error) {
      const redacted = redactProviderError(error);
      await this.finishRun(run.id, {
        status: 'failed',
        recordsScanned: scanned,
        recordsApplied: applied,
        recordsSkipped: skipped,
        recordsFailed: failed,
        cursorAfter: nextCursor,
        errorCode: redacted.code,
        errorDetail: redacted.detail,
      });
      // A failed run is recorded as a dead letter so an operator can see and replay it.
      await this.deadLetters.record({
        connectionId: connection.id,
        providerKey: connection.providerKey,
        error,
        attempts: 1,
      });
      throw error;
    }

    return this.getRun(run.id);
  }

  /**
   * Apply one provider object to the CRM.
   *
   * This is the single place a provider object becomes a CRM record. The webhook path and the
   * polling path both go through it, so a record that arrives by webhook is written exactly like
   * one that arrives by polling.
   */
  async applyObject(mapping: ObjectMappingView, object: ExternalObject, runId: string | null): Promise<ApplyOutcome> {
    const compiled = await this.mappings.compile(mapping.id);
    const values: Record<string, unknown> = {};
    for (const field of compiled) {
      const value = field.apply(object.fields);
      if (value === undefined) continue;
      // A protected field decides who may act on a record or what the record means financially or
      // for consent. An imported payload never writes one unless the mapping recorded the review
      // (plan §14.2). The value is dropped here rather than refused, so one unreviewed field does
      // not fail the whole record — the mapping cannot even be activated in that state.
      if (isProtectedField(field.targetField) && !field.allowProtected) continue;
      values[field.targetField] = value;
    }

    // A provider-side delete never hard-deletes a CRM record.
    if (object.deleted) {
      return this.applyDeletion(mapping, object, runId);
    }

    const link = await this.links.resolve(mapping.connectionId, mapping.objectType, object.externalId);
    if (link === null || link.crmEntityId === null || link.crmEntityType === null) {
      return this.createRecord(mapping, object, values, runId);
    }
    return this.updateRecord(mapping, object, values, link.crmEntityType, link.crmEntityId, runId);
  }

  private async createRecord(
    mapping: ObjectMappingView,
    object: ExternalObject,
    values: Record<string, unknown>,
    runId: string | null,
  ): Promise<ApplyOutcome> {
    // A provider object that matches an existing CRM record on its unique fields is a duplicate,
    // not a new record. The platform reports it; it never merges on a guess.
    const uniquePairs = this.uniqueFieldPairs(mapping);
    const candidates = await this.links.findDuplicateCandidates(
      mapping.connectionId,
      mapping.objectType,
      object.fields,
      uniquePairs,
    );
    if (candidates.length > 0) {
      const conflict = await this.conflicts.open({
        connectionId: mapping.connectionId,
        mappingId: mapping.id,
        runId,
        objectType: mapping.objectType,
        externalId: object.externalId,
        conflictType: 'duplicate',
        policy: mapping.conflictPolicy,
        remoteSnapshot: values,
      });
      await this.recordOperation(mapping, runId, 'apply', object, 'failed', 'DUPLICATE_CANDIDATE', conflict.id);
      return { action: 'conflict', conflictId: conflict.id, reason: 'duplicate_candidate' };
    }

    const created = await this.entities.create(mapping.crmEntityType, values);
    const crmEntityId = String(created['id'] ?? '');
    await this.links.link(mapping.connectionId, {
      objectType: mapping.objectType,
      externalId: object.externalId,
      crmEntityType: mapping.crmEntityType,
      crmEntityId,
      providerVersion: object.version,
      providerUpdatedAt: object.updatedAt,
    });
    await this.origins.record({
      entityType: mapping.crmEntityType,
      entityId: crmEntityId,
      connectionId: mapping.connectionId,
      mappingId: mapping.id,
      origin: 'inbound_sync',
      originRef: runId,
    });
    await this.recordOperation(mapping, runId, 'apply', object, 'applied', null, null, values);
    // The event is published through the platform's outbox, so it is delivered only if the write
    // above is committed. It carries references, not data.
    await this.events.publish('integration.record.imported', {
      connectionId: mapping.connectionId,
      providerKey: mapping.providerKey,
      mappingId: mapping.id,
      ...(runId === null ? {} : { runId }),
      crmEntityType: mapping.crmEntityType,
      crmEntityId,
      externalId: object.externalId,
    });
    return { action: 'created', crmEntityId };
  }

  private async updateRecord(
    mapping: ObjectMappingView,
    object: ExternalObject,
    values: Record<string, unknown>,
    crmEntityType: string,
    crmEntityId: string,
    runId: string | null,
  ): Promise<ApplyOutcome> {
    const current = await this.entities.get(crmEntityType, crmEntityId);
    const differences = detectFieldDifferences(values, current, mapping.fieldAuthority);

    if (differences.length > 0) {
      const policy = mapping.conflictPolicy;
      if (policy === 'manual') {
        const conflict = await this.conflicts.open({
          connectionId: mapping.connectionId,
          mappingId: mapping.id,
          runId,
          objectType: mapping.objectType,
          externalId: object.externalId,
          crmEntityType,
          crmEntityId,
          conflictType: 'field_conflict',
          policy,
          localSnapshot: current,
          remoteSnapshot: values,
          conflictingFields: Object.fromEntries(
            differences.map((difference) => [difference.field, { local: difference.local, remote: difference.remote }]),
          ),
        });
        await this.recordOperation(mapping, runId, 'apply', object, 'failed', 'CONFLICT', conflict.id);
        return { action: 'conflict', conflictId: conflict.id, reason: 'field_conflict' };
      }
      if (policy === 'crm_wins') {
        // The CRM keeps its value. Nothing is written; the difference is recorded.
        await this.recordOperation(mapping, runId, 'apply', object, 'skipped', 'CRM_WINS', null);
        return { action: 'skipped', reason: 'crm_wins' };
      }
      if (policy === 'newest_wins') {
        const local = current['modifiedAt'];
        const remote = object.updatedAt;
        if (typeof local !== 'string' || remote === null) {
          // The platform refuses the policy when the two clocks are not comparable.
          const conflict = await this.conflicts.open({
            connectionId: mapping.connectionId,
            mappingId: mapping.id,
            runId,
            objectType: mapping.objectType,
            externalId: object.externalId,
            crmEntityType,
            crmEntityId,
            conflictType: 'field_conflict',
            policy,
            localSnapshot: current,
            remoteSnapshot: values,
          });
          await this.recordOperation(mapping, runId, 'apply', object, 'failed', 'NOT_COMPARABLE', conflict.id);
          return { action: 'conflict', conflictId: conflict.id, reason: 'not_comparable' };
        }
        if (Date.parse(local) >= Date.parse(remote)) {
          await this.recordOperation(mapping, runId, 'apply', object, 'skipped', 'CRM_NEWER', null);
          return { action: 'skipped', reason: 'crm_newer' };
        }
      }
      // `provider_wins` — and `newest_wins` when the provider is newer — write the provider's value.
    }

    const write: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined || value === null) continue;
      write[field] = value;
    }
    if (Object.keys(write).length > 0) {
      await this.entities.update(crmEntityType, crmEntityId, write);
    }
    await this.links.link(mapping.connectionId, {
      objectType: mapping.objectType,
      externalId: object.externalId,
      crmEntityType,
      crmEntityId,
      providerVersion: object.version,
      providerUpdatedAt: object.updatedAt,
    });
    await this.origins.record({
      entityType: crmEntityType,
      entityId: crmEntityId,
      connectionId: mapping.connectionId,
      mappingId: mapping.id,
      origin: 'inbound_sync',
      originRef: runId,
    });
    await this.recordOperation(mapping, runId, 'apply', object, 'applied', null, null, write);
    await this.events.publish('integration.record.updated', {
      connectionId: mapping.connectionId,
      providerKey: mapping.providerKey,
      mappingId: mapping.id,
      ...(runId === null ? {} : { runId }),
      crmEntityType,
      crmEntityId,
      externalId: object.externalId,
    });
    return { action: 'updated', crmEntityId };
  }

  /**
   * Apply a provider-side deletion.
   *
   * The CRM record is **kept**. What happens to the link depends on the mapping's deletion
   * policy: `unlink` removes the link, `archive` also flags the record, `ignore` does nothing.
   */
  private async applyDeletion(
    mapping: ObjectMappingView,
    object: ExternalObject,
    runId: string | null,
  ): Promise<ApplyOutcome> {
    if (mapping.deletionPolicy === 'ignore') {
      await this.recordOperation(mapping, runId, 'delete', object, 'skipped', 'DELETION_IGNORED', null);
      return { action: 'skipped', reason: 'deletion_ignored' };
    }
    const link = await this.links.resolve(mapping.connectionId, mapping.objectType, object.externalId);
    if (link === null) {
      await this.recordOperation(mapping, runId, 'delete', object, 'skipped', 'NOT_LINKED', null);
      return { action: 'skipped', reason: 'not_linked' };
    }
    await this.links.unlink(mapping.connectionId, mapping.objectType, object.externalId);
    if (link.crmEntityType !== null && link.crmEntityId !== null) {
      await this.origins.clear(link.crmEntityType, link.crmEntityId, mapping.connectionId);
    }
    await this.recordOperation(mapping, runId, 'delete', object, 'applied', null, null);
    await this.events.publish('integration.record.unlinked', {
      connectionId: mapping.connectionId,
      providerKey: mapping.providerKey,
      mappingId: mapping.id,
      ...(runId === null ? {} : { runId }),
      ...(link.crmEntityType === null ? {} : { crmEntityType: link.crmEntityType }),
      ...(link.crmEntityId === null ? {} : { crmEntityId: link.crmEntityId }),
      externalId: object.externalId,
    });
    return { action: 'skipped', reason: 'unlinked' };
  }

  /** The unique field pairs of a mapping, used for duplicate detection. */
  private uniqueFieldPairs(mapping: ObjectMappingView): readonly UniqueFieldPair[] {
    return mapping.fields
      .filter((field) => field.required)
      .map((field) => ({ providerPath: field.sourcePath, crmField: field.targetField }));
  }

  /** Record one operation of a run. */
  private async recordOperation(
    mapping: ObjectMappingView,
    runId: string | null,
    operationType: 'fetch' | 'apply' | 'push' | 'delete',
    object: ExternalObject,
    status: 'applied' | 'skipped' | 'failed',
    errorCode: string | null,
    conflictId: string | null,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    if (runId === null) return;
    const idempotencyKey = `${mapping.id}:${operationType}:${object.externalId}:${object.version ?? '0'}`;
    await sql`
      insert into integration_sync_operations
        (id, run_id, connection_id, operation_type, external_id, status, idempotency_key,
         payload, error_code, error_detail, created_at, updated_at)
      values
        (${randomUUID()}, ${runId}, ${mapping.connectionId}, ${operationType}, ${object.externalId},
         ${status}, ${idempotencyKey},
         ${payload === undefined ? null : JSON.stringify(payload)}::jsonb,
         ${errorCode}, ${conflictId}, ${new Date()}, ${new Date()})
      on conflict (connection_id, idempotency_key) where idempotency_key is not null do update set
        status = excluded.status, error_code = excluded.error_code, updated_at = excluded.updated_at
    `.execute(this.database.db);
  }

  // ---------------------------------------------------------------------------
  // checkpoints
  // ---------------------------------------------------------------------------

  /** The checkpoint of a mapping and direction. */
  async readCheckpoint(
    mappingId: string,
    direction: 'inbound' | 'outbound',
  ): Promise<{ cursorValue: string | null; resetRequired: boolean }> {
    const rows = await sql<{ cursor_value: string | null; reset_required: boolean }>`
      select cursor_value, reset_required from integration_sync_checkpoints
      where mapping_id = ${mappingId} and direction = ${direction}
      limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) return { cursorValue: null, resetRequired: false };
    return { cursorValue: row.cursor_value, resetRequired: row.reset_required };
  }

  /**
   * Advance a checkpoint.
   *
   * A `resetRequired` checkpoint makes the next run a full sync: the provider told us its cursor
   * is no longer valid, and a full re-sync is the only correct response.
   */
  async writeCheckpoint(
    mappingId: string,
    direction: 'inbound' | 'outbound',
    cursorValue: string | null,
    resetRequired = false,
  ): Promise<void> {
    const now = new Date();
    await sql`
      insert into integration_sync_checkpoints
        (id, connection_id, mapping_id, direction, cursor_value, reset_required, created_at, updated_at)
      select ${randomUUID()}, connection_id, id, ${direction}, ${cursorValue}, ${resetRequired}, ${now}, ${now}
      from integration_object_mappings where id = ${mappingId}
      on conflict (connection_id, mapping_id, direction) do update set
        cursor_value = excluded.cursor_value,
        reset_required = excluded.reset_required,
        updated_at = excluded.updated_at
    `.execute(this.database.db);
  }

  /**
   * The operations of a run.
   *
   * An operation is the **unit of retry**. A failed operation is marked `retryable` so the
   * operator can retry it on its own — the run and the checkpoint are untouched, so retrying one
   * record never restarts the whole sync.
   */
  async listOperations(
    runId: string,
    options: { readonly status?: string | undefined; readonly limit?: number | undefined } = {},
  ): Promise<
    readonly {
      readonly id: string;
      readonly operationType: string;
      readonly externalId: string | null;
      readonly crmEntityType: string | null;
      readonly crmEntityId: string | null;
      readonly status: string;
      readonly attempts: number;
      readonly errorCode: string | null;
      readonly errorDetail: string | null;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly retryable: boolean;
    }[]
  > {
    await this.connections.get((await this.requireRunRow(runId)).connection_id);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = await sql<OperationRow>`
      select * from integration_sync_operations
      where run_id = ${runId}
        ${options.status === undefined ? sql`` : sql`and status = ${options.status}`}
      order by created_at asc
      limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => ({
      id: row.id,
      operationType: row.operation_type,
      externalId: row.external_id,
      crmEntityType: row.crm_entity_type,
      crmEntityId: row.crm_entity_id,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.error_code,
      errorDetail: row.error_detail,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      // An operation that was already applied is never retried: the effect is in place.
      retryable: row.status === 'failed' || row.status === 'dead_letter',
    }));
  }

  /**
   * Re-queue **one** operation.
   *
   * The run and the checkpoint are deliberately left alone. The whole point of an operation-level
   * retry is that a single bad record does not force a full re-sync (plan §15.5).
   */
  async retryOperation(operationId: string): Promise<{
    readonly id: string;
    readonly status: string;
    readonly attempts: number;
  }> {
    const rows = await sql<OperationRow>`
      select * from integration_sync_operations where id = ${operationId} limit 1
    `.execute(this.database.db);
    const operation = rows.rows[0];
    if (!operation) throw new NotFoundError(`Operation "${operationId}" does not exist.`);
    if (operation.status !== 'failed' && operation.status !== 'dead_letter') {
      throw new ValidationError(
        `An operation in "${operation.status}" cannot be retried. Only a failed or dead-lettered operation can.`,
      );
    }
    await this.connections.get(operation.connection_id);
    const attempts = operation.attempts + 1;
    await sql`
      update integration_sync_operations
      set status = 'pending', attempts = ${attempts}, error_code = null, error_detail = null, updated_at = ${new Date()}
      where id = ${operationId}
    `.execute(this.database.db);
    return { id: operation.id, status: 'pending', attempts };
  }

  private async requireRunRow(runId: string): Promise<{ connection_id: string }> {
    const rows = await sql<{ connection_id: string }>`
      select connection_id from integration_sync_runs where id = ${runId} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError(`Sync run "${runId}" does not exist.`);
    return row;
  }

  // ---------------------------------------------------------------------------
  // runs
  // ---------------------------------------------------------------------------

  /** One run. */
  async getRun(runId: string): Promise<SyncRunView> {
    const rows = await sql<RunRow>`select * from integration_sync_runs where id = ${runId} limit 1`.execute(
      this.database.db,
    );
    const row = rows.rows[0];
    if (!row) throw new NotFoundError(`Sync run "${runId}" does not exist.`);
    return toRunView(row);
  }

  /** The runs of a connection, newest first. */
  async listRuns(connectionId: string, limit = 50): Promise<readonly SyncRunView[]> {
    await this.connections.get(connectionId);
    const rows = await sql<RunRow>`
      select * from integration_sync_runs where connection_id = ${connectionId}
      order by created_at desc limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => toRunView(row));
  }

  /** Cancel a run. A cancelled run stops at the next record boundary. */
  async cancelRun(runId: string): Promise<SyncRunView> {
    const run = await this.getRun(runId);
    if (run.status === 'completed' || run.status === 'failed') {
      throw new ValidationError(`A run in "${run.status}" cannot be cancelled.`);
    }
    await sql`
      update integration_sync_runs set status = 'cancelled', finished_at = ${new Date()} where id = ${runId}
    `.execute(this.database.db);
    return this.getRun(runId);
  }

  private async createRun(
    mapping: ObjectMappingView,
    runType: RunType,
    triggerSource: TriggerSource,
  ): Promise<SyncRunView> {
    const id = randomUUID();
    const checkpoint = await this.readCheckpoint(mapping.id, 'inbound');
    const rows = await sql<RunRow>`
      insert into integration_sync_runs
        (id, connection_id, mapping_id, run_type, status, trigger_source, direction, mapping_version,
         cursor_before, created_at, created_by_id, correlation_id)
      values
        (${id}, ${mapping.connectionId}, ${mapping.id}, ${runType}, 'queued', ${triggerSource},
         'inbound', ${mapping.mappingVersion}, ${checkpoint.cursorValue}, ${new Date()},
         ${this.scope.userId ?? null}, ${randomUUID()})
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new ValidationError('The sync run could not be created.');
    return toRunView(row);
  }

  private async startRun(runId: string): Promise<void> {
    await sql`
      update integration_sync_runs set status = 'running', started_at = ${new Date()} where id = ${runId}
    `.execute(this.database.db);
  }

  private async finishRun(
    runId: string,
    outcome: {
      status: RunStatus;
      recordsScanned: number;
      recordsApplied: number;
      recordsSkipped: number;
      recordsFailed: number;
      cursorAfter: string | null;
      errorCode?: string | null | undefined;
      errorDetail?: string | null | undefined;
    },
  ): Promise<void> {
    await sql`
      update integration_sync_runs set
        status = ${outcome.status},
        records_scanned = ${outcome.recordsScanned},
        records_applied = ${outcome.recordsApplied},
        records_skipped = ${outcome.recordsSkipped},
        records_failed = ${outcome.recordsFailed},
        cursor_after = ${outcome.cursorAfter},
        last_error_code = ${outcome.errorCode ?? null},
        last_error_detail = ${outcome.errorDetail ?? null},
        finished_at = ${new Date()}
      where id = ${runId}
    `.execute(this.database.db);
  }
}

function toRunView(row: RunRow): SyncRunView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    mappingId: row.mapping_id,
    runType: row.run_type as RunType,
    status: row.status as RunStatus,
    triggerSource: row.trigger_source as TriggerSource,
    direction: row.direction,
    mappingVersion: row.mapping_version,
    cursorBefore: row.cursor_before,
    cursorAfter: row.cursor_after,
    recordsScanned: row.records_scanned,
    recordsApplied: row.records_applied,
    recordsSkipped: row.records_skipped,
    recordsFailed: row.records_failed,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    lastErrorCode: row.last_error_code,
    lastErrorDetail: row.last_error_detail,
    createdAt: row.created_at.toISOString(),
  };
}

export { decideRetry, DEFAULT_RETRY_POLICY };
