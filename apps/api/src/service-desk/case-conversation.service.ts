import { AuthorizationDeniedError, FeatureDisabledError, NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import type { StreamItemDto, StreamVisibility } from "../stream/index.js";
import { StreamService } from "../stream/stream.service.js";
import { CASE_ENTITY } from "./service-desk-domain.js";
import { runAsServiceDeskInternal } from "./service-desk-internal.js";
import { ServiceDeskNotificationService } from "./service-desk-notification.service.js";
import { ServiceDeskRecords, type ServiceDeskRow } from "./service-desk-records.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";
import { SlaService } from "./sla.service.js";

/**
 * Phase 19-SD.6 — case conversation: public replies, internal notes and the visibility-safe timeline
 * (PLAN_Phase_19_ServiceDesk.md §5.4, §7.1, §8.2, acceptance "Agents can create public and internal
 * entries according to permission" / "Portal APIs can never return internal content").
 *
 * This service adds *no* second conversation store: a public reply and an internal note are two
 * visibilities of the same generic Stream item, so the timeline, mentions, attachments and
 * notifications are the kernel's and stay in one place (AGENTS.md §5.1). The two commands differ
 * only in the visibility they fix — a caller cannot post an "internal note" that is really public,
 * or a "reply" the customer never sees.
 *
 * Record ACL is enforced by `StreamService` (read + stream on the Case) and the commands are
 * agent-only: a portal user reaches the conversation through its own surface, which the platform
 * scopes to customer-visible entries. Internal notes never move a response clock, so an internal
 * note can never satisfy the first-response SLA (§5.6) — only a public reply does.
 *
 * Every write happens in one transaction with the stream item, the response stamps, the history-free
 * domain event and the (best-effort) notification, so a failure leaves no partial conversation entry.
 */

export interface CaseMessageInput {
  readonly text: string;
  readonly attachmentIds?: readonly string[] | undefined;
  readonly mentionIds?: readonly string[] | undefined;
  /** Optional command idempotency: a retry with the same key returns the existing entry (§12.3). */
  readonly idempotencyKey?: string | undefined;
}

export interface CaseMessageResult {
  readonly caseId: string;
  readonly messageId: string;
  readonly visibility: StreamVisibility;
  /** False when an idempotent retry returned an entry this command already created. */
  readonly created: boolean;
}

export interface CaseConversationCapabilities {
  readonly caseId: string;
  readonly canReply: boolean;
  readonly canPostInternalNote: boolean;
  readonly canViewInternal: boolean;
}

export interface CaseConversationTimeline {
  readonly list: StreamItemDto[];
  readonly total: number;
  readonly offset: number;
  readonly count: number;
}

@Injectable()
export class CaseConversationService {
  constructor(
    @Inject(ServiceDeskRecords) private readonly records: ServiceDeskRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(ServiceDeskNotificationService) private readonly notifications: ServiceDeskNotificationService,
    @Inject(StreamService) private readonly stream: StreamService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SlaService) private readonly sla: SlaService,
  ) {}

  /** Post a customer-visible reply (§8.2 `POST /cases/:id/reply`). */
  async reply(caseId: string, input: CaseMessageInput): Promise<CaseMessageResult> {
    return this.post(caseId, input, "public");
  }

  /** Post an internal-only note (§8.2 `POST /cases/:id/note`); never customer-visible. */
  async note(caseId: string, input: CaseMessageInput): Promise<CaseMessageResult> {
    return this.post(caseId, input, "internal");
  }

  /**
   * The case timeline as the current actor may see it: a portal principal receives only
   * customer-visible entries, an agent receives everything, oldest first.
   */
  async timeline(caseId: string, options: { maxSize: number; offset: number }): Promise<CaseConversationTimeline> {
    await this.requireCase(caseId);
    return this.stream.listForRecord(CASE_ENTITY, caseId, {
      maxSize: options.maxSize,
      offset: options.offset,
      order: "asc",
    });
  }

  /** What the current actor may do on this case's conversation — the SPA renders exactly this. */
  async capabilities(caseId: string): Promise<CaseConversationCapabilities> {
    // Loads through the ACL-aware entity service, so an unreadable case is refused here.
    await this.entities.get(CASE_ENTITY, caseId);
    const principal = this.scope.requirePrincipal();
    const settings = await this.settings.settings();
    const internal = principal.userType !== "portal";
    const canWrite = settings.features.caseManagement && internal && (await this.stream.canStream(CASE_ENTITY, caseId));
    return {
      caseId,
      canReply: canWrite,
      canPostInternalNote: canWrite,
      canViewInternal: internal,
    };
  }

  private async post(caseId: string, input: CaseMessageInput, visibility: "public" | "internal"): Promise<CaseMessageResult> {
    const actor = this.scope.requirePrincipal();
    if (actor.userType === "portal") {
      throw new AuthorizationDeniedError("Case conversation commands are staff-only.", { caseId });
    }
    const settings = await this.settings.settings();
    if (!settings.features.caseManagement) throw new FeatureDisabledError("caseManagement");

    const row = await this.requireCase(caseId);
    const body = input.text.trim();
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (body === "" && attachmentIds.length === 0) {
      throw new ValidationError("A conversation entry needs text or an attachment.", { caseId });
    }

    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey !== "") {
      const prior = await this.findByKey(caseId, idempotencyKey);
      if (prior !== undefined) {
        return { caseId, messageId: prior, visibility, created: false };
      }
    }

    const now = new Date();
    const messageId = await runInTransaction(this.database.db, async (tx) => {
      const message = await this.stream.create(CASE_ENTITY, caseId, {
        type: visibility === "public" ? "Post" : "Note",
        ...(visibility === "public" ? { post: body } : { notes: body }),
        visibility,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(input.mentionIds !== undefined ? { mentionIds: [...input.mentionIds] } : {}),
        ...(idempotencyKey !== undefined && idempotencyKey !== "" ? { idempotencyKey } : {}),
      });
      await runAsServiceDeskInternal(() =>
        this.entities.update(
          CASE_ENTITY,
          caseId,
          visibility === "public" ? this.replyStamp(row.data, now) : { lastActivityAt: now.toISOString() },
        ),
      );
      await this.events.dispatchMany(tx, [
        {
          type: visibility === "public" ? "serviceDesk.case.replySent" : "serviceDesk.case.noteAdded",
          payload: {
            caseId,
            caseNumber: text(row.data["caseNumber"]) ?? null,
            messageId: message.id,
            visibility,
            actorUserId: actor.userId,
            actorType: actor.userType,
          },
        },
      ]);
      return message.id;
    });

    // Only a public reply reaches the customer's world, so only a public reply notifies the internal
    // watchers. Generation is best-effort and outside the transaction, like assignment (§12.3).
    if (visibility === "public") {
      await this.notifyReply(caseId, row.data, messageId, actor.userId);
      await this.sla.onPublicReply(caseId).catch(() => undefined);
    }

    return { caseId, messageId, visibility, created: true };
  }

  /**
   * The stamps a *public agent reply* moves (§5.6). `firstResponseAt` is set once, by the first
   * public reply — an internal note never reaches this code, which is exactly what makes "internal
   * notes do not count as public responses for SLA metrics" true.
   */
  private replyStamp(rowData: Record<string, unknown>, now: Date): Record<string, unknown> {
    const patch: Record<string, unknown> = {
      lastActivityAt: now.toISOString(),
      lastAgentResponseAt: now.toISOString(),
    };
    if (text(rowData["firstResponseAt"]) === undefined) patch["firstResponseAt"] = now.toISOString();
    return patch;
  }

  private async notifyReply(
    caseId: string,
    rowData: Record<string, unknown>,
    messageId: string,
    actorUserId: string,
  ): Promise<void> {
    try {
      const candidates = new Set<string>(await this.records.followerIds(CASE_ENTITY, caseId));
      const assignee = text(rowData["assignedUserId"]);
      if (assignee !== undefined) candidates.add(assignee);
      candidates.delete(actorUserId);
      if (candidates.size === 0) return;
      // Internal, active users only: a portal watcher is never told about case activity here.
      const recipients = await this.records.activeUserIds([...candidates]);
      if (recipients.size === 0) return;
      for (const userId of recipients) {
        await this.notifications.publicReply({
          userId,
          caseId,
          caseNumber: text(rowData["caseNumber"]) ?? null,
          subject: text(rowData["name"]) ?? null,
          actorUserId,
          dedupKey: messageId,
        });
      }
    } catch {
      // A failed notification is observable through module health, not fatal to the reply.
    }
  }

  private async findByKey(caseId: string, idempotencyKey: string): Promise<string | undefined> {
    const rows = await sql<{ id: string }>`
      select id from stream_items
      where entity_type = ${CASE_ENTITY} and entity_id = ${caseId}
        and is_deleted = false and (data ->> 'idempotencyKey') = ${idempotencyKey}
      order by created_at asc
      limit 1
    `.execute(this.database.db);
    return rows.rows[0]?.id;
  }

  private async requireCase(caseId: string): Promise<ServiceDeskRow> {
    const row = await this.records.byId(CASE_ENTITY, caseId);
    if (row === undefined) throw new NotFoundError(`Case "${caseId}" does not exist.`);
    return row;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
