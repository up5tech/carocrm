import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { runAsServiceDeskSystem } from "./service-desk-authority.js";
import { CASE_ENTITY } from "./service-desk-domain.js";
import { runAsServiceDeskInternal } from "./service-desk-internal.js";

const MAX_DUPLICATE_SCAN = 200;
const MAX_DUPLICATE_RESULTS = 10;

@Injectable()
export class CaseMergeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  /**
   * Candidate duplicates (same Account/Contact, related subject). The source is loaded through the
   * ACL-aware entity service and each candidate is re-read through it too, so an agent never learns
   * the ids of cases they cannot see (§10.5 IDOR / information disclosure).
   */
  async duplicateCandidates(caseId: string): Promise<string[]> {
    const source = await this.entities.get(CASE_ENTITY, caseId);
    const accountId = typeof source["accountId"] === "string" ? (source["accountId"] as string) : null;
    const contactId = typeof source["contactId"] === "string" ? (source["contactId"] as string) : null;
    if (accountId === null && contactId === null) return [];
    const subject = String(source["name"] ?? "").toLowerCase().slice(0, 40);
    const identity = [
      ...(accountId !== null ? [sql<boolean>`attrs ->> 'accountId' = ${accountId}`] : []),
      ...(contactId !== null ? [sql<boolean>`attrs ->> 'contactId' = ${contactId}`] : []),
    ];
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "name", "attrs"])
      .where("entity_type", "=", CASE_ENTITY)
      .where("deleted_at", "is", null)
      .where("id", "!=", caseId)
      .where(sql<boolean>`(${sql.join(identity, sql` OR `)})`)
      .limit(MAX_DUPLICATE_SCAN)
      .execute();
    const candidates: string[] = [];
    for (const r of rows) {
      if (candidates.length >= MAX_DUPLICATE_RESULTS) break;
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      if (a["mergedIntoCaseId"]) continue;
      const sameAccount = accountId !== null && a["accountId"] === accountId;
      const sameContact = contactId !== null && a["contactId"] === contactId;
      if (!sameAccount && !sameContact) continue;
      const otherSubject = String(r.name ?? a["name"] ?? "").toLowerCase().slice(0, 40);
      if (subject !== "" && !otherSubject.startsWith(subject.slice(0, 20))) continue;
      // ACL check: an inaccessible candidate is simply not returned.
      try {
        await this.entities.get(CASE_ENTITY, String(r.id));
      } catch {
        continue;
      }
      candidates.push(String(r.id));
    }
    return candidates;
  }

  /**
   * Merge `sourceId` into `targetId` (§5.11, SD.14). Both cases must be readable, the source must be
   * editable, and the operation is atomic: the source is cancelled, its history records the merge
   * command, the target keeps its own history, and the domain event is enqueued in the same
   * transaction. A closed/cancelled case or an already-merged source is refused.
   */
  async merge(sourceId: string, targetId: string): Promise<{ merged: boolean; transitionId: string }> {
    if (sourceId === targetId) throw new ValidationError("A case cannot be merged into itself.");
    const source = await this.entities.get(CASE_ENTITY, sourceId);
    await this.entities.get(CASE_ENTITY, targetId);
    await this.acl.assertRecordAccess(CASE_ENTITY, "edit", {
      id: sourceId,
      assignedUserId: typeof source["assignedUserId"] === "string" ? (source["assignedUserId"] as string) : undefined,
      createdById: typeof source["createdById"] === "string" ? (source["createdById"] as string) : undefined,
      teams: Array.isArray(source["teams"]) ? (source["teams"] as string[]) : [],
      data: source,
    });
    const status = String(source["status"] ?? "New");
    if (status === "Closed" || status === "Cancelled") {
      throw new ValidationError("A closed or cancelled case cannot be merged.", { code: "CASE_MERGE_NOT_ALLOWED", sourceId, status });
    }
    if (source["mergedIntoCaseId"] !== undefined && source["mergedIntoCaseId"] !== null) {
      throw new ValidationError("This case is already merged.", { code: "CASE_ALREADY_MERGED", sourceId });
    }

    const actor = this.scope.requirePrincipal();
    const now = new Date();
    const transitionId = await runInTransaction(this.database.db, async (tx) => {
      await runAsServiceDeskInternal(() =>
        this.entities.update(CASE_ENTITY, sourceId, { status: "Cancelled", mergedIntoCaseId: targetId }),
      );
      const history = await runAsServiceDeskSystem(this.scope, "caseMergeHistory", () =>
        this.entities.create("CaseTransition", {
          caseId: sourceId,
          caseNumber: typeof source["caseNumber"] === "string" ? source["caseNumber"] : null,
          fromStatus: status,
          toStatus: "Cancelled",
          command: "merge",
          reason: `Merged into case ${targetId}.`,
          actorUserId: actor.userId,
          actorType: actor.userType,
          occurredAt: now.toISOString(),
        }),
      );
      await this.events.dispatchMany(tx, [
        { type: "serviceDesk.case.merged", payload: { sourceCaseId: sourceId, targetCaseId: targetId } },
      ]);
      return String(history["id"]);
    });
    return { merged: true, transitionId };
  }
}
