import { NotFoundError,ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { CASE_ENTITY } from "./service-desk-domain.js";
import { ServiceDeskRecords } from "./service-desk-records.js";

@Injectable()
export class CaseMergeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ServiceDeskRecords) private readonly records: ServiceDeskRecords,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  /** Candidate duplicate cases (same account/contact, similar subject prefix). */
  async duplicateCandidates(caseId: string): Promise<string[]> {
    const row = await this.records.byId(CASE_ENTITY, caseId);
    if (row === undefined) throw new NotFoundError(`Case "${caseId}" does not exist.`);
    const accountId = typeof row.data["accountId"] === "string" ? (row.data["accountId"] as string) : null;
    const contactId = typeof row.data["contactId"] === "string" ? (row.data["contactId"] as string) : null;
    const subject = String(row.data["name"] ?? "").toLowerCase().slice(0, 40);
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select("id")
      .where("entity_type", "=", CASE_ENTITY)
      .where("deleted_at", "is", null)
      .where("id", "!=", caseId)
      .execute();
    const candidates: string[] = [];
    for (const r of rows) {
      const full = await this.records.byId(CASE_ENTITY, String(r.id));
      if (full === undefined) continue;
      if (full.data["mergedIntoCaseId"]) continue;
      const sameAcct = accountId !== null && full.data["accountId"] === accountId;
      const sameContact = contactId !== null && full.data["contactId"] === contactId;
      if (!sameAcct && !sameContact) continue;
      const otherSubject = String(full.data["name"] ?? "").toLowerCase().slice(0, 40);
      if (subject.length > 0 && otherSubject.startsWith(subject.slice(0, 20))) candidates.push(String(r.id));
    }
    return candidates;
  }

  async merge(sourceId: string, targetId: string): Promise<{ merged: boolean }> {
    if (sourceId === targetId) throw new ValidationError("A case cannot be merged into itself.");
    const source = await this.records.byId(CASE_ENTITY, sourceId);
    const target = await this.records.byId(CASE_ENTITY, targetId);
    if (source === undefined) throw new NotFoundError(`Case "${sourceId}" does not exist.`);
    if (target === undefined) throw new NotFoundError(`Case "${targetId}" does not exist.`);
    if (source.data["mergedIntoCaseId"]) throw new ValidationError("This case is already merged.");
    await runInTransaction(this.database.db, async (tx) => {
      await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({ mergedIntoCaseId: targetId, status: "Cancelled" })}::jsonb, modified_at = now() WHERE id = ${sourceId}`.execute(this.database.db);
      await this.events.dispatchMany(tx, [{ type: "serviceDesk.case.merged", payload: { sourceCaseId: sourceId, targetCaseId: targetId } }]);
    });
    return { merged: true };
  }
}