import { randomUUID } from 'node:crypto';

import { ConcurrencyConflictError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { EventBus } from '../events/event-bus.js';

/**
 * Phase 19-VC.12 + 19-VC.13 — the unified inbox domain: conversation listing, timeline, read
 * state, status, assignment history and the Service Desk handoff
 * (`PLAN_Phase_19_Voice_Communications.md` §9, §15 `19-VC.12`/`19-VC.13`).
 *
 * Invariants this file owns:
 *  - **Assignment/status changes keep history.** Every change writes a `voice_conversation_events`
 *    row with the acting user and time; the history is append-only (§9.1 acceptance).
 *  - **Conversation state and Case status stay separate.** Linking or handing off never mutates the
 *    Case, and a conversation status change never touches the linked Case (§9.2).
 *  - **A handoff is idempotent.** The conversation's `case_id` is the deduplication key: a repeated
 *    button click (or a retried request) returns the existing Case instead of creating a second one
 *    (§9.2 acceptance).
 *  - **Internal notes never leave.** They are excluded from any view another surface could consume
 *    as a customer-visible message; only agents with message read access see them, flagged.
 */

/** The synthetic permission the inbox checks until conversations register an entity (VC.12). */
export const CONVERSATION_PERMISSION_ENTITY = 'CommunicationConversation';

const CONVERSATION_STATUSES = [
  'open',
  'pending_customer',
  'pending_internal',
  'resolved',
  'closed',
  'spam',
] as const;
type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface InboxQuery {
  readonly limit: number;
  readonly offset: number;
  readonly status?: string | undefined;
  readonly channel?: string | undefined;
  /** `me` scopes to the caller's own assignments; a team id scopes to that queue. */
  readonly assignee?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  /**
   * 19-OM.10 — the workspace filters the audit found missing on the conversation record. Each maps
   * to a column/index added by migration 077 (queue, snooze, unread) or a plain column
   * (priority, language, tag), so filtering happens in SQL under the caller's ACL and pagination
   * totals stay correct — never by filtering a fetched page on the client.
   */
  readonly priority?: string | undefined;
  readonly language?: string | undefined;
  readonly tag?: string | undefined;
  readonly unreadOnly?: boolean | undefined;
  /** `only` = currently snoozed; `exclude` = not snoozed; omitted = both. */
  readonly snoozed?: 'only' | 'exclude' | undefined;
  readonly queueId?: string | undefined;
}

export interface InboxConversationView {
  readonly id: string;
  readonly accountKey: string;
  readonly channel: string;
  readonly status: string;
  readonly subject: string | null;
  readonly externalThreadId: string | null;
  readonly unreadCount: number;
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
  readonly lastActivityAt: string | null;
  readonly lastInboundAt: string | null;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
  readonly caseId: string | null;
  readonly archived: boolean;
}

export interface TimelineEntryView {
  readonly kind: 'message' | 'event';
  readonly id: string;
  readonly at: string;
  /** Present for a message; `isInternalNote` is true only for agent-visible artefacts. */
  readonly message?: {
    readonly direction: 'inbound' | 'outbound';
    readonly body: string | null;
    readonly state: string;
    readonly isInternalNote: boolean;
    readonly authorUserId: string | null;
    readonly channel: string;
  };
  /** Present for a history event (assignment, status change, case link). */
  readonly event?: {
    readonly kind: string;
    readonly actorUserId: string | null;
    readonly actorType: string;
    readonly fromValue: string | null;
    readonly toValue: string | null;
    readonly detail: string | null;
  };
}

export interface ConversationEventView {
  readonly id: string;
  readonly kind: string;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly detail: string | null;
  readonly createdAt: string;
}

@Injectable()
export class VoiceInboxService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  /** ACL-scoped, indexed inbox listing. Filters map to the indexes created in migration 051. */
  async list(query: InboxQuery): Promise<{ readonly list: readonly InboxConversationView[]; readonly total: number }> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'read');
    const userId = this.scope.userId ?? null;
    // `me` scopes to the caller; `unassigned` scopes to conversations nobody (user or team) owns.
    const unassignedOnly = query.assignee === 'unassigned';
    const assignee = query.assignee === 'me' ? userId : (query.assignee ?? null);
    const rows = await sql<{
      id: string;
      account_key: string;
      channel: string;
      status: string;
      subject: string | null;
      external_thread_id: string | null;
      unread_count: number;
      assigned_user_id: string | null;
      assigned_team_id: string | null;
      last_activity_at: Date | null;
      last_inbound_at: Date | null;
      related_entity_type: string | null;
      related_entity_id: string | null;
      case_id: string | null;
      archived: boolean;
      total: number;
    }>`
      select c.*, count(*) over ()::int as total
      from voice_conversations c
      where (${query.status ?? null}::text is null or c.status = ${query.status ?? null})
        and (${query.channel ?? null}::text is null or c.channel = ${query.channel ?? null})
        and (${unassignedOnly} = false
             or (c.assigned_user_id is null and c.assigned_team_id is null))
        and (${unassignedOnly} = true
             or ${assignee}::text is null
             or c.assigned_user_id = ${assignee}
             or c.assigned_team_id = ${assignee})
        and (${query.includeArchived === true} or c.archived = false)
        and (${query.priority ?? null}::text is null or c.priority = ${query.priority ?? null})
        and (${query.language ?? null}::text is null or c.language = ${query.language ?? null})
        and (${query.tag ?? null}::text is null
             or c.tags @> to_jsonb(array[${query.tag ?? null}]::text[]))
        and (${query.unreadOnly === true} = false or c.unread_count > 0)
        and (
          ${query.snoozed ?? null}::text is null
          or (${query.snoozed ?? null} = 'only' and c.snoozed_until is not null and c.snoozed_until > now())
          or (${query.snoozed ?? null} = 'exclude' and (c.snoozed_until is null or c.snoozed_until <= now()))
        )
        and (${query.queueId ?? null}::text is null or c.current_queue_id = ${query.queueId ?? null})
      order by c.last_activity_at desc nulls last, c.created_at desc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);
    const total = rows.rows[0]?.total ?? 0;
    return { list: rows.rows.map(toInboxView), total };
  }

  /**
   * The conversation timeline: messages and history events merged chronologically. Pagination is
   * cursor-free but bounded; the inbox loads more by offset (lazy loading, §10.4).
   */
  async timeline(
    conversationId: string,
    query: { readonly limit: number; readonly offset: number },
  ): Promise<{ readonly entries: readonly TimelineEntryView[] }> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'read');
    const conversation = await this.requireConversation(conversationId);
    const messages = await sql<{
      id: string;
      direction: string;
      body: string | null;
      state: string;
      is_internal_note: boolean;
      author_user_id: string | null;
      channel: string;
      occurred_at: Date | null;
      created_at: Date;
    }>`
      select id, direction, body, state, is_internal_note, author_user_id, channel, occurred_at, created_at
      from voice_messages
      where conversation_id = ${conversation.id}
      order by coalesce(occurred_at, created_at) asc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);
    const history = await sql<{
      id: string;
      kind: string;
      actor_user_id: string | null;
      actor_type: string;
      from_value: string | null;
      to_value: string | null;
      detail: string | null;
      created_at: Date;
    }>`
      select id, kind, actor_user_id, actor_type, from_value, to_value, detail, created_at
      from voice_conversation_events
      where conversation_id = ${conversation.id}
      order by created_at asc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);

    const entries: (TimelineEntryView & { sortAt: number })[] = [
      ...messages.rows.map((row) => ({
        kind: 'message' as const,
        id: row.id,
        at: iso(row.occurred_at ?? row.created_at) as string,
        sortAt: new Date(row.occurred_at ?? row.created_at).getTime(),
        message: {
          direction: row.direction === 'inbound' ? ('inbound' as const) : ('outbound' as const),
          body: row.body,
          state: row.state,
          isInternalNote: row.is_internal_note,
          authorUserId: row.author_user_id,
          channel: row.channel,
        },
      })),
      ...history.rows.map((row) => ({
        kind: 'event' as const,
        id: row.id,
        at: iso(row.created_at) as string,
        sortAt: new Date(row.created_at).getTime(),
        event: {
          kind: row.kind,
          actorUserId: row.actor_user_id,
          actorType: row.actor_type,
          fromValue: row.from_value,
          toValue: row.to_value,
          detail: row.detail,
        },
      })),
    ];
    entries.sort((left, right) => left.sortAt - right.sortAt || left.id.localeCompare(right.id));
    return { entries: entries.map(({ sortAt: _sortAt, ...rest }) => rest) };
  }

  /** Marking read is an agent action on a conversation this caller may see. */
  async markRead(conversationId: string): Promise<{ readonly unreadCount: number }> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'edit');
    const conversation = await this.requireConversation(conversationId);
    await sql`
      update voice_conversations set unread_count = 0, modified_at = now() where id = ${conversation.id}
    `.execute(this.database.db);
    return { unreadCount: 0 };
  }

  /** A status change records who moved the conversation and from what — and never touches a Case. */
  async setStatus(conversationId: string, status: string, reason?: string | undefined): Promise<InboxConversationView> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'edit');
    if (!(CONVERSATION_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError(`"${status}" is not a conversation status.`, { allowed: CONVERSATION_STATUSES });
    }
    const conversation = await this.requireConversation(conversationId);
    if (conversation.status === status) return toInboxView(conversation);
    await sql`
      update voice_conversations set status = ${status}, modified_at = now() where id = ${conversation.id}
    `.execute(this.database.db);
    await this.recordEvent({
      conversationId: conversation.id,
      kind: 'status_changed',
      actorType: 'user',
      fromValue: conversation.status,
      toValue: status,
      ...(reason !== undefined && reason.trim() !== '' ? { detail: reason.trim() } : {}),
    });
    await this.dispatch('voiceCommunications.conversation.statusChanged', conversation.id, { to: status });
    return toInboxView(await this.requireConversation(conversationId));
  }

  /**
   * Direct assignment to a user or a team queue (§9.2). Round-robin is deliberately absent: there is
   * no reliable capacity signal yet, and manual routing is the documented first step.
   */
  async assign(
    conversationId: string,
    input: {
      readonly userId?: string | null | undefined;
      readonly teamId?: string | null | undefined;
      readonly reason?: string | undefined;
      /** 19-OM.11 — the queue the routing decision placed the conversation in (optional). */
      readonly queueId?: string | null | undefined;
      /**
       * 19-OM.11 — optimistic concurrency: pass the version the caller saw. Two concurrent claims
       * with the same expectation resolve to one authoritative assignment; the loser gets a 409.
       */
      readonly expectedVersion?: number | undefined;
      /** 19-OM.11 — the routing decision, recorded in the append-only history for explainability. */
      readonly routing?: {
        readonly strategy?: string | undefined;
        readonly routingRuleId?: string | null | undefined;
        readonly routingRuleName?: string | null | undefined;
        readonly fallbackReason?: string | null | undefined;
      } | undefined;
    },
  ): Promise<InboxConversationView> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'edit');
    const conversation = await this.requireConversation(conversationId);
    const userId = input.userId ?? null;
    const teamId = input.teamId ?? null;
    const expected = input.expectedVersion ?? null;
    const queueId = input.queueId ?? null;
    if (queueId !== null) {
      const queue = (await sql<{ id: string }>`
        select id from entity_records where id = ${queueId} and entity_type = 'CaseQueue' and deleted_at is null
      `.execute(this.database.db)).rows[0];
      if (queue === undefined) throw new ValidationError(`Queue "${queueId}" does not exist.`);
    }
    const routingDetail =
      input.routing === undefined
        ? undefined
        : JSON.stringify({
            strategy: input.routing.strategy ?? null,
            routingRuleId: input.routing.routingRuleId ?? null,
            routingRuleName: input.routing.routingRuleName ?? null,
            fallbackReason: input.routing.fallbackReason ?? null,
          });
    const detail = [input.reason?.trim(), routingDetail].filter((value): value is string => value !== undefined && value !== '').join(' | ') || undefined;

    if (userId !== null) {
      const user = (await sql<{ id: string }>`select id from users where id = ${userId}`.execute(this.database.db)).rows[0];
      if (user === undefined) throw new ValidationError(`User "${userId}" does not exist.`);
    }
    if (teamId !== null) {
      const team = (await sql<{ id: string }>`select id from teams where id = ${teamId}`.execute(this.database.db)).rows[0];
      if (team === undefined) throw new ValidationError(`Team "${teamId}" does not exist.`);
    }
    if (userId === null && teamId === null) {
      // Unassignment (release): both cleared, recorded as its own history kind.
      const released = await sql<{ id: string }>`
        update voice_conversations
        set assigned_user_id = null, assigned_team_id = null,
            current_queue_id = coalesce(${queueId}, current_queue_id),
            version = version + 1, modified_at = now()
        where id = ${conversation.id}
          and (${expected}::int is null or version = ${expected})
        returning id
      `.execute(this.database.db);
      if (released.rows.length === 0) throw new ConcurrencyConflictError('CommunicationConversation', conversationId);
      await this.recordEvent({
        conversationId: conversation.id,
        kind: 'unassigned',
        actorType: 'user',
        fromValue: conversation.assigned_user_id ?? conversation.assigned_team_id,
        toValue: null,
        ...(detail === undefined ? {} : { detail }),
      });
      return toInboxView(await this.requireConversation(conversationId));
    }

    const assigned = await sql<{ id: string }>`
      update voice_conversations
      set assigned_user_id = ${userId}, assigned_team_id = ${teamId},
          current_queue_id = coalesce(${queueId}, current_queue_id),
          version = version + 1, modified_at = now()
      where id = ${conversation.id}
        and (${expected}::int is null or version = ${expected})
      returning id
    `.execute(this.database.db);
    // Zero rows means the version moved between the caller's read and this write: one claim wins.
    if (assigned.rows.length === 0) throw new ConcurrencyConflictError('CommunicationConversation', conversationId);
    await this.recordEvent({
      conversationId: conversation.id,
      kind: 'assigned',
      actorType: 'user',
      fromValue: conversation.assigned_user_id ?? conversation.assigned_team_id,
      toValue: userId ?? teamId,
      ...(detail === undefined ? {} : { detail }),
    });
    await this.dispatch('voiceCommunications.conversation.assigned', conversation.id, {
      userId,
      teamId,
    });
    return toInboxView(await this.requireConversation(conversationId));
  }

  /** The append-only history: who did what, when (§9.1 acceptance). */
  async history(conversationId: string): Promise<{ readonly list: readonly ConversationEventView[] }> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'read');
    const conversation = await this.requireConversation(conversationId);
    const rows = await sql<{
      id: string;
      kind: string;
      actor_user_id: string | null;
      actor_type: string;
      from_value: string | null;
      to_value: string | null;
      detail: string | null;
      created_at: Date;
    }>`
      select id, kind, actor_user_id, actor_type, from_value, to_value, detail, created_at
      from voice_conversation_events
      where conversation_id = ${conversation.id}
      order by created_at asc
    `.execute(this.database.db);
    return {
      list: rows.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        actorUserId: row.actor_user_id,
        actorType: row.actor_type,
        fromValue: row.from_value,
        toValue: row.to_value,
        detail: row.detail,
        createdAt: iso(row.created_at) as string,
      })),
    };
  }

  /** Point an existing Case at this conversation. Both sides keep their own status. */
  async linkCase(conversationId: string, caseId: string): Promise<InboxConversationView> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'edit');
    const conversation = await this.requireConversation(conversationId);
    // The ACL-aware entity service is the read check: a Case this caller cannot read cannot be linked.
    await this.entities.get('Case', caseId);
    if (conversation.case_id === caseId) return toInboxView(conversation);
    await sql`
      update voice_conversations set case_id = ${caseId}, modified_at = now() where id = ${conversation.id}
    `.execute(this.database.db);
    await this.recordEvent({
      conversationId: conversation.id,
      kind: 'case_linked',
      actorType: 'user',
      fromValue: conversation.case_id,
      toValue: caseId,
    });
    return toInboxView(await this.requireConversation(conversationId));
  }

  /**
   * Create a Case from a conversation (§9.3). Permission comes from the Case entity's own create
   * level, and the conversation's `case_id` makes a repeated click a no-op rather than a duplicate.
   */
  async handoffToCase(
    conversationId: string,
    input: { readonly subject: string; readonly description: string; readonly reason?: string | undefined },
  ): Promise<{ readonly caseId: string; readonly duplicate: boolean }> {
    await this.acl.assertAccess(CONVERSATION_PERMISSION_ENTITY, 'edit');
    await this.acl.assertAccess('Case', 'create');
    const conversation = await this.requireConversation(conversationId);

    // Idempotency: an existing link is the answer, whatever produced it.
    if (conversation.case_id !== null) return { caseId: conversation.case_id, duplicate: true };

    const description = [
      input.description.trim(),
      input.reason !== undefined && input.reason.trim() !== '' ? `Handoff reason: ${input.reason.trim()}` : null,
      `Origin: conversation ${conversation.id} (${conversation.channel})`,
    ]
      .filter((part): part is string => part !== null && part !== '')
      .join('\n\n');
    const created = await this.entities.create('Case', {
      name: input.subject.trim(),
      status: 'New',
      description,
      // Service Desk's own write rule requires a requester; the conversation's counterpart is the
      // natural one, named rather than guessed from a CRM match (§9.3).
      requesterName: conversation.subject?.trim() !== '' && conversation.subject !== null
        ? conversation.subject.trim()
        : `Conversation ${conversation.id}`,
      ...(conversation.assigned_user_id !== null ? { assignedUserId: conversation.assigned_user_id } : {}),
    });
    const caseId = typeof created['id'] === 'string' ? created['id'] : null;
    if (caseId === null) throw new ValidationError('The Case could not be created.');

    await sql`
      update voice_conversations set case_id = ${caseId}, modified_at = now() where id = ${conversation.id}
    `.execute(this.database.db);
    await this.recordEvent({
      conversationId: conversation.id,
      kind: 'case_linked',
      actorType: 'user',
      fromValue: null,
      toValue: caseId,
      ...(input.reason !== undefined && input.reason.trim() !== '' ? { detail: input.reason.trim() } : {}),
    });
    await this.dispatch('voiceCommunications.conversation.caseLinked', conversation.id, { caseId });
    return { caseId, duplicate: false };
  }

  // ------------------------------------------------------------------------- internals

  private async requireConversation(id: string): Promise<InboxConversationRow> {
    const row = (
      await sql<InboxConversationRow>`select * from voice_conversations where id = ${id}`.execute(this.database.db)
    ).rows[0];
    if (row === undefined) throw new NotFoundError(`Conversation "${id}" does not exist.`);
    return row;
  }

  private async recordEvent(input: {
    readonly conversationId: string;
    readonly kind: string;
    readonly actorType: 'user' | 'system';
    readonly fromValue: string | null;
    readonly toValue: string | null;
    readonly detail?: string | undefined;
  }): Promise<void> {
    await sql`
      insert into voice_conversation_events
        (id, conversation_id, kind, actor_user_id, actor_type, from_value, to_value, detail, created_at)
      values
        (${randomUUID()}, ${input.conversationId}, ${input.kind}, ${this.scope.userId ?? null},
         ${input.actorType}, ${input.fromValue}, ${input.toValue}, ${input.detail ?? null}, now())
    `.execute(this.database.db);
  }

  /** A permitted activity signal: ids and verbs only, never message bodies (§10.5). */
  private async dispatch(type: string, conversationId: string, extra: Record<string, unknown>): Promise<void> {
    await this.events.dispatch(this.database.db, {
      type: type as never,
      payload: { conversationId, actorUserId: this.scope.userId ?? null, ...extra },
    });
  }
}

export interface InboxConversationRow {
  id: string;
  account_key: string;
  channel: string;
  status: string;
  subject: string | null;
  external_thread_id: string | null;
  unread_count: number;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  last_activity_at: Date | null;
  last_inbound_at: Date | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  case_id: string | null;
  archived: boolean;
}

export { CONVERSATION_STATUSES };
export type { ConversationStatus };

function toInboxView(row: InboxConversationRow): InboxConversationView {
  return {
    id: row.id,
    accountKey: row.account_key,
    channel: row.channel,
    status: row.status,
    subject: row.subject,
    externalThreadId: row.external_thread_id,
    unreadCount: row.unread_count,
    assignedUserId: row.assigned_user_id,
    assignedTeamId: row.assigned_team_id,
    lastActivityAt: iso(row.last_activity_at),
    lastInboundAt: iso(row.last_inbound_at),
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    caseId: row.case_id,
    archived: row.archived,
  };
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
