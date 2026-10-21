import { randomUUID } from 'node:crypto';

import { NotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { CRMChatFeedbackTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatPolicyService } from './crm-chat-policy.service.js';

/**
 * Phase 19-CHAT.14 — answer feedback (PLAN_Phase_19_CRM_Chat.md §7.6, §17 `19-CHAT.14`;
 * contract §6.3, §7.6).
 *
 * A rating is a fact about one answer, recorded once per user per answer. It is **auditable and
 * inert**: nothing here reads a rating back into model behaviour, tool selection, permissions or a
 * prompt. The table is a log; the plan explicitly forbids a feedback loop that changes production
 * model behaviour, and no code path does that.
 *
 * The turn id is the AIAgents run id (Chat reuses the run as its turn id), so the answer being rated
 * is found through the assistant message that run produced. Ownership is checked twice:
 *
 *  1. the message must belong to a conversation the caller owns, and
 *  2. the row is keyed by `(message_id, owner_user_id)`, so one person cannot rate on behalf of
 *     another and a second submission updates the first instead of adding a second vote.
 *
 * A turn that never produced an assistant message is a `404`: there is no answer to rate, and
 * inventing a rating target would silently accept votes for nothing.
 */
export interface CRMChatFeedbackInput {
  readonly rating: 'up' | 'down';
  readonly category?: string | undefined;
  readonly comment?: string | undefined;
}

export interface CRMChatFeedbackView {
  readonly id: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly rating: 'up' | 'down';
  readonly category: string | null;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

@Injectable()
export class CRMChatFeedbackService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CRMChatPermissionService) private readonly permissions: CRMChatPermissionService,
    @Inject(CRMChatPolicyService) private readonly policy: CRMChatPolicyService,
  ) {}

  /**
   * Record or update the caller's rating of the answer produced by `turnId`.
   */
  async submit(turnId: string, input: CRMChatFeedbackInput): Promise<{ status: true; feedback: CRMChatFeedbackView }> {
    await this.permissions.assert('feedback');
    await this.policy.assertFeature('feedback');
    const userId = this.requireUserId();

    const message = await this.answerMessage(turnId);
    const category = input.category === undefined ? null : input.category.trim();
    const comment = input.comment === undefined ? null : input.comment.trim();

    const now = new Date();
    const existing = await this.database.db
      .selectFrom('crm_chat_feedback')
      .selectAll()
      .where('message_id', '=', message.id)
      .where('owner_user_id', '=', userId)
      .executeTakeFirst();

    if (existing) {
      // A second submission is an update, not a second vote.
      await this.database.db
        .updateTable('crm_chat_feedback')
        .set({ rating: input.rating, category, comment, modified_at: now })
        .where('id', '=', existing.id)
        .where('owner_user_id', '=', userId)
        .execute();
      return {
        status: true,
        feedback: this.toView({ ...existing, rating: input.rating, category, comment, modified_at: now }),
      };
    }

    const row: CRMChatFeedbackTable = {
      id: randomUUID(),
      message_id: message.id,
      conversation_id: message.conversation_id,
      owner_user_id: userId,
      rating: input.rating,
      category,
      comment,
      created_at: now,
      modified_at: now,
    };

    try {
      await this.database.db.insertInto('crm_chat_feedback').values(row).execute();
    } catch (error) {
      // Two concurrent submissions race on `uq_crm_chat_feedback_message_owner_key`. The loser
      // updates instead of failing: the caller asked to rate an answer, and the answer is rated.
      if (isUniqueViolation(error)) {
        await this.database.db
          .updateTable('crm_chat_feedback')
          .set({ rating: input.rating, category, comment, modified_at: now })
          .where('message_id', '=', message.id)
          .where('owner_user_id', '=', userId)
          .execute();
        const stored = await this.database.db
          .selectFrom('crm_chat_feedback')
          .selectAll()
          .where('message_id', '=', message.id)
          .where('owner_user_id', '=', userId)
          .executeTakeFirst();
        if (!stored) throw new NotFoundError('The feedback could not be recorded.');
        return { status: true, feedback: this.toView(stored) };
      }
      throw error;
    }

    return { status: true, feedback: this.toView(row) };
  }

  /** The caller's own ratings for one answer, or an empty list. */
  async listForTurn(turnId: string): Promise<{ list: CRMChatFeedbackView[]; count: number }> {
    await this.permissions.assert('use');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();

    const message = await this.answerMessage(turnId);
    const rows = await this.database.db
      .selectFrom('crm_chat_feedback')
      .selectAll()
      .where('message_id', '=', message.id)
      .where('owner_user_id', '=', userId)
      .execute();

    return { list: rows.map((row) => this.toView(row)), count: rows.length };
  }

  /**
   * The assistant message produced by a turn. A turn that has not produced an answer yet has
   * nothing to rate.
   */
  private async answerMessage(turnId: string): Promise<{ id: string; conversation_id: string }> {
    if (typeof turnId !== 'string' || turnId.trim() === '') {
      throw new NotFoundError('Turn not found.');
    }
    const userId = this.requireUserId();

    const row = await this.database.db
      .selectFrom('ai_agent_messages')
      .innerJoin('ai_agent_conversations', 'ai_agent_conversations.id', 'ai_agent_messages.conversation_id')
      .select(['ai_agent_messages.id', 'ai_agent_messages.conversation_id'])
      .where('ai_agent_messages.run_id', '=', turnId)
      .where('ai_agent_messages.role', '=', 'assistant')
      .where('ai_agent_conversations.owner_user_id', '=', userId)
      .where('ai_agent_conversations.status', '<>', 'deleted')
      .executeTakeFirst();

    if (!row) throw new NotFoundError(`Turn "${turnId}" does not exist.`);
    return row;
  }

  private requireUserId(): string {
    const id = this.scope.userId;
    if (id === undefined) throw new NotFoundError('No authenticated user for this feedback request.');
    return id;
  }

  private toView(row: CRMChatFeedbackTable): CRMChatFeedbackView {
    const rating: CRMChatFeedbackView['rating'] = row.rating === 'down' ? 'down' : 'up';
    return {
      id: row.id,
      messageId: row.message_id,
      conversationId: row.conversation_id,
      rating,
      category: row.category,
      comment: row.comment,
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }
}

/** Postgres unique violation (`23505`). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
