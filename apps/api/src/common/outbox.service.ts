import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { Db, DbTx } from '../database/database.service.js';

export interface OutboxInsert {
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  async insertMany(tx: Db | DbTx, events: OutboxInsert[]): Promise<string[]> {
    if (events.length === 0) return [];
    const ids = events.map(() => randomUUID());
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
        })),
      )
      .execute();
    return ids;
  }
}

export const OUTBOX_SERVICE = Symbol('OUTBOX_SERVICE');
