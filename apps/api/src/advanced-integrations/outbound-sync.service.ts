import { createHash, randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';
import { ConnectorExecutor } from './connector-executor.service.js';
import { ExternalLinkService } from './external-link.service.js';
import { MappingService } from './mapping.service.js';
import { ProviderError, redactProviderError } from './provider-error.js';
import { RecordOriginService } from './record-origin.service.js';
import { compileFieldMappings } from './transformation-compiler.js';

/**
 * Phase 19-INT.13 — outbound sync, the outbox and echo prevention
 * (`PLAN_Phase_19_Advanced_Integrations.md` §11.6; `19-INT.13`).
 *
 * A CRM record changes → the platform publishes a domain event → the worker delivers it → this
 * service decides whether the provider should hear about it.
 *
 * **The echo.** Without a guard, an inbound sync writes a CRM record, that write produces an
 * event, the event produces an outbound operation, and the outbound operation pushes the record
 * back to the provider — which pushes it back again, forever.
 *
 * The guard is the **record origin** (`record-origin.service.ts`): the platform records who last
 * changed a record, and a change whose last author was a sync on that same connection is an
 * echo and is skipped. A change whose last author was a **user** is a genuine change and is
 * pushed.
 *
 * Every outbound operation carries an **idempotency key**, so a retried push is never applied
 * twice.
 */

export const OUTBOUND_OPERATION_TYPES = ['create', 'update', 'delete'] as const;
export type OutboundOperationType = (typeof OUTBOUND_OPERATION_TYPES)[number];

export const OUTBOUND_STATUSES = ['queued', 'applied', 'skipped', 'failed', 'dead_letter'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** The job that pushes one outbound operation. */
export const OUTBOUND_PUSH_JOB = 'advancedIntegrations.pushOutbound';

export interface OutboundEventInput {
  /** The domain event id. It is the stable key of the event. */
  readonly eventId: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
}

export interface OutboundEventResult {
  readonly queued: number;
  /** The operations that were skipped because they were an echo. */
  readonly echoes: number;
  /** The operations that were skipped because no mapping covers the entity. */
  readonly unmapped: number;
}

export interface OutboundOperationView {
  readonly id: string;
  readonly connectionId: string;
  readonly mappingId: string;
  readonly crmEntityType: string;
  readonly crmEntityId: string;
  readonly operationType: OutboundOperationType;
  readonly status: OutboundStatus;
  readonly attempts: number;
  readonly idempotencyKey: string;
  /** The redacted payload that was pushed. Never a credential. */
  readonly payload: Record<string, unknown>;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly createdAt: string;
  readonly appliedAt: string | null;
}

interface OutboundRow {
  id: string;
  connection_id: string;
  mapping_id: string;
  crm_entity_type: string;
  crm_entity_id: string;
  operation_type: string;
  status: string;
  attempts: number;
  idempotency_key: string;
  origin_event_id: string | null;
  payload: unknown;
  error_code: string | null;
  error_detail: string | null;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
}

@Injectable()
export class OutboundSyncService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(MappingService) private readonly mappings: MappingService,
    @Inject(ExternalLinkService) private readonly links: ExternalLinkService,
    @Inject(ConnectorExecutor) private readonly executor: ConnectorExecutor,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(RecordOriginService) private readonly origins: RecordOriginService,
  ) {}

  /**
   * Handle one CRM domain event.
   *
   * The event arrives from the worker, which has no user session; the work runs under the
   * documented service authority inside the executor and the link service.
   */
  async handleEvent(input: OutboundEventInput): Promise<OutboundEventResult> {
    const mappings = await this.mappings.listActiveForEntity(input.entityType);

    let queued = 0;
    let echoes = 0;
    let unmapped = 0;
    if (mappings.length === 0) unmapped = 1;

    for (const mapping of mappings) {
      const connection = await this.connections.get(mapping.connectionId);
      if (!connection.enabled) continue;

      // The echo guard. A record whose last change came from a sync on this connection is not
      // pushed back to the provider.
      if (await this.origins.isEcho(input.entityType, input.entityId, mapping.connectionId)) {
        echoes += 1;
        continue;
      }

      const operationType: OutboundOperationType = input.eventType === 'entity.deleted' ? 'delete' : 'update';
      const payload = await this.buildPayload(mapping.id, input.entityType, input.entityId, operationType);
      const operation = await this.enqueueOperation({
        mappingId: mapping.id,
        connectionId: mapping.connectionId,
        entityType: input.entityType,
        entityId: input.entityId,
        operationType,
        payload,
        eventId: input.eventId,
      });
      if (operation === null) continue;
      queued += 1;
      await this.jobs.enqueue({
        job: OUTBOUND_PUSH_JOB,
        data: { operationId: operation.id, connectionId: mapping.connectionId },
      });
    }
    return { queued, echoes, unmapped };
  }

  /**
   * Push one queued operation to the provider.
   *
   * The push is idempotent: the operation carries a key, and the provider receives it when it
   * supports one.
   */
  async push(operationId: string): Promise<OutboundOperationView> {
    const operation = await this.getOperation(operationId);
    if (operation.status === 'applied') return operation;

    const mapping = await this.mappings.get(operation.mappingId);
    const link = await this.links.resolve(
      operation.connectionId,
      mapping.objectType,
      await this.externalIdFor(operation),
    );

    try {
      const externalId = link?.externalId ?? null;
      await this.executor.call(operation.connectionId, async (context, adapter) => {
        if (operation.operationType === 'delete') {
          if (adapter.deleteObject === undefined) {
            throw new ProviderError('CONFIGURATION_INVALID', 'The connector cannot delete objects.', {
              category: 'configuration_invalid',
              retryable: false,
              detail: 'no_delete',
            });
          }
          if (externalId === null) return;
          await adapter.deleteObject({
            context,
            objectType: mapping.objectType,
            externalId,
          });
          return;
        }
        if (adapter.upsertObject === undefined) {
          throw new ProviderError('CONFIGURATION_INVALID', 'The connector cannot write objects.', {
            category: 'configuration_invalid',
            retryable: false,
            detail: 'no_write',
          });
        }
        await adapter.upsertObject({
          context,
          objectType: mapping.objectType,
          externalId,
          fields: operation.payload,
          idempotencyKey: operation.idempotencyKey,
        });
      });

      await sql`
        update integration_outbound_operations set
          status = 'applied', attempts = attempts + 1, applied_at = ${new Date()}, updated_at = ${new Date()},
          error_code = null, error_detail = null
        where id = ${operationId}
      `.execute(this.database.db);
      await this.origins.record({
        entityType: operation.crmEntityType,
        entityId: operation.crmEntityId,
        connectionId: operation.connectionId,
        mappingId: operation.mappingId,
        origin: 'outbound_sync',
        originRef: operationId,
      });
    } catch (error) {
      const redacted = redactProviderError(error);
      const attempts = operation.attempts + 1;
      await sql`
        update integration_outbound_operations set
          status = ${attempts >= 5 ? 'dead_letter' : 'failed'},
          attempts = ${attempts}, error_code = ${redacted.code}, error_detail = ${redacted.detail},
          updated_at = ${new Date()}
        where id = ${operationId}
      `.execute(this.database.db);
      throw error;
    }
    return this.getOperation(operationId);
  }

  /** The queued operations of a connection. */
  async listOperations(connectionId: string, limit = 100): Promise<readonly OutboundOperationView[]> {
    await this.connections.get(connectionId);
    const rows = await sql<OutboundRow>`
      select * from integration_outbound_operations
      where connection_id = ${connectionId}
      order by created_at desc
      limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => toView(row));
  }

  /** One operation. */
  async getOperation(operationId: string): Promise<OutboundOperationView> {
    const rows = await sql<OutboundRow>`
      select * from integration_outbound_operations where id = ${operationId} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError(`Outbound operation "${operationId}" does not exist.`);
    return toView(row);
  }

  /**
   * Build the provider payload for a CRM record.
   *
   * The mapping's field mappings are **reversed** for the outbound direction: the CRM field is
   * the source and the provider path is the target.
   */
  private async buildPayload(
    mappingId: string,
    entityType: string,
    entityId: string,
    operationType: OutboundOperationType,
  ): Promise<Record<string, unknown>> {
    if (operationType === 'delete') return {};
    const mapping = await this.mappings.get(mappingId);
    const record = await this.entities.get(entityType, entityId);
    const reversed = mapping.fields
      .filter((field) => field.direction === 'outbound' || field.direction === 'bidirectional')
      .map((field) => ({
        sourcePath: field.targetField,
        targetField: field.sourcePath,
        transform: field.transform,
        required: field.required,
      }));
    const compiled = compileFieldMappings(reversed);
    const payload: Record<string, unknown> = {};
    for (const field of compiled) {
      const value = field.apply(record);
      if (value === undefined || value === null) continue;
      payload[field.targetField] = value;
    }
    return payload;
  }

  /**
   * The provider's id for a CRM record.
   *
   * A record that has never been pushed has no link yet, so the operation creates it on the
   * provider side.
   */
  private async externalIdFor(operation: OutboundOperationView): Promise<string> {
    const rows = await sql<{ external_id: string }>`
      select external_id from integration_external_links
      where connection_id = ${operation.connectionId}
        and crm_entity_type = ${operation.crmEntityType}
        and crm_entity_id = ${operation.crmEntityId}
        and link_status = 'linked'
      limit 1
    `.execute(this.database.db);
    return rows.rows[0]?.external_id ?? '';
  }

  /**
   * Create an outbound operation, or return `null` when the same operation already exists.
   *
   * The idempotency key is derived from the connection, the mapping, the record and the event,
   * so a redelivered event does not queue the same push twice.
   */
  private async enqueueOperation(input: {
    mappingId: string;
    connectionId: string;
    entityType: string;
    entityId: string;
    operationType: OutboundOperationType;
    payload: Record<string, unknown>;
    eventId: string;
  }): Promise<OutboundOperationView | null> {
    const idempotencyKey = createHash('sha256')
      .update(
        [input.connectionId, input.mappingId, input.entityType, input.entityId, input.operationType, input.eventId].join(
          ':',
        ),
      )
      .digest('hex');
    const rows = await sql<OutboundRow>`
      insert into integration_outbound_operations
        (id, connection_id, mapping_id, crm_entity_type, crm_entity_id, operation_type, status,
         attempts, idempotency_key, origin_event_id, payload, created_at, updated_at)
      values
        (${randomUUID()}, ${input.connectionId}, ${input.mappingId}, ${input.entityType}, ${input.entityId},
         ${input.operationType}, 'queued', 0, ${idempotencyKey}, ${input.eventId},
         ${JSON.stringify(input.payload)}::jsonb, ${new Date()}, ${new Date()})
      on conflict (connection_id, idempotency_key) where idempotency_key is not null do nothing
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) return null;
    return toView(row);
  }
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toView(row: OutboundRow): OutboundOperationView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    mappingId: row.mapping_id,
    crmEntityType: row.crm_entity_type,
    crmEntityId: row.crm_entity_id,
    operationType: row.operation_type as OutboundOperationType,
    status: row.status as OutboundStatus,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    payload: parsePayload(row.payload),
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at.toISOString(),
    appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
  };
}

export { ValidationError };
