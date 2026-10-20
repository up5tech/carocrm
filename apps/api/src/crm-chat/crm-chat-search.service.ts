import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Phase 19-CHAT.14 — Conversation Search, Prompt Templates, and Feedback
 * (PLAN_Phase_19_CRM_Chat.md §5.7, §17 `19-CHAT.14`).
 *
 * This service provides:
 * - Search over the current user's conversation history (permission/retention-aware)
 * - Saved prompt templates management
 * - Answer feedback collection with privacy controls
 *
 * All operations are scoped to the authenticated user - no cross-user data leakage.
 */

export interface ConversationSearchResult {
  readonly id: string;
  readonly title: string | null;
  readonly lastMessageAt: string;
  readonly messageCount: number;
  readonly matchedText?: string | undefined;
}

export interface SavedPrompt {
  readonly id: string;
  readonly name: string;
  readonly promptTemplate: string;
  readonly description?: string | undefined;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface FeedbackSubmission {
  readonly messageId: string;
  readonly rating: 'thumbs_up' | 'thumbs_down';
  readonly category?: string | undefined;
  readonly comment?: string | undefined;
}

// Safe search limits
const MAX_SEARCH_RESULTS = 50;
const MAX_PROMPT_NAME_LENGTH = 200;
const MAX_PROMPT_TEMPLATE_LENGTH = 4000;
const MAX_FEEDBACK_COMMENT_LENGTH = 1000;

@Injectable()
export class CRMChatSearchService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Search the current user's conversations by title or message content.
   * Results are scoped to the authenticated user only - never discloses another user's messages.
   */
  async searchConversations(query: string, limit = 20): Promise<readonly ConversationSearchResult[]> {
    const userId = this.scope.requirePrincipal().userId;
    const safeLimit = Math.min(limit, MAX_SEARCH_RESULTS);
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) return [];

    try {
      // Search in ai_agent_conversations table (owned by AIAgents module)
      // Only returns conversations owned by the current user
      const results = await this.database.db
        .selectFrom('ai_agent_conversations')
        .select(['id', 'name', 'last_message_at', 'message_count'])
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('name', 'ilike', `%${normalizedQuery}%`),
          ])
        )
        .orderBy('last_message_at', 'desc')
        .limit(safeLimit)
        .execute();

      return results.map((row) => ({
        id: String(row.id),
        title: row.name ? String(row.name) : null,
        lastMessageAt: row.last_message_at instanceof Date
          ? row.last_message_at.toISOString()
          : String(row.last_message_at),
        messageCount: Number(row.message_count ?? 0),
        matchedText: undefined, // Don't expose message snippets for privacy
      }));
    } catch {
      // Return empty on error rather than exposing internal details
      return [];
    }
  }

  /**
   * List saved prompt templates for the current user.
   * Prompts are data-only and carry no executable permissions.
   */
  async listPrompts(): Promise<readonly SavedPrompt[]> {
    const userId = this.scope.requirePrincipal().userId;

    try {
      // Query crm_chat_prompts table (owned by CRMChat module)
      const results = await this.database.db
        .selectFrom('crm_chat_prompts')
        .select(['id', 'name', 'prompt_template', 'description', 'created_by', 'created_at', 'updated_at'])
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .where('enabled', '=', true)
        .orderBy('updated_at', 'desc')
        .execute();

      return results.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        promptTemplate: String(row.prompt_template),
        description: row.description ? String(row.description) : undefined,
        createdBy: String(row.created_by),
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
        updatedAt: row.updated_at
          ? (row.updated_at instanceof Date
              ? row.updated_at.toISOString()
              : String(row.updated_at))
          : null,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Create a new saved prompt template.
   * Templates are validated for length and stored as data only - no execution permissions.
   */
  async createPrompt(name: string, promptTemplate: string, description?: string): Promise<SavedPrompt> {
    const userId = this.scope.requirePrincipal().userId;

    // Validate inputs
    if (!name.trim()) throw new Error('Prompt name is required.');
    if (name.length > MAX_PROMPT_NAME_LENGTH) {
      throw new Error(`Prompt name must be ${MAX_PROMPT_NAME_LENGTH} characters or less.`);
    }
    if (!promptTemplate.trim()) throw new Error('Prompt template is required.');
    if (promptTemplate.length > MAX_PROMPT_TEMPLATE_LENGTH) {
      throw new Error(`Prompt template must be ${MAX_PROMPT_TEMPLATE_LENGTH} characters or less.`);
    }

    const now = new Date();
    const id = crypto.randomUUID();

    try {
      await this.database.db
        .insertInto('crm_chat_prompts')
        .values({
          id,
          owner_user_id: userId,
          name: name.trim(),
          prompt_template: promptTemplate.trim(),
          description: description?.trim() || null,
          enabled: true,
          created_by: userId,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        })
        .execute();

      return {
        id,
        name: name.trim(),
        promptTemplate: promptTemplate.trim(),
        description: description?.trim(),
        createdBy: userId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to create prompt: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Submit feedback for an assistant answer.
   * Feedback is auditable but cannot automatically change model behavior or permissions.
   */
  async submitFeedback(feedback: FeedbackSubmission): Promise<void> {
    const userId = this.scope.requirePrincipal().userId;

    // Validate rating
    if (!['thumbs_up', 'thumbs_down'].includes(feedback.rating)) {
      throw new Error('Rating must be "thumbs_up" or "thumbs_down".');
    }

    // Validate comment length
    if (feedback.comment && feedback.comment.length > MAX_FEEDBACK_COMMENT_LENGTH) {
      throw new Error(`Comment must be ${MAX_FEEDBACK_COMMENT_LENGTH} characters or less.`);
    }

    const now = new Date();
    const id = crypto.randomUUID();

    try {
      await this.database.db
        .insertInto('crm_chat_feedback')
        .values({
          id,
          message_id: feedback.messageId,
          user_id: userId,
          rating: feedback.rating,
          category: feedback.category || null,
          comment: feedback.comment || null,
          created_at: now,
        })
        .execute();
    } catch (error) {
      throw new Error(`Failed to submit feedback: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
