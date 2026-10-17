import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { currentTx } from "../entity/tx-context.js";
import { formatCaseNumber } from "./service-desk-domain.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.3 — transaction-safe case numbering
 * (PLAN_Phase_19_ServiceDesk.md §5.1 invariants, §7.3 concurrency).
 *
 * A case number must be unique even under concurrent creation, and must never be produced by
 * counting existing rows. The platform already has the right primitive: a Postgres sequence, whose
 * `nextval` is atomic and non-repeating across sessions and transactions, so two simultaneous
 * creations can never receive the same value. The value is only *formatted* here; the sequence — not
 * application code — guarantees uniqueness, and migration `033_phase19_service_desk.sql` backs it
 * with a unique index on the stored number.
 *
 * A sequence is deliberately not gapless: a create that fails after allocation consumes its value.
 * Ticket numbers reading with small gaps is normal and preferable to a lock that serialises every
 * case creation.
 */

export const CASE_NUMBER_SEQUENCE = "service_desk_case_number_seq";

export interface CaseNumberAllocation {
  /** The raw sequence value, unique across all cases. */
  readonly value: string;
  /** The stored, displayable case number (prefix + zero-padded value). */
  readonly formatted: string;
}

export interface CaseNumberPreview {
  readonly format: string;
  readonly prefix: string;
  readonly padding: number;
}

@Injectable()
export class CaseNumberingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
  ) {}

  /** Inside a domain command this runs on the command's own transaction. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  /** Allocate the next case number. Atomic: the database issues the value, never this process. */
  async allocate(): Promise<CaseNumberAllocation> {
    const { prefix, padding } = (await this.settings.read()).settings.numbering;
    const rows = await sql<{ value: string }>`
      select nextval(${CASE_NUMBER_SEQUENCE})::text as value
    `.execute(this.db);
    const value = rows.rows[0]?.value;
    if (value === undefined) throw new Error("The case number sequence returned no value.");
    return { value, formatted: formatCaseNumber(prefix, value, padding) };
  }

  /** The number the next allocation would produce, without consuming it. */
  async preview(): Promise<CaseNumberPreview> {
    const { prefix, padding } = (await this.settings.read()).settings.numbering;
    const rows = await sql<{ last_value: string; is_called: boolean }>`
      select last_value::text as last_value, is_called from ${sql.table(CASE_NUMBER_SEQUENCE)}
    `.execute(this.db);
    const row = rows.rows[0];
    const last = row === undefined ? 0n : BigInt(row.last_value);
    const next = row?.is_called === true ? last + 1n : last === 0n ? 1n : last;
    return {
      format: formatCaseNumber(prefix, next, padding),
      prefix,
      padding,
    };
  }
}
