import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";

@Injectable()
export class MarketingDeliveryBatchService {
  constructor(@Inject(DatabaseService) private readonly db: any) {}

  /** Claim and return eligible recipient rows for the given send and slot. */
  async run(sendId: string, slot: number) {
    const now = new Date().toISOString();

    // Claim eligible rows: transition from Eligible/Queued to Sending
    const claimed = await this.db.$executeQuery(
      sql`
        update marketing_recipient_deliveries
        set state = 'Sending',
            error_code = null,
            failed_at = null,
            updated_at = ${now}
        where send_id = ${sendId}
          and slot = ${slot}
          and state in ('Eligible', 'Queued')
        returning send_id, slot, entity_type, entity_id, email_hash, state, error_code, attempts
        limit 100
      `
    );

    const claimedRows = (claimed as Record<string, unknown>[]);

    if (!claimedRows || claimedRows.length === 0) {
      return { status: 'completed', message: 'No eligible recipients to claim', claimed: 0 };
    }

    // Mark the claimed rows as processed (the worker will update final state)
    const requeued = await this.db.$executeQuery(
      sql`
        update marketing_recipient_deliveries
        set state = 'Queued',
            updated_at = ${now}
        where (send_id, slot, entity_type, entity_id) in (
          select send_id, slot, entity_type, entity_id
          from jsonb_to_recordset(${JSON.stringify(claimedRows)}) as x(
            send_id text,
            slot int,
            entity_type text,
            entity_id text,
            email_hash text,
            state text,
            error_code text,
            attempts int
          )
        )
        and state = 'Sending'
      `
    );

    const requeuedCount = Number((requeued as Record<string, unknown>).rowCount ?? 0);

    return {
      status: 'completed',
      message: `Claimed ${String(claimedRows.length)} recipient(s), ${String(requeuedCount)} transitioned to Queued`,
      claimed: claimedRows.length,
    };
  }
}