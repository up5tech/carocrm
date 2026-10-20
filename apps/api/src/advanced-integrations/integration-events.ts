import { Inject, Injectable } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Phase 19-INT.25 — the integration events
 * (`PLAN_Phase_19_Advanced_Integrations.md` §19 `19-INT.25`; plan §11.6).
 *
 * The plan says: *"Publish integration events only through approved contracts/outbox."* Two words
 * carry the requirement:
 *
 *  - **approved** — the event types are an allowlist. A caller that asks for an event the module
 *    does not publish is refused, so a typo cannot invent a new domain event, and a consumer can
 *    rely on the list being complete.
 *  - **outbox** — the event is written to the platform's transactional outbox rather than being
 *    dispatched by hand, so it is delivered by the platform's own relay, with its own retry and
 *    its own ordering, instead of by whatever the caller happened to be doing.
 *
 * The events carry **references, not data**: a connection id, a mapping id, a CRM entity id. A
 * consumer that needs the record reads it through the platform's own ACL-aware services. That is
 * what keeps a published event from becoming a data-exfiltration path.
 *
 * **Where the event is atomic.** `publishIn` takes a transaction, and the **contract** path uses
 * it: the owner's service writes the record and the event in the same transaction, so an event can
 * never describe a write that was rolled back. The **sync** path publishes after the write,
 * because the sync engine's write path is not one transaction — the record store owns its own
 * mutation. The consequence is honest and small: a process that dies between the record write and
 * the event insert loses the event, and the next run's counters still show what happened. The
 * events are advisory; the record and the run are the truth.
 */

/** The event types this module publishes. */
export const INTEGRATION_EVENT_TYPES = [
  'integration.record.imported',
  'integration.record.updated',
  'integration.record.unlinked',
  'integration.conflict.opened',
  'integration.connection.changed',
  'integration.enrichment.proposed',
  'integration.contract.applied',
] as const;

export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

/** The payload of an integration event. */
export interface IntegrationEventPayload {
  readonly connectionId: string;
  readonly providerKey?: string | undefined;
  readonly mappingId?: string | undefined;
  readonly runId?: string | undefined;
  readonly crmEntityType?: string | undefined;
  readonly crmEntityId?: string | undefined;
  readonly externalId?: string | undefined;
  /** A stable reference, e.g. a conflict id or an enrichment result id. */
  readonly referenceId?: string | undefined;
  /** The correlation id of the run or delivery. */
  readonly correlationId?: string | undefined;
}

@Injectable()
export class IntegrationEventPublisher {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /**
   * Publish one integration event.
   *
   * The event type must be one the module publishes. An unknown type is a programming error and
   * is refused loudly rather than published as a one-off domain event.
   */
  async publish(
    eventType: IntegrationEventType,
    payload: IntegrationEventPayload,
  ): Promise<string | null> {
    if (!(INTEGRATION_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new Error(`"${eventType}" is not an integration event this module publishes.`);
    }
    const ids = await this.outbox.insertMany(this.database.db, [
      { eventType, payload: { ...payload } },
    ]);
    return ids[0] ?? null;
  }

  /**
   * Publish an event inside an existing transaction.
   *
   * The event is then part of the same commit as the change it describes — which is the whole
   * point of the outbox.
   */
  async publishIn(
    tx: Parameters<OutboxService['insertMany']>[0],
    eventType: IntegrationEventType,
    payload: IntegrationEventPayload,
  ): Promise<string | null> {
    if (!(INTEGRATION_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new Error(`"${eventType}" is not an integration event this module publishes.`);
    }
    const ids = await this.outbox.insertMany(tx, [{ eventType, payload: { ...payload } }]);
    return ids[0] ?? null;
  }
}
