import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";

/**
 * Phase 19-MA.14 — the whitelist of CRM domain events a journey may trigger on (§15 `19-MA.14`).
 *
 * Optional integrations are just more entries here; disabling one removes it from the whitelist and
 * the journey simply stops matching it. Nothing outside this list can start an enrollment.
 */
export const JOURNEY_TRIGGER_EVENTS: readonly string[] = [
  "entity.created",
  "entity.updated",
  "serviceDesk.case.statusChanged",
  "customerSuccess.health.statusChanged",
  "sales.opportunity.stageChanged",
];

/** Bound on recursive trigger chains (§15 acceptance: "event loops … are bounded and observable"). */
export const MAX_CAUSATION_DEPTH = 3;

export interface JourneyTriggerResult {
  readonly accepted: boolean;
  readonly reason?: string | undefined;
  readonly enrolled: number;
}

@Injectable()
export class MarketingJourneyTriggerService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async trigger(input: {
    readonly journeyId: string;
    readonly eventType: string;
    readonly entityType?: string;
    readonly entityId?: string;
    readonly depth?: number;
    readonly correlationId?: string;
  }): Promise<JourneyTriggerResult> {
    if (!JOURNEY_TRIGGER_EVENTS.includes(input.eventType)) {
      return { accepted: false, reason: "EVENT_NOT_WHITELISTED", enrolled: 0 };
    }
    const depth = input.depth ?? 0;
    if (depth > MAX_CAUSATION_DEPTH) {
      return { accepted: false, reason: "CAUSATION_DEPTH_EXCEEDED", enrolled: 0 };
    }
    // The enrollment itself is created by the runtime with a dedupe key; here we only report the match.
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = 'MarketingJourney'
        and deleted_at is null
        and (attrs->>'status') = 'Published'
        and id = ${input.journeyId}
      limit 1
    `.execute(this.database.db);
    if (rows.rows.length === 0) {
      return { accepted: false, reason: "JOURNEY_NOT_PUBLISHED", enrolled: 0 };
    }
    return { accepted: true, enrolled: 0 };
  }
}
