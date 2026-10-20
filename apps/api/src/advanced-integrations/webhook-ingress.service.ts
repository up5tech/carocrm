import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { NormalizedProviderEvent } from './connector-adapter.port.js';
import { ConnectorExecutor } from './connector-executor.service.js';
import { MappingService } from './mapping.service.js';
import { ProviderError, redactProviderError } from './provider-error.js';
import { SyncOrchestrator } from './sync-orchestrator.service.js';
import { ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX } from './webhook-prefix.js';

/**
 * Phase 19-INT.12 — the shared webhook ingress
 * (`PLAN_Phase_19_Advanced_Integrations.md` §10; `19-INT.12`).
 *
 * One ingress serves every connector. The order of the steps is the security posture:
 *
 *  1. The path segment is an **opaque webhook key**, not a connection id. It is a routing
 *     identifier, not a secret — the secret is the provider's signature.
 *  2. The **signature is verified before anything is recorded**. An unverified payload is not
 *     written to the receipt table, not normalised and not enqueued. The verification itself is
 *     the connector's, because the algorithm is the provider's.
 *  3. The **raw body** is passed to the connector, because a provider signs the exact bytes it
 *     sent.
 *  4. A **delivery id** deduplicates. A repeated delivery is acknowledged and discarded; it is
 *     never processed twice.
 *  5. The endpoint **acknowledges fast** and processes asynchronously. A slow provider must never
 *     hold an HTTP connection open.
 *
 * The two existing provider ingresses (Voice, Marketing) are deliberately left where they are —
 * see ADR 0004.
 */

