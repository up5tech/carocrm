import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';

/**
 * Phase 19-INT.13 — the origin of a CRM change
 * (`PLAN_Phase_19_Advanced_Integrations.md` §11.6; `19-INT.13`).
 *
 * This is how an **echo** is prevented. Without it, an inbound sync writes a CRM record, the
 * write produces a domain event, the event produces an outbound operation, and the outbound
 * operation pushes the record back to the provider — forever.
 *
 * The rule is simple: the platform records **who** last changed a record, and the outbound path
 * skips a record whose last change came from a sync on that same connection.
 *
 * The origin is deliberately separate from the record itself. It is not part of the record's
 * data, it is not shown to an operator, and it cannot be forged by a user editing a record.
 */

export const RECORD_ORIGINS = ['inbound_sync', 'outbound_sync', 'user'] as const;
export type RecordOrigin = (typeof RECORD_ORIGINS)[number];

export interface RecordOriginRow {
  readonly entityType: string;
  readonly entityId: string;
  readonly connectionId: string;
  readonly mappingId: string | null;
  readonly origin: RecordOrigin;
  readonly originRef: string | null;
  readonly recordedAt: string;
}

@Injectable()
export class RecordOriginService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Record that a change to a CRM record came from somewhere. */
  async record(input: {
    entityType: string;
    entityId: string;
    connectionId: string;
    mappingId?: string | null | undefined;
    origin: RecordOrigin;
    originRef?: string | null | undefined;
  }): Promise<void> {
    await sql`
      insert into integration_record_origins
        (entity_type, entity_id, connection_id, mapping_id, origin, origin_ref, recorded_at)
      values
        (${input.entityType}, ${input.entityId}, ${input.connectionId}, ${input.mappingId ?? null},
         ${input.origin}, ${input.originRef ?? null}, ${new Date()})
      on conflict (entity_type, entity_id, connection_id) do update set
        mapping_id = excluded.mapping_id,
        origin = excluded.origin,
        origin_ref = excluded.origin_ref,
        recorded_at = excluded.recorded_at
    `.execute(this.database.db);
  }

  /** The origin of the last change to a record on a connection, or `null`. */
  async find(entityType: string, entityId: string, connectionId: string): Promise<RecordOriginRow | null> {
    const rows = await sql<{
      entity_type: string;
      entity_id: string;
      connection_id: string;
      mapping_id: string | null;
      origin: string;
      origin_ref: string | null;
      recorded_at: Date;
    }>`
      select * from integration_record_origins
      where entity_type = ${entityType} and entity_id = ${entityId} and connection_id = ${connectionId}
      limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) return null;
    return {
      entityType: row.entity_type,
      entityId: row.entity_id,
      connectionId: row.connection_id,
      mappingId: row.mapping_id,
      origin: row.origin as RecordOrigin,
      originRef: row.origin_ref,
      recordedAt: row.recorded_at.toISOString(),
    };
  }

  /**
   * Whether the last change to a record came from a sync on this connection.
   *
   * The outbound path calls this before pushing. A record whose last change was a **user** edit
   * is pushed; a record whose last change was a sync is not — that is the echo.
   */
  async isEcho(entityType: string, entityId: string, connectionId: string): Promise<boolean> {
    const origin = await this.find(entityType, entityId, connectionId);
    if (origin === null) return false;
    return origin.origin === 'inbound_sync' || origin.origin === 'outbound_sync';
  }

  /** Forget the origin of a record. Used when a record is unlinked from a connection. */
  async clear(entityType: string, entityId: string, connectionId: string): Promise<void> {
    await sql`
      delete from integration_record_origins
      where entity_type = ${entityType} and entity_id = ${entityId} and connection_id = ${connectionId}
    `.execute(this.database.db);
  }
}
