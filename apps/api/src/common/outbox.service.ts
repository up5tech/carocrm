import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { Db, DbTx } from '../database/database.service.js';
import type { RequestScope } from './request-scope.js';
import { REQUEST_SCOPE_TOKEN } from './request-scope.js';

export interface OutboxInsert {
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(@Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope) {}

  async insertMany(tx: Db | DbTx, events: OutboxInsert[]): Promise<string[]> {
    if (events.length === 0) return [];
    const ids = events.map(() => randomUUID());
    const requestId = this.scope.requestId;
    const correlationId = requestId === '' || requestId === 'unknown' ? null : requestId.slice(0, 120);
    await tx
      .insertInto('outbox_events')
      .values(
        events.map((event, index) => ({
          id: ids[index] as string,
          event_type: event.eventType,
          payload: JSON.stringify(event.payload),
          status: 'pending',
          attempts: 0,
          available_at: new Date(),
          created_at: new Date(),
          last_error: null,
          processed_at: null,
          correlation_id: correlationId,
        })),
      )
      .execute();
    return ids;
  }
}

export const OUTBOX_SERVICE = Symbol('OUTBOX_SERVICE');