export const WEBHOOK_DELIVERY_STATUSES = ['received', 'processed', 'failed', 'rejected', 'duplicate'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export interface WebhookIngressResult {
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  /** The receipt id, when one was written. */
  readonly deliveryId: string | null;
  /** How many normalized events the delivery carried. */
  readonly eventCount: number;
  /** A stable reason code when the delivery was rejected. */
  readonly reason: string | null;
}

export interface WebhookIngressInput {
  readonly providerKey: string;
  /** The opaque path segment the provider was given. */
  readonly webhookKey: string;
  /** The event kind, e.g. `contact.updated`. */
  readonly kind: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  /** The exact bytes the provider sent, when the platform captured them. */
  readonly rawBody: string | null;
  readonly body: unknown;
}

interface ConnectionRow {
  id: string;
  provider_key: string;
  webhook_key: string | null;
  status: string;
  enabled: boolean;
}

/** The job that processes a verified delivery. */
export const WEBHOOK_PROCESS_JOB = 'advancedIntegrations.processWebhookEvent';

@Injectable()
export class WebhookIngressService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ConnectorExecutor) private readonly executor: ConnectorExecutor,
    @Inject(MappingService) private readonly mappings: MappingService,
    @Inject(SyncOrchestrator) private readonly orchestrator: SyncOrchestrator,
  ) {}

  /**
   * Handle one provider callback.
   *
   * The method never throws for a provider-side problem: a rejected or duplicate delivery is a
   * normal outcome that is answered, not an error that is escalated.
   */
  async ingest(input: WebhookIngressInput): Promise<WebhookIngressResult> {
    const connection = await this.findConnection(input.providerKey, input.webhookKey);
    if (connection === null) {
      // The endpoint is unknown. Nothing is recorded, so an attacker cannot use it to fill the
      // receipt table.
      return { status: 'rejected', deliveryId: null, eventCount: 0, reason: 'unknown_endpoint' };
    }

    let events: readonly NormalizedProviderEvent[];
    try {
      events = await this.executor.call(
        connection.id,
        async (context, adapter) => {
          if (adapter.verifyWebhook === undefined || adapter.normalizeWebhook === undefined) {
            throw new ProviderError('CONFIGURATION_INVALID', 'The connector does not support webhooks.', {
              category: 'configuration_invalid',
              retryable: false,
              detail: 'no_webhook',
            });
          }
          const verification = await adapter.verifyWebhook({
            context,
            rawBody: input.rawBody,
            headers: input.headers,
            body: input.body,
            query: input.query,
          });
          if (!verification.valid) {
            throw new ProviderError('INVALID_REQUEST', 'The provider signature was rejected.', {
              category: 'permanent_validation',
              retryable: false,
              detail: verification.reason ?? 'invalid_signature',
            });
          }
          if (verification.challenge !== null) {
            // An endpoint-validation challenge. It is answered by the transport, not stored.
            return [] as readonly NormalizedProviderEvent[];
          }
          return adapter.normalizeWebhook({
            context,
            headers: input.headers,
            body: input.body,
          });
        },
      );
    } catch (error) {
      const redacted = redactProviderError(error);
      // The receipt records that something arrived and was rejected — but **not** the payload,
      // because the payload was never verified.
      await this.writeReceipt({
        connectionId: connection.id,
        providerKey: input.providerKey,
        deliveryId: `rejected:${randomUUID()}`,
        status: 'rejected',
        signatureValid: false,
        errorCode: redacted.code,
        errorDetail: redacted.detail,
        payload: null,
      });
      return { status: 'rejected', deliveryId: null, eventCount: 0, reason: redacted.detail ?? redacted.code };
    }

    let accepted = 0;
    let duplicates = 0;
    for (const event of events) {
      const written = await this.writeReceipt({
        connectionId: connection.id,
        providerKey: input.providerKey,
        deliveryId: event.deliveryId,
        objectType: event.objectType,
        externalId: event.externalId,
        eventType: event.eventType,
        status: 'received',
        signatureValid: true,
        payload: event.fields,
      });
      if (!written) {
        duplicates += 1;
        continue;
      }
      accepted += 1;
      await this.jobs.enqueue({
        job: WEBHOOK_PROCESS_JOB,
        data: {
          connectionId: connection.id,
          providerKey: input.providerKey,
          deliveryId: event.deliveryId,
          objectType: event.objectType,
          externalId: event.externalId,
          eventType: event.eventType,
          kind: input.kind,
        },
      });
    }

    if (accepted === 0 && duplicates > 0) {
      return { status: 'duplicate', deliveryId: null, eventCount: events.length, reason: 'duplicate_delivery' };
    }
    return { status: 'accepted', deliveryId: null, eventCount: accepted, reason: null };
  }

  /**
   * Process one verified delivery.
   *
   * The receipt is the record of what arrived. Processing it applies the provider's change to the
   * CRM through the **same** path the polling path uses, so a record that arrives by webhook is
   * written exactly like one that arrives by polling.
   *
   * The receipt's status is the idempotency guard: a delivery that is already `processed` is
   * not processed again.
   */
  async processDelivery(input: {
    connectionId: string;
    deliveryId: string;
    providerKey: string;
    objectType: string;
    externalId: string | null;
    eventType: string;
  }): Promise<{ readonly status: string; readonly outcome: string }> {
    const rows = await sql<{
      id: string;
      status: string;
      payload: unknown;
      object_type: string | null;
      external_id: string | null;
    }>`
      select * from integration_webhook_deliveries
      where connection_id = ${input.connectionId} and delivery_id = ${input.deliveryId}
      limit 1
    `.execute(this.database.db);
    const receipt = rows.rows[0];
    if (!receipt) {
      throw new ValidationError('The delivery does not exist.');
    }
    if (receipt.status === 'processed') {
      return { status: 'processed', outcome: 'already_processed' };
    }

    const mapping = await this.mappings.findActive(input.connectionId, input.objectType);
    if (mapping === null) {
      await this.markDelivery(input.connectionId, input.deliveryId, 'failed', 'NO_MAPPING');
      return { status: 'failed', outcome: 'no_mapping' };
    }

    const fields =
      typeof receipt.payload === 'object' && receipt.payload !== null && !Array.isArray(receipt.payload)
        ? (receipt.payload as Record<string, unknown>)
        : {};
    const externalId = receipt.external_id ?? input.externalId ?? '';
    if (externalId === '') {
      await this.markDelivery(input.connectionId, input.deliveryId, 'failed', 'NO_EXTERNAL_ID');
      return { status: 'failed', outcome: 'no_external_id' };
    }

    const outcome = await this.orchestrator.applyObject(
      mapping,
      {
        objectType: mapping.objectType,
        externalId,
        externalParentId: null,
        fields,
        updatedAt: null,
        version: null,
        deleted: input.eventType.endsWith('.deleted'),
      },
      null,
    );
    await this.markDelivery(input.connectionId, input.deliveryId, 'processed', null);
    return { status: 'processed', outcome: outcome.action };
  }

  /** The receipts of a connection, newest first. */
  async listDeliveries(connectionId: string, limit = 100): Promise<
    readonly {
      readonly id: string;
      readonly deliveryId: string;
      readonly status: WebhookDeliveryStatus;
      readonly signatureValid: boolean;
      readonly eventType: string | null;
      readonly externalId: string | null;
      readonly receivedAt: string;
    }[]
  > {
    const rows = await sql<{
      id: string;
      delivery_id: string;
      status: string;
      signature_valid: boolean;
      event_type: string | null;
      external_id: string | null;
      received_at: Date;
    }>`
      select * from integration_webhook_deliveries
      where connection_id = ${connectionId}
      order by received_at desc
      limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => ({
      id: row.id,
      deliveryId: row.delivery_id,
      status: row.status as WebhookDeliveryStatus,
      signatureValid: row.signature_valid,
      eventType: row.event_type,
      externalId: row.external_id,
      receivedAt: row.received_at.toISOString(),
    }));
  }

  /**
   * Write a receipt.
   *
   * Returns `false` when the delivery was already recorded — the deduplication path. The unique
   * index makes that an atomic decision, so two concurrent deliveries of the same event cannot
   * both be processed.
   */
  private async writeReceipt(input: {
    connectionId: string;
    providerKey: string;
    deliveryId: string;
    objectType?: string | null | undefined;
    externalId?: string | null | undefined;
    eventType?: string | null | undefined;
    status: WebhookDeliveryStatus;
    signatureValid: boolean;
    errorCode?: string | null | undefined;
    errorDetail?: string | null | undefined;
    payload?: Record<string, unknown> | null | undefined;
  }): Promise<boolean> {
    const result = await sql`
      insert into integration_webhook_deliveries
        (id, connection_id, provider_key, delivery_id, object_type, external_id, event_type,
         status, signature_valid, payload, error_code, error_detail, received_at)
      values
        (${randomUUID()}, ${input.connectionId}, ${input.providerKey}, ${input.deliveryId},
         ${input.objectType ?? null}, ${input.externalId ?? null}, ${input.eventType ?? null},
         ${input.status}, ${input.signatureValid},
         ${input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload)}::jsonb,
         ${input.errorCode ?? null}, ${input.errorDetail ?? null}, ${new Date()})
      on conflict (connection_id, delivery_id) do nothing
    `.execute(this.database.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  /** Mark a delivery's receipt with its terminal status. */
  private async markDelivery(
    connectionId: string,
    deliveryId: string,
    status: 'processed' | 'failed',
    errorCode: string | null,
  ): Promise<void> {
    await sql`
      update integration_webhook_deliveries
      set status = ${status}, error_code = ${errorCode}, processed_at = ${new Date()}
      where connection_id = ${connectionId} and delivery_id = ${deliveryId}
    `.execute(this.database.db);
  }

  /** The connection an endpoint key names, or `null`. */
  private async findConnection(providerKey: string, webhookKey: string): Promise<ConnectionRow | null> {
    const rows = await sql<ConnectionRow>`
      select id, provider_key, webhook_key, status, enabled
      from integration_connections
      where provider_key = ${providerKey} and webhook_key = ${webhookKey} and deleted_at is null
      limit 1
    `.execute(this.database.db);
    return rows.rows[0] ?? null;
  }
}

export { ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX };
