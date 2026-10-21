import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AIAgentConversationsTable, AIAgentMessagesTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CRMChatCitationService, type CRMChatCitationView } from './crm-chat-citations.service.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatPolicyService } from './crm-chat-policy.service.js';

/**
 * Phase 19-CHAT.4 — conversation and message APIs
 * (PLAN_Phase_19_CRM_Chat.md §6.2, §7.4, §17 `19-CHAT.4`; contract §6.2, §7.6).
 *
 * ## Why this service reads the AI Agents tables directly
 *
 * Contract decision D1: a conversation and its messages live in `ai_agent_conversations` /
 * `ai_agent_messages`, and there is **no** `crm_chat_*` copy. Those tables have one writer during a run
 * — `AIAgentMemoryService` — and this service never appends a message, allocates a `seq` or summarises.
 * What it owns is the *user-facing lifecycle*: listing, reading a page of history, and the three fields
 * a person may change (title, status, deletion marker). That split is the whole point: the runtime
 * stays the only thing that can add a turn, so message order and idempotency keep exactly one owner.
 *
 * ## The invariants every query repeats
 *
 *  1. **Owner first.** The owner predicate is part of the SQL, not a check after the row is loaded, so
 *     a guessed id returns `404` — identical to an id that never existed. Chat has no admin read.
 *  2. **Deleted is invisible.** `status = 'deleted'` is filtered out of every read and every mutation
 *     target. Deletion is a marker, not a hard delete: the AI Agents retention sweep is the only
 *     executor that removes rows, so a support investigation and a user's "delete this" both work.
 *  3. **No client-supplied owner.** The caller comes from the request scope; no DTO has a user field.
 *
 * Record-level and field-level CRM permissions are not this service's business: a conversation is
 * private to its owner, and the records it cites are re-checked by their own modules.
 */

export type CRMChatConversationStatus = 'active' | 'archived';

