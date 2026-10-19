import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';

/**
 * Phase 19-VC.17 — CRM panels: communication history in the record's own context
 * (`PLAN_Phase_19_Voice_Communications.md` §10.4, §15 `19-VC.17`).
 *
 * Rules:
 *  - **Record-ACL aware.** The panel refuses anything the caller cannot read through the entity
 *    service, and the entity list decides the scope — the panel never widens it.
 *  - **Lazy by construction.** The panel returns conversation/call summaries with pagination; message
 *    bodies, media and transcripts are loaded through their own endpoints when a row is opened.
 *  - **No duplicate Activities.** The panel only reads. The single Call Activity per session is
 *    created by the calls service (19-VC.7), and Customer Success consumes events, not records — so
 *    a consumer never materializes a second Activity.
 */

const PANEL_ENTITY_LEVELS = new Set(['Account', 'Contact', 'Lead', 'Opportunity', 'Case']);

export interface PanelConversationView {
  readonly id: string;
  readonly channel: string;
  readonly status: string;
  readonly subject: string | null;
  readonly externalThreadId: string | null;
  readonly unreadCount: number;
  readonly lastActivityAt: string | null;
  readonly caseId: string | null;
}

export interface PanelCallView {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly state: string;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  readonly startedAt: string | null;
  readonly durationSeconds: number | null;
  readonly activityId: string | null;
}

@Injectable()
export class VoicePanelService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  /**
   * Everything the CRM panel shows for one record: recent conversations and calls, one page at a
   * time. Record access is the entity service's verdict, so a hidden record yields "not found"
   * rather than an empty panel that confirms existence.
   */
  async forRecord(
    entityType: string,
    entityId: string,
    query: { readonly limit: number; readonly offset: number },
  ): Promise<{
    readonly record: { readonly entityType: string; readonly id: string };
    readonly conversations: readonly PanelConversationView[];
    readonly calls: readonly PanelCallView[];
    readonly total: { readonly conversations: number; readonly calls: number };
  }> {
    if (!PANEL_ENTITY_LEVELS.has(entityType)) {
      throw new ValidationError(`"${entityType}" has no communications panel.`, { supported: [...PANEL_ENTITY_LEVELS] });
    }
    // ACL comes from the entity service: a record this caller cannot read is invisible here.
    await this.entities.get(entityType, entityId);

    const conversations = await sql<{
      id: string;
      channel: string;
      status: string;
      subject: string | null;
      external_thread_id: string | null;
      unread_count: number;
      last_activity_at: Date | null;
      case_id: string | null;
      total: number;
    }>`
      select c.*, count(*) over ()::int as total
      from voice_conversations c
      where c.related_entity_type = ${entityType} and c.related_entity_id = ${entityId}
      order by c.last_activity_at desc nulls last, c.created_at desc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);

    const calls = await sql<{
      id: string;
      direction: string;
      state: string;
      from_number: string | null;
      to_number: string | null;
      started_at: Date | null;
      duration_seconds: number | null;
      activity_id: string | null;
      total: number;
    }>`
      select s.*, count(*) over ()::int as total
      from voice_call_sessions s
      where s.related_entity_type = ${entityType} and s.related_entity_id = ${entityId}
      order by s.created_at desc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);

    return {
      record: { entityType, id: entityId },
      conversations: conversations.rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        subject: row.subject,
        externalThreadId: row.external_thread_id,
        unreadCount: row.unread_count,
        lastActivityAt: row.last_activity_at === null ? null : new Date(row.last_activity_at).toISOString(),
        caseId: row.case_id,
      })),
      calls: calls.rows.map((row) => ({
        id: row.id,
        direction: row.direction === 'inbound' ? ('inbound' as const) : ('outbound' as const),
        state: row.state,
        fromNumber: row.from_number,
        toNumber: row.to_number,
        startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
        durationSeconds: row.duration_seconds,
        activityId: row.activity_id,
      })),
      total: {
        conversations: conversations.rows[0]?.total ?? 0,
        calls: calls.rows[0]?.total ?? 0,
      },
    };
  }

  /**
   * The touchpoint summary Customer Success may consume (§10.5): counts and recency only, for a
   * record the module already resolved under the caller's authority. No message content crosses.
   */
  async touchpoints(entityType: string, entityId: string): Promise<{
    readonly conversations: number;
    readonly calls: number;
    readonly lastInboundAt: string | null;
    readonly lastOutboundAt: string | null;
  }> {
    if (!PANEL_ENTITY_LEVELS.has(entityType)) throw new ValidationError(`"${entityType}" has no communications panel.`);
    await this.entities.get(entityType, entityId);
    const conversationStats = (
      await sql<{ total: number; last_inbound: Date | null; last_outbound: Date | null }>`
        select count(*)::int as total,
               max(c.last_inbound_at) as last_inbound,
               max(c.last_activity_at) as last_outbound
        from voice_conversations c
        where c.related_entity_type = ${entityType} and c.related_entity_id = ${entityId}
      `.execute(this.database.db)
    ).rows[0];
    const callStats = (
      await sql<{ total: number }>`
        select count(*)::int as total from voice_call_sessions s
        where s.related_entity_type = ${entityType} and s.related_entity_id = ${entityId}
      `.execute(this.database.db)
    ).rows[0];
    return {
      conversations: conversationStats?.total ?? 0,
      calls: callStats?.total ?? 0,
      lastInboundAt: conversationStats?.last_inbound === null || conversationStats?.last_inbound === undefined
        ? null
        : new Date(conversationStats.last_inbound).toISOString(),
      lastOutboundAt: conversationStats?.last_outbound === null || conversationStats?.last_outbound === undefined
        ? null
        : new Date(conversationStats.last_outbound).toISOString(),
    };
  }

  /** Attach a conversation to a record the agent may edit — the "log this to the Account" action. */
  async linkConversation(conversationId: string, entityType: string, entityId: string): Promise<{ readonly linked: boolean }> {
    await this.acl.assertAccess('CommunicationConversation', 'edit');
    if (!PANEL_ENTITY_LEVELS.has(entityType)) throw new ValidationError(`"${entityType}" is not a panel entity.`);
    const conversation = (
      await sql<{ id: string; related_entity_type: string | null; related_entity_id: string | null }>`
        select id, related_entity_type, related_entity_id from voice_conversations where id = ${conversationId}
      `.execute(this.database.db)
    ).rows[0];
    if (conversation === undefined) throw new NotFoundError(`Conversation "${conversationId}" does not exist.`);
    await this.entities.get(entityType, entityId);
    await sql`
      update voice_conversations
      set related_entity_type = ${entityType}, related_entity_id = ${entityId}, modified_at = now()
      where id = ${conversationId}
    `.execute(this.database.db);
    return { linked: true };
  }
}
