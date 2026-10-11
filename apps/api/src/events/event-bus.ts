import type { DomainEventInput } from '@carocrm/core/domain-events/index.js';
import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service.js';
import type { Db, DbTx } from '../database/database.service.js';

const EVENT_TYPE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/;

/**
 * The write side of the domain-event bus (PLAN §23.2). Dispatching takes the caller's transaction,
 * so the event row is committed together with the data that caused it — the failure mode the
 * transactional outbox exists to avoid (commit succeeds, publish fails) cannot happen here.
 */
@Injectable()
export class EventBus {
  constructor(@Inject(OutboxService) private readonly outbox: OutboxService) {}

  async dispatch(tx: Db | DbTx, event: DomainEventInput): Promise<string> {
    const [id] = await this.dispatchMany(tx, [event]);
    return id ?? '';
  }

  async dispatchMany(tx: Db | DbTx, events: readonly DomainEventInput[]): Promise<string[]> {
    for (const event of events) {
      if (!EVENT_TYPE.test(event.type)) {
        throw new ValidationError(`Invalid domain event type "${event.type}".`, { type: event.type });
      }
    }
    return this.outbox.insertMany(tx, events.map((event) => ({ eventType: event.type, payload: event.payload })));
  }
}
