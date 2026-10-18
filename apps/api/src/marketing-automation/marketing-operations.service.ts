import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";

/**
 * Phase 19-MA.18 — operational diagnostics (§15 `19-MA.18`): provider health, stuck sends and
 * delivery dead letters, without exposing secrets or recipient PII.
 */
export interface MarketingDiagnostics {
  readonly generatedAt: string;
  readonly deliveryStates: Readonly<Record<string, number>>;
  readonly deadLetters: number;
  readonly stuckSending: number;
}

@Injectable()
export class MarketingOperationsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async diagnostics(): Promise<MarketingDiagnostics> {
    const generatedAt = new Date().toISOString();
    const rows = await sql<{ state: string; count: string }>`
      select state, count(*)::text as count from marketing_recipient_deliveries group by state
    `.execute(this.database.db);
    const states: Record<string, number> = {};
    for (const r of rows.rows) states[r.state] = Number(r.count);
    const dead = await sql<{ count: string }>`
      select count(*)::text as count from marketing_recipient_deliveries where state = 'Failed'
    `.execute(this.database.db);
    const stuck = await sql<{ count: string }>`
      select count(*)::text as count from marketing_recipient_deliveries
      where state = 'Sending' and (claimed_at is null or claimed_at < now() - interval '10 minutes')
    `.execute(this.database.db);
    return {
      generatedAt,
      deliveryStates: states,
      deadLetters: Number(dead.rows[0]?.count ?? "0"),
      stuckSending: Number(stuck.rows[0]?.count ?? "0"),
    };
  }
}