export interface CRMChatConversationView {
  readonly id: string;
  readonly title: string | null;
  readonly agentId: string;
  readonly agentName: string;
  readonly status: CRMChatConversationStatus;
  readonly messageCount: number;
  /** `last_activity_at` from the shared store — the sort key of the sidebar. */
  readonly lastMessageAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface CRMChatMessageView {
  readonly id: string;
  readonly sequence: number;
  readonly role: 'user' | 'assistant' | 'system';
  /** Plain text only (contract D11). A `summary`/`hashed` row is already redacted at rest. */
  readonly content: string;
  readonly contentFormat: 'plain';
  readonly redaction: 'none' | 'summary' | 'hashed';
  readonly turnId: string | null;
  /** The citations of this answer, materialised from an ACL re-read (19-CHAT.8). */
  readonly citations: readonly CRMChatCitationView[];
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface CRMChatMessagePage {
  readonly list: readonly CRMChatMessageView[];
  /** Pass as `before` to fetch the next (older) page; `null` when this is the oldest page. */
  readonly nextBefore: number | null;
  readonly hasMore: boolean;
}

export interface CRMChatConversationListQuery {
  readonly status?: 'active' | 'archived' | 'all' | undefined;
  readonly offset?: number | undefined;
  readonly maxSize?: number | undefined;
  /** 19-CHAT.14 — free-text search over the caller's own threads. */
  readonly q?: string | undefined;
}

export interface CRMChatMessageListQuery {
  readonly before?: number | undefined;
  readonly maxSize?: number | undefined;
}

export interface CRMChatConversationPatch {
  readonly title?: string | undefined;
  readonly status?: CRMChatConversationStatus | undefined;
}

const DEFAULT_PAGE = 25;
const MAX_PAGE = 50;
const DEFAULT_MESSAGE_PAGE = 30;
const MAX_MESSAGE_PAGE = 100;
const MAX_TITLE = 200;

@Injectable()
export class CRMChatConversationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CRMChatPermissionService) private readonly permissions: CRMChatPermissionService,
    @Inject(CRMChatPolicyService) private readonly policy: CRMChatPolicyService,
    @Inject(CRMChatCitationService) private readonly citations: CRMChatCitationService,
  ) {}

  /** The caller's own threads, newest activity first. Deleted threads never appear. */
  async list(query: CRMChatConversationListQuery = {}): Promise<{
    list: CRMChatConversationView[];
    total: number;
    offset: number;
    count: number;
  }> {
    await this.permissions.assert('use');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();
    const offset = Math.max(0, query.offset ?? 0);
    const maxSize = Math.min(MAX_PAGE, Math.max(1, query.maxSize ?? DEFAULT_PAGE));
    const status = query.status ?? 'active';

    let builder = this.database.db
      .selectFrom('ai_agent_conversations')
      .where('owner_user_id', '=', userId)
      .where('status', '<>', 'deleted');
    if (status !== 'all') builder = builder.where('status', '=', status);

    // 19-CHAT.14 — free-text search over the caller's own threads. The owner predicate is already
    // part of the builder, so the term can only ever match this caller's rows. The match covers
    // the thread title and the body of any message in it.
    const term = query.q?.trim();
    if (term !== undefined && term !== '') {
      await this.policy.assertFeature('conversationSearch');
      const pattern = likePattern(term);
      builder = builder.where((eb) =>
        eb.or([
          eb('title', 'ilike', pattern),
          eb.exists(
            eb
              .selectFrom('ai_agent_messages')
              .select('id')
              .whereRef('ai_agent_messages.conversation_id', '=', 'ai_agent_conversations.id')
              .where('ai_agent_messages.content', 'ilike', pattern),
          ),
        ]),
      );
    }

    const totalRow = await builder.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
    const rows = await builder
      .selectAll()
      // `id` breaks a same-millisecond tie, so an offset page cannot repeat or skip a row.
      .orderBy('last_activity_at', 'desc')
      .orderBy('id', 'desc')
      .offset(offset)
      .limit(maxSize)
      .execute();
    const names = await this.agentNames(rows.map((row) => row.agent_id));

    return {
      list: rows.map((row) => this.toConversationView(row, names.get(row.agent_id) ?? '')),
      total: Number(totalRow?.count ?? 0),
      offset,
      count: rows.length,
    };
  }

  /** One owned thread plus the newest page of its history. */
  async get(id: string): Promise<{ conversation: CRMChatConversationView; messages: CRMChatMessagePage }> {
    await this.permissions.assert('use');
    await this.policy.assertWorkspace();
    const row = await this.ownerConversation(id);
    const names = await this.agentNames([row.agent_id]);
    return {
      conversation: this.toConversationView(row, names.get(row.agent_id) ?? ''),
      messages: await this.messages(id, {}),
    };
  }

  /**
   * Keyset pagination by `seq`. The cursor is the oldest sequence already shown, so a message inserted
   * concurrently behind the cursor cannot shift a page, and one inserted in front of it appears on the
   * next refresh instead of duplicating a row.
   */
  async messages(id: string, query: CRMChatMessageListQuery = {}): Promise<CRMChatMessagePage> {
    await this.permissions.assert('use');
    await this.policy.assertWorkspace();
    const row = await this.ownerConversation(id);
    const maxSize = Math.min(MAX_MESSAGE_PAGE, Math.max(1, query.maxSize ?? DEFAULT_MESSAGE_PAGE));
    if (query.before !== undefined && (!Number.isInteger(query.before) || query.before < 1)) {
      throw new ValidationError('`before` must be a positive message sequence.', { before: query.before });
    }

    let builder = this.database.db
      .selectFrom('ai_agent_messages')
      .selectAll()
      .where('conversation_id', '=', row.id);
    if (query.before !== undefined) builder = builder.where('seq', '<', query.before);

    const rows = await builder
      .orderBy('seq', 'desc')
      .limit(maxSize + 1)
      .execute();
    const hasMore = rows.length > maxSize;
    const page = rows.slice(0, maxSize).reverse();
    const list = await Promise.all(page.map((message) => this.toMessageView(message)));
    return {
      list,
      nextBefore: hasMore && list.length > 0 ? Number(list[0]?.sequence ?? 0) : null,
      hasMore,
    };
  }

  /**
   * Rename and/or archive. An archived thread is read-only for turns (enforced at submission), and
   * unarchiving is offered deliberately: a one-way archive turns a misclick into a lost thread.
   */
  async patch(id: string, patch: CRMChatConversationPatch): Promise<CRMChatConversationView> {
    await this.permissions.assert('manage');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();
    const row = await this.ownerConversation(id);

    const update: { title?: string; status?: string; modified_at: Date } = { modified_at: new Date() };
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === '') {
        throw new ValidationError('A conversation title cannot be empty.', { field: 'title' });
      }
      if (title.length > MAX_TITLE) {
        throw new ValidationError(`A conversation title cannot exceed ${String(MAX_TITLE)} characters.`, {
          field: 'title',
          max: MAX_TITLE,
        });
      }
      update.title = title;
    }
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'archived') {
        throw new ValidationError('A conversation status must be "active" or "archived".', { field: 'status' });
      }
      update.status = patch.status;
    }
    if (patch.title === undefined && patch.status === undefined) {
      // An empty patch is a read. Returning the current view is honest and avoids a pointless write.
      const names = await this.agentNames([row.agent_id]);
      return this.toConversationView(row, names.get(row.agent_id) ?? '');
    }

    await this.database.db
      .updateTable('ai_agent_conversations')
      .set(update)
      .where('id', '=', row.id)
      .where('owner_user_id', '=', userId)
      .where('status', '<>', 'deleted')
      .execute();

    const updated = await this.ownerConversation(id);
    const names = await this.agentNames([updated.agent_id]);
    return this.toConversationView(updated, names.get(updated.agent_id) ?? '');
  }

  /**
   * Mark the thread deleted. Messages, citations and feedback stay until the AI Agents retention sweep
   * removes the conversation (and therefore cascades them), because a technician needs the thread while
   * it is still inside the retention window. From this call onward it is a `404` for its owner.
   */
  async remove(id: string): Promise<{ status: true }> {
    await this.permissions.assert('delete');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();
    const row = await this.ownerConversation(id);

    await this.database.db
      .updateTable('ai_agent_conversations')
      .set({ status: 'deleted', modified_at: new Date() })
      .where('id', '=', row.id)
      .where('owner_user_id', '=', userId)
      .where('status', '<>', 'deleted')
      .execute();
    return { status: true };
  }

  /** Owner-scoped lookup used by every route: a miss is `404`, never `403`. */
  private async ownerConversation(id: string): Promise<AIAgentConversationsTable> {
    const userId = this.requireUserId();
    if (typeof id !== 'string' || id.trim() === '') {
      throw new NotFoundError('Conversation not found.');
    }
    const row = await this.database.db
      .selectFrom('ai_agent_conversations')
      .selectAll()
      .where('id', '=', id)
      .where('owner_user_id', '=', userId)
      .where('status', '<>', 'deleted')
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`Conversation "${id}" does not exist.`);
    return row;
  }

  private requireUserId(): string {
    const id = this.scope.userId;
    if (id === undefined) throw new NotFoundError('No authenticated user for this conversation request.');
    return id;
  }

  private async agentNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.database.db.selectFrom('ai_agents').select(['id', 'name']).where('id', 'in', unique).execute();
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private toConversationView(row: AIAgentConversationsTable, agentName: string): CRMChatConversationView {
    return {
      id: row.id,
      title: row.title,
      agentId: row.agent_id,
      agentName,
      // The store also holds `deleted`; every read above already excluded it.
      status: row.status === 'archived' ? 'archived' : 'active',
      messageCount: row.message_count,
      lastMessageAt: row.last_activity_at.toISOString(),
      expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    };
  }

  private async toMessageView(row: AIAgentMessagesTable): Promise<CRMChatMessageView> {
    const role: CRMChatMessageView['role'] =
      row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : 'system';
    const redaction: CRMChatMessageView['redaction'] =
      row.redaction === 'summary' || row.redaction === 'hashed' ? row.redaction : 'none';
    return {
      id: row.id,
      sequence: Number(row.seq),
      role,
      content: row.content,
      contentFormat: 'plain',
      redaction,
      turnId: row.run_id,
      citations: await this.citations.forMessage(row),
      createdAt: row.created_at.toISOString(),
      completedAt: null,
    };
  }
}

/**
 * Escape the LIKE wildcards in a search term so a user-supplied `%` or `_` matches literally
 * instead of widening the search. Postgres uses the backslash as the default LIKE escape
 * character.
 */
function likePattern(term: string): string {
  return `%${term.replace(/([\\%_])/g, '\\$1')}%`;
}
